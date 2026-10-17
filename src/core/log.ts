import type { Decision, Effort, Tier } from './types'

export type LogMode = 'off' | 'metadata' | 'full'

export const isLogMode = (value: unknown): value is LogMode =>
  value === 'off' || value === 'metadata' || value === 'full'

export type Outcome = {
  status?: number
  durationMs?: number
  /** Provider usage as returned (input/output/cache token counts). */
  usage?: unknown
  isAborted?: boolean
  reason?: string
}

/** One routed request: what was asked, what was decided, how it went. A JSONL row. */
export type DecisionRecord = {
  v: 2
  at: string
  host: string
  router: string
  conversation: string
  requestedModel: string
  cause: Decision['cause']
  source: string
  wantedTier: Tier
  tier: Tier
  model: string
  effort: Effort | null
  isHeld: boolean
  escalated: Decision['escalated'] | null
  score: number | null
  probs: Decision['probs'] | null
  signals: string[]
  why: string | null
  failures: string[]
  classifierMs: number
  contextTokens: number
  askChars: number
  /** The ask as classified, clipped; null in metadata mode. */
  ask: string | null
  outcome: Outcome | null
}

export const toRecord = (
  d: Decision,
  meta: { at: string; host: string; router: string; requestedModel: string; mode: LogMode },
  outcome?: Outcome,
): DecisionRecord => ({
  v: 2,
  at: meta.at,
  host: meta.host,
  router: meta.router,
  conversation: d.conversation,
  requestedModel: meta.requestedModel,
  cause: d.cause,
  source: d.source,
  wantedTier: d.wantedTier,
  tier: d.tier,
  model: d.target.model,
  effort: d.effort ?? null,
  isHeld: d.isHeld,
  escalated: d.escalated ?? null,
  score: d.score ?? null,
  probs: d.probs ?? null,
  signals: d.signals,
  why: d.why ?? null,
  failures: d.failures,
  classifierMs: d.classifierMs,
  contextTokens: d.contextTokens,
  askChars: d.ask.length,
  ask: meta.mode === 'full' ? d.ask.slice(0, 2000) : null,
  outcome: outcome ?? null,
})

/** The greppable one-liner, `cause=` first so a log pipeline can split on it. */
export const describe = (d: Decision): string =>
  [
    `cause=${d.cause}`,
    `tier=${d.tier}`,
    d.wantedTier !== d.tier ? `wanted=${d.wantedTier}` : '',
    `model=${d.target.model}`,
    d.effort ? `effort=${d.effort}` : '',
    d.isHeld ? 'held=cache-warm' : '',
    d.escalated ? `escalated=${d.escalated}` : '',
    d.score !== undefined ? `score=${d.score.toFixed(3)}` : '',
    d.failures.length ? `fallback_after=[${d.failures.join('; ')}]` : '',
    d.signals.length ? `signals=[${d.signals.join(', ')}]` : '',
    `ms=${d.classifierMs}`,
  ]
    .filter(Boolean)
    .join(' ')
