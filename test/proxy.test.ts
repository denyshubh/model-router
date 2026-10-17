import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveProxyConfig } from '../src/proxy/config'
import { startProxy } from '../src/proxy/server'

type Seen = { path: string; body: Record<string, unknown>; headers: Record<string, string> }

const seen: Seen[] = []
const logDir = mkdtempSync(join(tmpdir(), 'model-router-'))

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1","model":"x","usage":{"input_tokens":12,"cache_read_input_tokens":0,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
  '',
  '',
].join('\n')

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, unknown>

    seen.push({ path: new URL(req.url).pathname, body, headers: Object.fromEntries(req.headers) })

    if (body.stream) {
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    }

    return Response.json({ id: 'x', model: body.model, usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [{ message: { content: 'hi' } }] })
  },
})

const config = resolveProxyConfig(
  {
    port: 0,
    log: { mode: 'full', dir: logDir },
    routers: [
      {
        alias: 'claude-auto',
        protocol: 'anthropic',
        upstream: { baseUrl: `http://127.0.0.1:${upstream.port}`, apiKeyEnv: 'MR_TEST_KEY' },
        tiers: {
          simple: { model: 'claude-haiku-4-5', supportsEffort: false, thinking: 'budget' },
          complex: { model: 'claude-opus-5-5', effort: 'medium' },
        },
      },
      {
        alias: 'auto',
        protocol: 'openai',
        upstream: { baseUrl: `http://127.0.0.1:${upstream.port}/v1` },
        tiers: { simple: { model: 'small', effort: 'low' }, reasoning: { model: 'big', effort: 'high' } },
      },
    ],
  },
  '/nonexistent',
)
let proxy: ReturnType<typeof startProxy>
let base = ''

beforeAll(() => {
  process.env.MR_TEST_KEY = 'sk-test'
  proxy = startProxy(config)
  base = `http://127.0.0.1:${proxy.port}`
})

afterAll(() => {
  proxy.stop(true)
  upstream.stop(true)
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('an Anthropic request for the alias is rewritten for the picked model and streamed back', async () => {
  const res = await post(
    '/v1/messages',
    {
      model: 'claude-auto',
      max_tokens: 8000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is a mutex?' }] }],
    },
    { authorization: 'Bearer client-token', 'x-claude-code-session-id': 'sess-1' },
  )
  const text = await res.text()
  const sent = seen.at(-1)!

  expect(res.status).toBe(200)
  expect(text).toContain('hello')
  expect(res.headers.get('x-model-router-tier')).toBe('simple')
  expect(sent.path).toBe('/v1/messages')
  expect(sent.body.model).toBe('claude-haiku-4-5')
  // Haiku takes no effort and budgeted thinking.
  expect(sent.body.output_config).toBeUndefined()
  expect(sent.body.thinking).toEqual({ type: 'enabled', budget_tokens: 6976 })
  // The configured key replaces the client's auth.
  expect(sent.headers['x-api-key']).toBe('sk-test')
  expect(sent.headers.authorization).toBeUndefined()
})

test('another model id passes through untouched', async () => {
  await post('/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })

  expect(seen.at(-1)!.body.model).toBe('claude-sonnet-5-5')
})

test('an OpenAI chat request routes and sets reasoning_effort', async () => {
  const res = await post('/chat/completions', {
    model: 'auto',
    messages: [
      { role: 'system', content: 'You are Copilot.' },
      { role: 'user', content: 'Think through the trade-offs step by step and analyze the design of our cache invalidation' },
    ],
  })

  expect(res.status).toBe(200)
  expect(seen.at(-1)).toMatchObject({ path: '/v1/chat/completions', body: { model: 'big', reasoning_effort: 'high' } })
})

test('tool-result steps of the same conversation keep the decision', async () => {
  await post('/chat/completions', {
    model: 'auto',
    messages: [
      { role: 'user', content: 'Think through the trade-offs step by step and analyze the design of our cache invalidation' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file contents' },
    ],
  })

  expect(seen.at(-1)!.body.model).toBe('big')
})

test('models lists the aliases, and every routed request is logged with usage', async () => {
  const models = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] }

  expect(models.data.map(m => m.id)).toEqual(['claude-auto', 'auto'])

  await Bun.sleep(50)

  const rows = readdirSync(logDir).flatMap(f => readFileSync(join(logDir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l))

  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatchObject({ router: 'claude-auto', tier: 'simple', ask: 'what is a mutex?', outcome: { status: 200, usage: { input_tokens: 12, output_tokens: 7 } } })
  expect(rows[2]).toMatchObject({ router: 'auto', cause: 'continuation' })
})
