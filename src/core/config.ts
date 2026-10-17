import {
  EFFORTS,
  type Effort,
  type Target,
  type Tier,
  TIERS,
  isEffort,
  isTier,
} from './types'

export type HeuristicConfig = {
  /** Score boundaries between consecutive tiers. */
  boundaries: [number, number, number]
  weights: {
    tokenCount: number
    codePresence: number
    reasoningMarkers: number
    technicalTerms: number
    simpleIndicators: number
    multiStepPatterns: number
    questionComplexity: number
  }
  /** Ask length, in estimated tokens, below which it reads as short / above as long. */
  tokens: { short: number; long: number }
  /** Appended to the built-in technical vocabulary. */
  extraTechnicalTerms: string[]
}

export type ClassifierSpec =
  | { type: 'heuristic' }
  | {
      type: 'llm'
      /** `host`: the host's own model call (Claude Code's `$.model.complete`). */
      provider: 'anthropic' | 'openai' | 'host'
      model: string
      baseUrl?: string
      /** Environment variable holding the key. */
      apiKeyEnv?: string
      timeoutMs?: number
      /** Replaces the built-in rubric. */
      system?: string
    }
  | {
      /** A local decision model answering choice questions (LM Studio `/v1/decisions`). */
      type: 'decision'
      url: string
      model: string
      /** Cheapest tier whose cumulative probability reaches this; 0 = top choice. */
      coverage?: number
      timeoutMs?: number
    }

export type Policy = 'cache-aware' | 'always' | 'effort-only' | 'off'

export type RouterConfig = {
  /** A tier with a list random-picks per conversation. Missing tiers borrow the nearest one above, else below. */
  tiers: Partial<Record<Tier, Target | Target[]>>
  defaultTier: Tier
  maxTier: Tier
  /** Tried in order; the heuristic is appended if absent, so a verdict always exists. */
  classifiers: ClassifierSpec[]
  /** Literal, case-insensitive, word-bounded; several matches escalate to the highest tier. */
  keywordRules: { keywords: string[]; tier: Tier }[]
  policy: Policy
  cacheTtlMs: number
  /** Model requests a turn is expected to make, when weighing a downgrade. */
  expectedSteps: number
  /** `user_turn`: classify new human asks only; tool-loop steps keep the turn's decision. */
  classificationMode: 'user_turn' | 'every_request'
  /** Pin a conversation to its first-turn tier. */
  sessionAffinity: boolean
  contextEscalation: { enabled: boolean; buffer: number }
  /** Complete open..close blocks are stripped from user text before classifying. */
  reminderMarkers: [string, string][]
  /**
   * An ask starting with one of these is harness traffic (a subagent's
   * hand-back, a background task finishing, a slash command), not a new
   * human ask: it inherits the conversation's tier without classifying.
   */
  inheritPrefixes: string[]
  /** Prior turns the LLM/decision classifiers see. */
  context: {
    turns: number
    budgetChars: number
    perTurnChars: number
    includeAssistant: boolean
  }
  heuristic: HeuristicConfig
  /** Seconds a conversation's state is kept after its last request. */
  sessionTtlSeconds: number
}

export const DEFAULT_HEURISTIC: HeuristicConfig = {
  boundaries: [0.15, 0.35, 0.6],
  weights: {
    tokenCount: 0.1,
    codePresence: 0.3,
    reasoningMarkers: 0.25,
    technicalTerms: 0.25,
    simpleIndicators: 0.05,
    multiStepPatterns: 0.03,
    questionComplexity: 0.02,
  },
  tokens: { short: 15, long: 400 },
  extraTechnicalTerms: [],
}

export const DEFAULT_CONFIG: RouterConfig = {
  tiers: {},
  defaultTier: 'medium',
  maxTier: 'reasoning',
  classifiers: [{ type: 'heuristic' }],
  keywordRules: [],
  policy: 'cache-aware',
  cacheTtlMs: 5 * 60_000,
  expectedSteps: 6,
  classificationMode: 'user_turn',
  sessionAffinity: false,
  contextEscalation: { enabled: false, buffer: 0.95 },
  reminderMarkers: [['<system-reminder>', '</system-reminder>']],
  inheritPrefixes: ['<agent-message', '<task-notification', '<command-message', '<command-name', '<local-command', '<bash-input', '<bash-stdout'],
  context: { turns: 3, budgetChars: 8000, perTurnChars: 300, includeAssistant: true },
  heuristic: DEFAULT_HEURISTIC,
  sessionTtlSeconds: 6 * 3600,
}

export class ConfigError extends Error {}

const POLICIES: readonly Policy[] = ['cache-aware', 'always', 'effort-only', 'off']

const checkTarget = (where: string, raw: unknown): Target => {
  const t = (typeof raw === 'string' ? { model: raw } : raw) as Target

  if (typeof t !== 'object' || t === null || typeof t.model !== 'string' || t.model === '') {
    throw new ConfigError(`${where}: needs a "model" string`)
  }

  for (const key of ['effort', 'minEffort', 'maxEffort'] as const) {
    if (t[key] !== undefined && !isEffort(t[key])) {
      throw new ConfigError(`${where}.${key}: not an effort level`)
    }
  }

  return t
}

/**
 * Fills defaults and checks what a JSON config file can get wrong, so a typo
 * fails at start-up instead of on the first routed request.
 */
export const resolveConfig = (raw: Partial<RouterConfig> & Record<string, unknown>): RouterConfig => {
  const config: RouterConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    contextEscalation: { ...DEFAULT_CONFIG.contextEscalation, ...raw.contextEscalation },
    context: { ...DEFAULT_CONFIG.context, ...raw.context },
    heuristic: {
      ...DEFAULT_HEURISTIC,
      ...raw.heuristic,
      weights: { ...DEFAULT_HEURISTIC.weights, ...raw.heuristic?.weights },
      tokens: { ...DEFAULT_HEURISTIC.tokens, ...raw.heuristic?.tokens },
    },
  }
  const tiers: RouterConfig['tiers'] = {}

  for (const [name, value] of Object.entries(raw.tiers ?? {})) {
    if (!isTier(name)) {
      throw new ConfigError(`tiers.${name}: unknown tier (use ${TIERS.join(', ')})`)
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        throw new ConfigError(`tiers.${name}: empty pool`)
      }

      tiers[name] = value.map((v, i) => checkTarget(`tiers.${name}[${i}]`, v))
    } else {
      tiers[name] = checkTarget(`tiers.${name}`, value)
    }
  }

  if (Object.keys(tiers).length === 0) {
    throw new ConfigError('tiers: configure at least one tier')
  }

  config.tiers = tiers

  for (const key of ['defaultTier', 'maxTier'] as const) {
    if (!isTier(config[key])) {
      throw new ConfigError(`${key}: unknown tier "${String(config[key])}"`)
    }
  }

  if (!POLICIES.includes(config.policy)) {
    throw new ConfigError(`policy: one of ${POLICIES.join(', ')}`)
  }

  for (const [i, rule] of config.keywordRules.entries()) {
    if (!isTier(rule.tier) || !Array.isArray(rule.keywords)) {
      throw new ConfigError(`keywordRules[${i}]: needs "keywords" and a known "tier"`)
    }
  }

  for (const [i, c] of config.classifiers.entries()) {
    if (c.type === 'llm' && (typeof c.model !== 'string' || !['anthropic', 'openai', 'host'].includes(c.provider))) {
      throw new ConfigError(`classifiers[${i}]: llm needs "provider" (anthropic|openai|host) and "model"`)
    }

    if (c.type === 'decision' && (typeof c.url !== 'string' || typeof c.model !== 'string')) {
      throw new ConfigError(`classifiers[${i}]: decision needs "url" and "model"`)
    }

    if (!['heuristic', 'llm', 'decision'].includes(c.type)) {
      throw new ConfigError(`classifiers[${i}]: unknown type "${(c as { type: string }).type}"`)
    }
  }

  return config
}

/** The pool for a tier, borrowing the nearest configured tier above, then below. */
export const poolFor = (config: RouterConfig, tier: Tier): Target[] => {
  const at = TIERS.indexOf(tier)
  const order = [...TIERS.slice(at), ...TIERS.slice(0, at).reverse()]

  for (const t of order) {
    const v = config.tiers[t]

    if (v !== undefined) {
      return Array.isArray(v) ? v : [v]
    }
  }

  return []
}

/** Clamp an effort into [min, max]; max wins when they cross. */
export const clampEffort = (effort: Effort, min?: Effort, max?: Effort): Effort => {
  const order = EFFORTS
  let i = order.indexOf(effort)

  if (min !== undefined) {
    i = Math.max(i, order.indexOf(min))
  }

  if (max !== undefined) {
    i = Math.min(i, order.indexOf(max))
  }

  return order[i] ?? effort
}
