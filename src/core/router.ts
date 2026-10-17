import { type Classifier, type Io, makeClassifier, withBreaker } from './classifiers'
import { type RouterConfig, clampEffort, poolFor } from './config'
import { type Extracted, extract, fingerprint } from './extract'
import { matchKeywords, scoreHeuristic } from './heuristic'
import { capTier, resolveSwitch } from './policy'
import {
  type Decision,
  type RouteRequest,
  type Target,
  type Tier,
  type Verdict,
  TIERS,
  rankOf,
} from './types'

type Conversation = {
  tier: Tier
  target: Target
  at: number
  decision: Decision
  askKey: string
  pinned: Tier | undefined
}

type Step = Classifier | 'heuristic'

/**
 * Decides, per request, which model a conversation's next request goes to.
 * Holds per-conversation state (the warm tier, the turn's decision) in
 * memory; one instance serves many sessions.
 */
export class Router {
  private readonly conversations = new Map<string, Conversation>()
  private readonly chain: Step[]

  constructor(
    readonly config: RouterConfig,
    private readonly io: Io,
  ) {
    const steps: Step[] = config.classifiers.map(spec =>
      spec.type === 'heuristic' ? 'heuristic' : withBreaker(makeClassifier(spec, io), io),
    )
    const end = steps.indexOf('heuristic')

    // The heuristic always answers, so nothing after it would run.
    this.chain = end >= 0 ? steps.slice(0, end + 1) : [...steps, 'heuristic']
  }

  /** Undefined when the policy is `off`: send the request as it is. */
  async route(req: RouteRequest): Promise<Decision | undefined> {
    const config = this.config

    if (config.policy === 'off') {
      return undefined
    }

    const now = await this.io.now()
    const x = extract(req, config)
    const conversation = `${req.sessionId ?? 'anon'}:${fingerprint(x.firstAsk)}`
    const state = this.recall(conversation, now)
    const askKey = fingerprint(x.ask)

    // A tool-loop step, or the same ask again, keeps the turn's decision.
    if (
      config.classificationMode === 'user_turn' &&
      state !== undefined &&
      (x.isContinuation || askKey === state.askKey)
    ) {
      const kept: Decision = {
        ...state.decision,
        cause: 'continuation',
        classifierMs: 0,
        failures: [],
        contextTokens: x.contextTokens,
      }
      const decision = this.escalateForContext(kept, x) ?? kept

      this.remember(conversation, decision, now, askKey, state.pinned)

      return decision
    }

    const startedAt = await this.io.now()
    const { verdict, failures } = await this.classify(x, state)
    const classifierMs = (await this.io.now()) - startedAt
    let tier = capTier(verdict.tier, config.maxTier)
    let target = this.pick(tier, state)
    let escalated: Decision['escalated']

    if (x.hasImages && target.vision === false) {
      const seeing = this.findUp(tier, t => t.vision !== false)

      if (seeing !== undefined) {
        ;({ tier, target } = seeing)
        escalated = 'vision'
      }
    }

    const current =
      state !== undefined
        ? { tier: state.tier, target: state.target }
        : req.currentTier !== undefined
          ? { tier: req.currentTier, target: this.pick(req.currentTier, undefined) }
          : undefined
    const sw =
      escalated === undefined
        ? resolveSwitch({
            wanted: { tier, target },
            current,
            policy: config.policy,
            contextTokens: x.contextTokens,
            idleMs: state === undefined ? undefined : now - state.at,
            cacheTtlMs: config.cacheTtlMs,
            expectedSteps: config.expectedSteps,
          })
        : { use: 'wanted' as const, isHeld: false }

    if (sw.use === 'current' && current !== undefined) {
      ;({ tier, target } = current)
    }

    const asked = verdict.effort ?? target.effort
    const decided: Decision = {
      tier,
      target,
      effort:
        target.supportsEffort === false || asked === undefined
          ? undefined
          : clampEffort(asked, target.minEffort, target.maxEffort),
      cause: verdict.cause,
      source: verdict.source,
      wantedTier: verdict.tier,
      isHeld: sw.isHeld,
      escalated,
      why: verdict.why,
      signals: verdict.signals ?? [],
      score: verdict.score,
      probs: verdict.probs,
      classifierMs,
      failures,
      ask: x.ask,
      contextTokens: x.contextTokens,
      conversation,
    }
    const decision = this.escalateForContext(decided, x) ?? decided
    const pinned =
      state?.pinned ??
      (config.sessionAffinity && decision.escalated === undefined && x.ask !== '' ? decision.tier : undefined)

    this.remember(conversation, decision, now, askKey, pinned)

    return decision
  }

  private async classify(
    x: Extracted,
    state: Conversation | undefined,
  ): Promise<{ verdict: Verdict; failures: string[] }> {
    const config = this.config
    const failures: string[] = []

    if (x.ask === '') {
      return {
        verdict: { tier: state?.tier ?? config.defaultTier, cause: 'no_ask', source: 'none' },
        failures,
      }
    }

    if (config.sessionAffinity && state?.pinned !== undefined) {
      return { verdict: { tier: state.pinned, cause: 'session_pin', source: 'pin' }, failures }
    }

    if (config.inheritPrefixes.some(p => x.ask.toLowerCase().startsWith(p.toLowerCase()))) {
      return {
        verdict: { tier: state?.tier ?? config.defaultTier, cause: 'follow_up', source: 'harness', signals: ['harness message inherits'] },
        failures,
      }
    }

    const keyword = matchKeywords(x.ask, config)

    if (keyword !== undefined) {
      return { verdict: keyword, failures }
    }

    for (const step of this.chain) {
      if (step === 'heuristic') {
        break
      }

      const result = await step.classify(x, state?.tier)

      if ('error' in result) {
        failures.push(`${step.name}: ${result.error}`)
      } else {
        return { verdict: result, failures }
      }
    }

    return { verdict: scoreHeuristic(x.ask, config, state?.tier), failures }
  }

  /** A pool member, keeping the conversation on the model it already uses. */
  private pick(tier: Tier, state: Conversation | undefined): Target {
    const pool = poolFor(this.config, tier)
    const same = pool.find(t => t.model === state?.target.model)

    return same ?? pool[Math.floor(this.io.random() * pool.length)] ?? pool[0]!
  }

  /** The lowest tier at or above `from` holding a target that passes. */
  private findUp(from: Tier, ok: (t: Target) => boolean): { tier: Tier; target: Target } | undefined {
    for (const tier of TIERS.slice(rankOf(from))) {
      const target = poolFor(this.config, tier).find(ok)

      if (target !== undefined) {
        return { tier, target }
      }
    }

    return undefined
  }

  /**
   * Moves a decision up only when the prompt provably does not fit: a target
   * with no declared window is never escalated away from or onto.
   */
  private escalateForContext(d: Decision, x: Extracted): Decision | undefined {
    const { enabled, buffer } = this.config.contextEscalation
    const fits = (t: Target) =>
      t.contextWindow !== undefined && x.contextTokens <= t.contextWindow * buffer

    if (!enabled || d.target.contextWindow === undefined || fits(d.target)) {
      return undefined
    }

    const found = this.findUp(d.tier, fits)

    return found === undefined ? undefined : { ...d, ...found, escalated: 'context' }
  }

  private recall(key: string, now: number): Conversation | undefined {
    const state = this.conversations.get(key)

    if (state !== undefined && now - state.at > this.config.sessionTtlSeconds * 1000) {
      this.conversations.delete(key)

      return undefined
    }

    return state
  }

  private remember(key: string, decision: Decision, now: number, askKey: string, pinned: Tier | undefined) {
    if (this.conversations.size > 1000) {
      for (const [k, s] of this.conversations) {
        if (now - s.at > this.config.sessionTtlSeconds * 1000) {
          this.conversations.delete(k)
        }
      }
    }

    this.conversations.set(key, { tier: decision.tier, target: decision.target, at: now, decision, askKey, pinned })
  }
}
