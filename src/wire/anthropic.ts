import type { Decision, RouteRequest, Turn } from '../core'

type Block = {
  type: string
  text?: string
  content?: string | Block[]
}

type Message = { role: string; content: string | Block[] }

export type AnthropicBody = {
  model: string
  system?: string | Block[]
  messages?: Message[]
  max_tokens?: number
  stream?: boolean
  thinking?: { type: string; [k: string]: unknown }
  output_config?: { effort?: string; [k: string]: unknown }
  metadata?: { user_id?: string }
  [k: string]: unknown
}

const textOf = (content: string | Block[] | undefined): string =>
  typeof content === 'string'
    ? content
    : (content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')

const hasImage = (content: string | Block[] | undefined): boolean =>
  Array.isArray(content) &&
  content.some(b => b.type === 'image' || (b.type === 'tool_result' && hasImage(b.content)))

/**
 * Claude Code names its session in the `x-claude-code-session-id` header and
 * inside `metadata.user_id` (as `..._session_<uuid>` or a JSON string with
 * `session_id`); other clients may send neither.
 */
export const sessionOf = (body: AnthropicBody, headers: Headers): string | undefined => {
  const header = headers.get('x-claude-code-session-id') ?? headers.get('x-session-id')
  const userId = body.metadata?.user_id

  if (header !== null) {
    return header
  }

  if (userId === undefined) {
    return undefined
  }

  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown }

    if (typeof parsed.session_id === 'string') {
      return parsed.session_id
    }
  } catch {
    // The older flat form.
  }

  return userId.match(/session_([0-9a-zA-Z-]{8,})/)?.[1]
}

/**
 * Mid-conversation system messages (`role: "system"` inside `messages`) are
 * operator text, not turns: Claude Code carries its environment block in one,
 * after the human's prompt, and reading it as the ask would route every
 * prompt on several thousand tokens of harness context.
 */
export const fromAnthropic = (body: AnthropicBody, headers: Headers): RouteRequest => ({
  sessionId: sessionOf(body, headers),
  system: [textOf(body.system), ...(body.messages ?? []).filter(m => m.role === 'system').map(m => textOf(m.content))]
    .filter(Boolean)
    .join('\n'),
  turns: (body.messages ?? []).filter(m => m.role !== 'system').map(
    (m): Turn => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: textOf(m.content),
      hasToolResult: Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'),
      hasImage: hasImage(m.content),
      chars: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length,
    }),
  ),
})

/**
 * Rewrites the request for the chosen target: its model, the decided effort
 * in `output_config.effort`, and thinking reshaped to what the model accepts
 * (older models take a token budget, not `adaptive`).
 */
export const applyAnthropic = (body: AnthropicBody, d: Decision): AnthropicBody => {
  const out: AnthropicBody = { ...body, model: d.target.model }
  const config = { ...body.output_config }

  if (d.target.supportsEffort === false) {
    delete config.effort
  } else if (d.effort !== undefined) {
    config.effort = d.effort
  }

  if (Object.keys(config).length > 0) {
    out.output_config = config
  } else {
    delete out.output_config
  }

  const thinking = d.target.thinking

  if (thinking === 'none') {
    delete out.thinking
  } else if (thinking === 'budget' && body.thinking?.type === 'adaptive') {
    const max = body.max_tokens ?? 0

    if (max >= 2048) {
      out.thinking = { type: 'enabled', budget_tokens: Math.min(16_000, max - 1024) }
    } else {
      delete out.thinking
    }
  }

  return out
}

/** Usage from a JSON reply or an SSE stream (`message_start` plus `message_delta`). */
export const usageFromAnthropic = (text: string): Record<string, unknown> | undefined => {
  try {
    if (!text.startsWith('event:') && !text.startsWith('data:')) {
      return (JSON.parse(text) as { usage?: Record<string, unknown> }).usage
    }
  } catch {
    return undefined
  }

  let usage: Record<string, unknown> | undefined

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:') || !line.includes('usage')) {
      continue
    }

    try {
      const event = JSON.parse(line.slice(5)) as {
        type?: string
        message?: { usage?: Record<string, unknown> }
        usage?: Record<string, unknown>
      }
      const u = event.type === 'message_start' ? event.message?.usage : event.usage

      if (u !== undefined) {
        usage = { ...usage, ...u }
      }
    } catch {
      // A line split across chunks is skipped; usage is best-effort.
    }
  }

  return usage
}
