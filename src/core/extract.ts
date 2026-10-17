import type { RouterConfig } from './config'
import type { RouteRequest, Turn } from './types'

/** Removes complete open..close blocks (case-insensitive); an unclosed opener is left alone. */
export const stripReminders = (text: string, markers: [string, string][]): string => {
  let out = text

  for (const [open, close] of markers) {
    const lower = () => out.toLowerCase()
    const o = open.toLowerCase()
    const c = close.toLowerCase()
    let start = lower().indexOf(o)

    while (start >= 0) {
      const end = lower().indexOf(c, start + o.length)

      if (end < 0) {
        break
      }

      out = out.slice(0, start) + out.slice(end + c.length)
      start = lower().indexOf(o, start)
    }
  }

  return out.trim()
}

export type Extracted = {
  /** The newest human ask, reminders stripped; '' when there is none. */
  ask: string
  /** This request continues a turn: its newest message is tool output or the model's. */
  isContinuation: boolean
  /** Prior turns for classifier context, oldest first, already clipped. */
  prior: { role: Turn['role']; text: string }[]
  contextTokens: number
  hasImages: boolean
  /** Fingerprint of the conversation's first human ask: subagents and the main loop differ. */
  firstAsk: string
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}...` : text

/**
 * Finds what to classify in an agent request. Under a harness one turn is a
 * huge shared system prompt, a pile of tool results and a one-line ask; the
 * ask is what decides the tier, so it is found on its own: the newest user
 * turn that still holds human text once tool output and reminder blocks are
 * set aside.
 */
export const extract = (req: RouteRequest, config: RouterConfig): Extracted => {
  const markers = config.reminderMarkers
  const turns = req.turns.map(t => ({
    ...t,
    text: t.role === 'user' ? stripReminders(t.text, markers) : t.text.trim(),
  }))
  const isHuman = (t: Turn) => t.role === 'user' && t.text !== ''
  let askIndex = -1

  for (let i = turns.length - 1; i >= 0; i--) {
    if (isHuman(turns[i]!)) {
      askIndex = i
      break
    }
  }

  const hinted = req.ask === undefined ? '' : stripReminders(req.ask, markers)
  const ask = hinted !== '' ? hinted : (turns[askIndex]?.text ?? '')
  const newest = turns.at(-1)
  const isContinuation =
    req.isContinuation ??
    (newest !== undefined &&
      (newest.role === 'assistant' || (newest.hasToolResult && newest.text === '')))

  const { turns: maxTurns, budgetChars, perTurnChars, includeAssistant } = config.context
  const prior: Extracted['prior'] = []
  let budget = budgetChars
  const end = askIndex >= 0 ? askIndex : turns.length

  for (let i = end - 1; i >= 0 && prior.length < maxTurns && budget >= 120; i--) {
    const t = turns[i]!

    if (t.text === '' || t.text === ask || (t.role === 'assistant' && !includeAssistant)) {
      continue
    }

    const text = clip(t.text, Math.min(perTurnChars, budget))

    budget -= text.length
    prior.unshift({ role: t.role, text })
  }

  const chars =
    req.system.length + req.turns.reduce((n, t) => n + (t.chars ?? t.text.length), 0)

  return {
    ask,
    isContinuation,
    prior,
    contextTokens: req.promptTokens ?? Math.ceil(chars / 4),
    hasImages: req.turns.some(t => t.hasImage === true),
    firstAsk: turns.find(isHuman)?.text.slice(0, 500) ?? '',
  }
}

/** FNV-1a, 32-bit, hex: a stable short key, not a security boundary. */
export const fingerprint = (text: string): string => {
  let h = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return (h >>> 0).toString(16).padStart(8, '0')
}
