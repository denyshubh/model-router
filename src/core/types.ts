/** Difficulty ladder, cheapest first. Every host maps these to its own models. */
export const TIERS = ['simple', 'medium', 'complex', 'reasoning'] as const
export type Tier = (typeof TIERS)[number]

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export const rankOf = (tier: Tier): number => TIERS.indexOf(tier)

export const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && (TIERS as readonly string[]).includes(value)

export const isEffort = (value: unknown): value is Effort =>
  typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)

/** USD per million tokens. */
export type Price = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** One model a tier can send a request to. */
export type Target = {
  model: string
  /** Effort used when the classifier does not ask for one. */
  effort?: Effort
  minEffort?: Effort
  maxEffort?: Effort
  /** false: the model rejects an effort parameter, so none is sent. */
  supportsEffort?: boolean
  /**
   * How the model takes thinking on the Anthropic wire: `adaptive` (current
   * models), `budget` (older ones, e.g. Haiku 4.5), `none`. Left out: untouched.
   */
  thinking?: 'adaptive' | 'budget' | 'none'
  /** false: cannot read images, so image-bearing requests skip it. */
  vision?: boolean
  /** Input tokens it accepts; enables context-window escalation. */
  contextWindow?: number
  price?: Price
}

/** A conversation turn, normalized from any wire format. */
export type Turn = {
  role: 'user' | 'assistant'
  /** Human-readable text only (text blocks); tool output is not here. */
  text: string
  /** The turn carries tool results (a `tool_result` block or the `tool` role). */
  hasToolResult: boolean
  hasImage?: boolean
  /** Total characters including tool output, for the token estimate. */
  chars?: number
}

export type RouteRequest = {
  /** Host session id; the router adds a conversation fingerprint to it. */
  sessionId?: string
  system: string
  turns: Turn[]
  /** The ask, when the host knows it exactly (e.g. the typed prompt). */
  ask?: string
  /** The host knows this request continues a turn already routed. */
  isContinuation?: boolean
  /** The tier whose prompt cache is warm, when the host knows it. */
  currentTier?: Tier
  /** Exact prompt token count when the host has it; else estimated. */
  promptTokens?: number
  metadata?: Record<string, unknown>
}

export type Cause =
  | 'keyword'
  | 'heuristic'
  | 'llm'
  | 'decision'
  | 'follow_up'
  | 'continuation'
  | 'session_pin'
  | 'no_ask'

export type Verdict = {
  tier: Tier
  effort?: Effort
  cause: Cause
  /** Which classifier produced it, e.g. `llm:claude-haiku-4-5`. */
  source: string
  why?: string
  signals?: string[]
  score?: number
  probs?: Partial<Record<Tier, number>>
}

export type Decision = {
  tier: Tier
  target: Target
  /** Effort to send; undefined means leave the request's own alone. */
  effort: Effort | undefined
  cause: Cause
  source: string
  /** The classifier's tier before caps, cache guard and escalation. */
  wantedTier: Tier
  /** A cheaper tier was wanted and the warm cache kept the current one. */
  isHeld: boolean
  /** Moved up because the prompt does not fit, or carries images. */
  escalated?: 'context' | 'vision'
  why?: string
  signals: string[]
  score?: number
  probs?: Partial<Record<Tier, number>>
  classifierMs: number
  /** Classifiers that failed before one answered, with the reason. */
  failures: string[]
  ask: string
  contextTokens: number
  conversation: string
}
