import type { HeuristicConfig, RouterConfig } from './config'
import { type Tier, type Verdict, TIERS } from './types'

const CODE = [
  'function', 'class', 'method', 'api', 'endpoint', 'database', 'schema', 'query',
  'bug', 'error', 'exception', 'stack trace', 'test', 'tests', 'refactor', 'compile',
  'build', 'deploy', 'import', 'module', 'interface', 'type', 'regex', 'script',
  'migration', 'commit', 'branch', 'merge', 'config', 'dependency',
]
const REASONING = [
  'step by step', 'think through', 'think carefully', 'analyze', 'analyse', 'reason about',
  'trade-off', 'tradeoff', 'trade-offs', 'pros and cons', 'compare', 'evaluate',
  'root cause', 'why does', 'prove', 'design', 'architect', 'plan out', 'investigate',
]
const TECHNICAL = [
  'architecture', 'distributed', 'concurrency', 'concurrent', 'race condition', 'deadlock',
  'encryption', 'authentication', 'authorization', 'security', 'vulnerability',
  'performance', 'latency', 'scalability', 'consistency', 'cache', 'caching',
  'kubernetes', 'microservice', 'protocol', 'tcp', 'http', 'oauth', 'memory leak',
  'thread', 'async', 'transaction', 'replication', 'sharding', 'algorithm', 'complexity',
]
const SIMPLE = [
  'what is', "what's", 'define', 'hi', 'hello', 'hey', 'thanks', 'thank you',
  'rename', 'typo', 'format', 'commit message', 'list', 'show me', 'print',
]
/**
 * Verbs that hand the agent work to do. An agent ask built on one is at
 * least `medium` however short: "start on the P0 tasks" is seven tokens of
 * real work, which length and vocabulary alone would score as trivial.
 */
const WORK = [
  'implement', 'build', 'create', 'add', 'start', 'start on', 'work on', 'working on', 'take care of',
  'support', 'migrate', 'set up', 'setup', 'integrate', 'write', 'refactor', 'debug', 'fix',
  'update', 'change', 'improve', 'optimize', 'review', 'investigate', 'handle', 'make sure',
]
/** Short replies that carry the difficulty of the work in progress, not their own. */
const FOLLOW_UP_WORDS = new Set([
  'y', 'yes', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'ahead', 'do', 'it', 'that', 'this',
  'continue', 'proceed', 'next', 'fix', 'try', 'again', 'please', 'lgtm', 'sounds', 'good',
  'ship', 'and', 'keep', 'going', 'then', 'same', 'approved', 'agreed', 'k', 'thanks',
])

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const count = (text: string, words: readonly string[]) =>
  words.filter(w => new RegExp(`\\b${escape(w)}\\b`, 'i').test(text))

const clamp = (n: number) => Math.max(-1, Math.min(1, n))

/** Up to six words, every one of them assent or "keep going". */
export const isFollowUp = (ask: string) => {
  const words = ask.toLowerCase().split(/[^a-z]+/).filter(Boolean)

  return words.length > 0 && words.length <= 6 && words.every(w => FOLLOW_UP_WORDS.has(w))
}

export const tierFromScore = (score: number, b: HeuristicConfig['boundaries']): Tier =>
  score < b[0] ? 'simple' : score < b[1] ? 'medium' : score < b[2] ? 'complex' : 'reasoning'

/**
 * Seven weighted signals over the human ask, mapped to a tier by score.
 * Only the ask is read: under an agent harness the system prompt is full of
 * code words on every request, and reading it would push everything up.
 * Two or more reasoning markers force `reasoning` whatever the score.
 */
export const scoreHeuristic = (
  ask: string,
  config: RouterConfig,
  previousTier?: Tier,
): Verdict => {
  const h = config.heuristic

  if (previousTier !== undefined && isFollowUp(ask)) {
    return {
      tier: previousTier,
      cause: 'follow_up',
      source: 'heuristic',
      signals: [`follow-up inherits ${previousTier}`],
    }
  }

  const tokens = Math.ceil(ask.length / 4)
  const code = count(ask, CODE)
  const fences = (ask.match(/```/g)?.length ?? 0) / 2 + (ask.match(/`[^`\n]+`/g)?.length ?? 0) * 0.3
  const reasoning = count(ask, REASONING)
  const technical = count(ask, [...TECHNICAL, ...h.extraTechnicalTerms])
  const simple = count(ask, SIMPLE)
  const steps =
    /\bfirst\b[\s\S]*\bthen\b/i.test(ask) || (ask.match(/^\s*\d+[.)]\s/gm)?.length ?? 0) >= 2
  const questions = ask.match(/\?/g)?.length ?? 0

  const dims = {
    tokenCount: tokens < h.tokens.short ? -1 : tokens > h.tokens.long ? 1 : (tokens - h.tokens.short) / (h.tokens.long - h.tokens.short),
    codePresence: clamp((code.length + fences) / 3),
    reasoningMarkers: clamp(reasoning.length / 2),
    technicalTerms: clamp(technical.length / 3),
    simpleIndicators: simple.length > 0 ? -1 : 0,
    multiStepPatterns: steps ? 1 : 0,
    questionComplexity: questions > 1 ? clamp((questions - 1) / 2) : 0,
  }
  const score = (Object.keys(dims) as (keyof typeof dims)[]).reduce(
    (sum, k) => sum + dims[k] * h.weights[k],
    0,
  )
  const signals = [
    tokens < h.tokens.short ? `short (${tokens} tokens)` : tokens > h.tokens.long ? `long (${tokens} tokens)` : '',
    code.length ? `code (${code.slice(0, 3).join(', ')})` : '',
    reasoning.length ? `reasoning (${reasoning.slice(0, 3).join(', ')})` : '',
    technical.length ? `technical (${technical.slice(0, 3).join(', ')})` : '',
    simple.length ? `simple (${simple[0]})` : '',
    steps ? 'multi-step' : '',
    questions > 1 ? `${questions} questions` : '',
  ].filter(Boolean)

  const work = count(ask, WORK)

  if (work.length > 0) {
    signals.push(`work (${work.slice(0, 3).join(', ')})`)
  }

  if (reasoning.length >= 2) {
    return { tier: 'reasoning', cause: 'heuristic', source: 'heuristic', score, signals: [...signals, 'forced: 2+ reasoning markers'] }
  }

  const tier = tierFromScore(score, h.boundaries)

  // Work verbs floor the tier at medium, unless the ask opens as a simple one ("what is", "rename").
  const opensSimple = simple.some(w => ask.trim().toLowerCase().startsWith(w))

  return {
    tier: tier === 'simple' && work.length > 0 && !opensSimple ? 'medium' : tier,
    cause: 'heuristic',
    source: 'heuristic',
    score,
    signals,
  }
}

/** Highest tier among matching rules, so rule order never changes the outcome. */
export const matchKeywords = (ask: string, config: RouterConfig): Verdict | undefined => {
  let best: Tier | undefined
  const hits: string[] = []

  for (const rule of config.keywordRules) {
    const matched = count(ask, rule.keywords)

    if (matched.length > 0) {
      hits.push(...matched.map(m => `${m}->${rule.tier}`))

      if (best === undefined || TIERS.indexOf(rule.tier) > TIERS.indexOf(best)) {
        best = rule.tier
      }
    }
  }

  return best === undefined
    ? undefined
    : { tier: best, cause: 'keyword', source: 'keywords', signals: hits }
}
