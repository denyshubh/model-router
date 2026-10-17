import type { Decision, RouteRequest, Turn } from '../core'

type Part = { type: string; text?: string }

/** Chat Completions (`/chat/completions`). */
export type ChatBody = {
  model: string
  messages?: { role: string; content?: string | Part[] | null }[]
  reasoning_effort?: string
  stream?: boolean
  user?: string
  metadata?: Record<string, unknown>
  [k: string]: unknown
}

/** Responses (`/responses`). */
export type ResponsesBody = {
  model: string
  instructions?: string
  input?: string | { type?: string; role?: string; content?: string | Part[]; output?: unknown }[]
  reasoning?: { effort?: string; [k: string]: unknown }
  stream?: boolean
  user?: string
  metadata?: Record<string, unknown>
  [k: string]: unknown
}

const TEXT = new Set(['text', 'input_text', 'output_text'])
const IMAGE = new Set(['image_url', 'input_image'])

const textOf = (content: string | Part[] | null | undefined): string =>
  typeof content === 'string'
    ? content
    : (content ?? []).filter(p => TEXT.has(p.type)).map(p => p.text ?? '').join('\n')

const hasImage = (content: string | Part[] | null | undefined) =>
  Array.isArray(content) && content.some(p => IMAGE.has(p.type))

const sessionOf = (body: { user?: string; metadata?: Record<string, unknown> }, headers: Headers) =>
  headers.get('x-session-id') ??
  headers.get('x-copilot-session-id') ??
  (typeof body.metadata?.session_id === 'string' ? body.metadata.session_id : undefined) ??
  body.user ??
  undefined

const size = (v: unknown) => (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length)

export const fromChat = (body: ChatBody, headers: Headers): RouteRequest => {
  const messages = body.messages ?? []

  return {
    sessionId: sessionOf(body, headers),
    system: messages
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => textOf(m.content))
      .join('\n'),
    turns: messages
      .filter(m => m.role !== 'system' && m.role !== 'developer')
      .map(
        (m): Turn => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          // Tool output rides the `tool` role: never human text.
          text: m.role === 'tool' ? '' : textOf(m.content),
          hasToolResult: m.role === 'tool',
          hasImage: hasImage(m.content),
          chars: size(m),
        }),
      ),
  }
}

export const fromResponses = (body: ResponsesBody, headers: Headers): RouteRequest => {
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? [])

  return {
    sessionId: sessionOf(body, headers),
    system: [
      body.instructions ?? '',
      ...items.filter(i => i.role === 'system' || i.role === 'developer').map(i => textOf(i.content)),
    ].join('\n'),
    turns: items
      .filter(i => i.role !== 'system' && i.role !== 'developer')
      .map((i): Turn => {
        const isTool = i.type === 'function_call_output' || i.type === 'custom_tool_call_output'
        const isModel = i.role === 'assistant' || i.type === 'function_call' || i.type === 'reasoning'

        return {
          role: isModel ? 'assistant' : 'user',
          text: isTool || isModel ? (isModel ? textOf(i.content) : '') : textOf(i.content),
          hasToolResult: isTool,
          hasImage: hasImage(i.content),
          chars: size(i),
        }
      }),
  }
}

export const applyChat = (body: ChatBody, d: Decision): ChatBody => {
  const out: ChatBody = { ...body, model: d.target.model }

  if (d.target.supportsEffort === false) {
    delete out.reasoning_effort
  } else if (d.effort !== undefined) {
    out.reasoning_effort = d.effort
  }

  return out
}

export const applyResponses = (body: ResponsesBody, d: Decision): ResponsesBody => {
  const out: ResponsesBody = { ...body, model: d.target.model }
  const reasoning = { ...body.reasoning }

  if (d.target.supportsEffort === false) {
    delete reasoning.effort
  } else if (d.effort !== undefined) {
    reasoning.effort = d.effort
  }

  if (Object.keys(reasoning).length > 0) {
    out.reasoning = reasoning
  } else {
    delete out.reasoning
  }

  return out
}

/** Usage from a JSON reply or the SSE chunks (the last one carrying `usage`). */
export const usageFromOpenAI = (text: string): Record<string, unknown> | undefined => {
  if (!text.startsWith('data:') && !text.startsWith('event:')) {
    try {
      return (JSON.parse(text) as { usage?: Record<string, unknown> }).usage
    } catch {
      return undefined
    }
  }

  let usage: Record<string, unknown> | undefined

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:') || !line.includes('usage')) {
      continue
    }

    try {
      const chunk = JSON.parse(line.slice(5)) as {
        usage?: Record<string, unknown> | null
        response?: { usage?: Record<string, unknown> }
      }
      const u = chunk.usage ?? chunk.response?.usage

      if (u) {
        usage = u
      }
    } catch {
      // best-effort
    }
  }

  return usage
}
