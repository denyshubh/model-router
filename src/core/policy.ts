import type { Policy } from './config'
import { type Target, type Tier, rankOf } from './types'

/** Output tokens a step is assumed to produce when weighing a switch. */
const OUTPUT_PER_STEP = 400

export type SwitchInput = {
  wanted: { tier: Tier; target: Target }
  /** What the last request of this conversation went to: the warm cache. */
  current: { tier: Tier; target: Target } | undefined
  policy: Policy
  /** Tokens the new model would have to reread (and write to its cache). */
  contextTokens: number
  /** Milliseconds since the last request; undefined when unknown. */
  idleMs: number | undefined
  cacheTtlMs: number
  expectedSteps: number
}

export type SwitchResult = { use: 'wanted' | 'current'; isHeld: boolean }

/**
 * Each model keeps its own prompt cache, so a switch rereads the whole
 * conversation at the new model's cache-write price instead of the old one's
 * cache-read price. Going up is always allowed: a wrong answer costs more than
 * the reread. Going down is made only when the steps ahead repay that reread
 * through cheaper reads and cheaper output. Without prices for both models
 * there is nothing to weigh, and the switch is made.
 */
export const resolveSwitch = (i: SwitchInput): SwitchResult => {
  const { wanted, current } = i

  if (current === undefined || wanted.target.model === current.target.model) {
    return { use: 'wanted', isHeld: false }
  }

  if (i.policy === 'effort-only') {
    return { use: 'current', isHeld: false }
  }

  if (i.policy === 'always' || rankOf(wanted.tier) > rankOf(current.tier)) {
    return { use: 'wanted', isHeld: false }
  }

  const from = current.target.price
  const to = wanted.target.price

  if (from === undefined || to === undefined) {
    return { use: 'wanted', isHeld: false }
  }

  const isCold = i.idleMs !== undefined && i.idleMs >= i.cacheTtlMs
  const ctx = i.contextTokens / 1e6
  const reread = ctx * (to.cacheWrite - (isCold ? from.cacheWrite : from.cacheRead))
  const savedPerStep =
    ctx * (from.cacheRead - to.cacheRead) + (OUTPUT_PER_STEP / 1e6) * (from.output - to.output)

  return reread <= i.expectedSteps * savedPerStep
    ? { use: 'wanted', isHeld: false }
    : { use: 'current', isHeld: true }
}

export const capTier = (tier: Tier, max: Tier): Tier =>
  rankOf(tier) > rankOf(max) ? max : tier
