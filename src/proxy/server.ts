import { appendFile, mkdir } from 'node:fs/promises'

import { type Decision, type Io, type Outcome, Router, Timeout, describe, toRecord } from '../core'
import { type AnthropicBody, applyAnthropic, fromAnthropic, usageFromAnthropic } from '../wire/anthropic'
import {
  type ChatBody,
  type ResponsesBody,
  applyChat,
  applyResponses,
  fromChat,
  fromResponses,
  usageFromOpenAI,
} from '../wire/openai'
import type { Protocol, ProxyConfig, RouterEntry, Upstream } from './config'

export const bunIo: Io = {
  now: async () => Date.now(),
  random: () => Math.random(),
  env: async name => process.env[name],
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  async fetch(url, init) {
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
      })

      return { ok: res.ok, status: res.status, text: await res.text() }
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Timeout(`timed out after ${init.timeoutMs}ms`)
      }

      throw err
    }
  },
}

type Kind = 'messages' | 'count_tokens' | 'chat' | 'responses'

const DROP_REQUEST = ['host', 'content-length', 'connection', 'accept-encoding']
const DROP_RESPONSE = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']

/** Paths with or without `/v1`, since SDKs differ on whether the base carries it. */
const kindOf = (path: string): Kind | undefined => {
  const p = path.replace(/^\/v1/, '')

  return p === '/messages'
    ? 'messages'
    : p === '/messages/count_tokens'
      ? 'count_tokens'
      : p === '/chat/completions'
        ? 'chat'
        : p === '/responses'
          ? 'responses'
          : undefined
}

const protocolOf = (kind: Kind): Protocol =>
  kind === 'messages' || kind === 'count_tokens' ? 'anthropic' : 'openai'

const upstreamUrl = (u: Upstream, protocol: Protocol, path: string, search: string) => {
  const rest = path.replace(/^\/v1/, '')
  const base = u.baseUrl.replace(/\/$/, '')

  return `${base}${protocol === 'anthropic' ? '/v1' : ''}${rest}${search}`
}

const upstreamHeaders = async (incoming: Headers, u: Upstream, protocol: Protocol) => {
  const headers = new Headers(incoming)

  for (const h of DROP_REQUEST) {
    headers.delete(h)
  }

  const key = u.apiKeyEnv ? process.env[u.apiKeyEnv] : undefined

  if (key) {
    if (protocol === 'anthropic') {
      headers.delete('authorization')
      headers.set('x-api-key', key)
    } else {
      headers.set('authorization', `Bearer ${key}`)
    }
  }

  return headers
}

/** Keeps only SSE lines that mention usage, so a long stream is not held in memory. */
const collectUsageLines = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  let partial = ''
  let kept = ''

  for await (const chunk of stream) {
    const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n')

    partial = lines.pop() ?? ''

    for (const line of lines) {
      if (line.includes('usage')) {
        kept += `${line}\n`
      }
    }
  }

  return partial.includes('usage') ? kept + partial : kept
}

export const startProxy = (config: ProxyConfig, io: Io = bunIo) => {
  const routers = new Map<string, { entry: RouterEntry; router: Router }>(
    config.routers.map(entry => [entry.alias, { entry, router: new Router(entry.config, io) }]),
  )
  const passthrough = (protocol: Protocol): Upstream | undefined =>
    config.passthrough[protocol] ?? config.routers.find(r => r.protocol === protocol)?.upstream
  let logReady: Promise<unknown> | undefined

  const log = async (line: string) => {
    if (config.log.mode === 'off') {
      return
    }

    try {
      logReady ??= mkdir(config.log.dir, { recursive: true })
      await logReady
      await appendFile(`${config.log.dir}/${new Date().toISOString().slice(0, 10)}.jsonl`, line)
    } catch (err) {
      console.error('model-router: decision log not written:', err)
    }
  }

  const record = (alias: string, requestedModel: string, d: Decision, outcome: Outcome) =>
    log(
      `${JSON.stringify(
        toRecord(d, { at: new Date().toISOString(), host: 'proxy', router: alias, requestedModel, mode: config.log.mode }, outcome),
      )}\n`,
    )

  const models = () => ({
    object: 'list',
    data: config.routers.map(r => ({
      id: r.alias,
      object: 'model',
      type: 'model',
      display_name: `${r.alias} (routed)`,
      created_at: '2026-01-01T00:00:00Z',
      owned_by: 'model-router',
    })),
    has_more: false,
  })

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, routers: [...routers.keys()] })
    }

    if (req.method === 'GET' && /^(\/v1)?\/models$/.test(url.pathname)) {
      return Response.json(models())
    }

    const kind = req.method === 'POST' ? kindOf(url.pathname) : undefined
    const protocolGuess: Protocol = url.pathname.includes('/messages') || req.headers.has('anthropic-version') ? 'anthropic' : 'openai'

    if (kind === undefined) {
      const u = passthrough(protocolGuess)

      if (u === undefined) {
        return Response.json({ error: { message: `no upstream for ${url.pathname}` } }, { status: 404 })
      }

      return forward(req, u, protocolGuess, url, req.body)
    }

    const protocol = protocolOf(kind)
    const raw = await req.text()
    let body: { model?: string; stream?: boolean } & Record<string, unknown>

    try {
      body = JSON.parse(raw)
    } catch {
      return Response.json({ error: { message: 'body is not JSON' } }, { status: 400 })
    }

    const hit = typeof body.model === 'string' ? routers.get(body.model) : undefined

    if (hit === undefined || hit.entry.protocol !== protocol) {
      const u = passthrough(protocol)

      return u === undefined
        ? Response.json({ error: { message: `unknown model "${body.model}"` } }, { status: 404 })
        : forward(req, u, protocol, url, raw)
    }

    const { entry, router } = hit
    const requestedModel = body.model as string

    // Token counting is not a turn: count against the default tier's model.
    if (kind === 'count_tokens') {
      const fallback = router.config.tiers[router.config.defaultTier] ?? Object.values(router.config.tiers)[0]
      const model = Array.isArray(fallback) ? fallback[0]?.model : fallback?.model

      return forward(req, entry.upstream, protocol, url, JSON.stringify({ ...body, model }))
    }

    const routeReq =
      kind === 'messages'
        ? fromAnthropic(body as AnthropicBody, req.headers)
        : kind === 'chat'
          ? fromChat(body as ChatBody, req.headers)
          : fromResponses(body as ResponsesBody, req.headers)
    const decision = await router.route(routeReq)

    if (decision === undefined) {
      return forward(req, entry.upstream, protocol, url, raw)
    }

    const routed =
      kind === 'messages'
        ? applyAnthropic(body as AnthropicBody, decision)
        : kind === 'chat'
          ? applyChat(body as ChatBody, decision)
          : applyResponses(body as ResponsesBody, decision)

    if (decision.cause !== 'continuation') {
      console.log(`model-router [${entry.alias}] ${describe(decision)}`)
    }

    const startedAt = Date.now()
    const res = await forward(req, entry.upstream, protocol, url, JSON.stringify(routed), decision)
    const usageOf = protocol === 'anthropic' ? usageFromAnthropic : usageFromOpenAI
    const finish = (text: string) =>
      record(entry.alias, requestedModel, decision, {
        status: res.status,
        durationMs: Date.now() - startedAt,
        usage: usageOf(text) ?? null,
      })

    if (res.body === null) {
      void finish('')

      return res
    }

    const [client, mine] = res.body.tee()

    void collectUsageLines(mine)
      .then(finish)
      .catch(() => finish(''))

    return new Response(client, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  const forward = async (
    req: Request,
    u: Upstream,
    protocol: Protocol,
    url: URL,
    body: BodyInit | null,
    decision?: Decision,
  ): Promise<Response> => {
    try {
      const res = await fetch(upstreamUrl(u, protocol, url.pathname, url.search), {
        method: req.method,
        headers: await upstreamHeaders(req.headers, u, protocol),
        body,
        signal: req.signal,
      })
      const headers = new Headers(res.headers)

      for (const h of DROP_RESPONSE) {
        headers.delete(h)
      }

      if (decision !== undefined) {
        headers.set('x-model-router-tier', decision.tier)
        headers.set('x-model-router-model', decision.target.model)
        headers.set('x-model-router-cause', decision.cause)
      }

      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch (err) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: `model-router: upstream unreachable: ${String(err)}` } },
        { status: 502 },
      )
    }
  }

  return Bun.serve({
    hostname: config.host,
    port: config.port,
    // Thinking can go quiet for minutes mid-stream; Bun's default would cut it at 10s.
    idleTimeout: 255,
    fetch: handle,
  })
}
