/**
 * Claude Code host: routes each main-loop turn through the shared core by
 * rewriting `turn.step`'s model and effort. Bundled into
 * plugins/claude-code/hooks/register.js (`bun run build:plugin`), since a
 * plugin module may only import files inside its own folder.
 */
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  type ClassifierSpec,
  type Decision,
  type Effort,
  type Io,
  type LogMode,
  type Policy,
  type RouterConfig,
  type Target,
  type Tier,
  Router,
  TIERS,
  Timeout,
  isEffort,
  isLogMode,
  isTier,
  resolveConfig,
  toRecord,
} from '../../core'

const text = (o: PluginOptions, key: string, fallback: string) => {
  const v = o[key]

  return typeof v === 'string' && v !== '' ? v : fallback
}

const num = (o: PluginOptions, key: string, fallback: number) => {
  const v = o[key]

  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

const POLICIES: Policy[] = ['cache-aware', 'always', 'effort-only', 'off']

const PRICE = {
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
}

/** A model id's family, for the price and for the tier a session's own model sits in. */
const familyOf = (model: string) =>
  (['haiku', 'sonnet', 'opus'] as const).find(f => model.toLowerCase().includes(f))

function makeIo($: EngineInterface): Io {
  return {
  now: () => $.clock.now(),
  random: () => Math.random(),
  sleep: ms => $.clock.sleep(ms),
  // Classifiers here use the host's own model call; no API keys are read.
  env: async () => undefined,
  async fetch(url, init) {
    const reply = await Promise.race([
      $.http.fetch(url, { method: init.method, headers: init.headers, body: init.body }),
      $.clock.sleep(init.timeoutMs).then(() => undefined),
    ])

    if (reply === undefined) {
      throw new Timeout(`timed out after ${init.timeoutMs}ms`)
    }

    return { ok: reply.ok, status: reply.status, text: reply.text }
  },
  async complete(req) {
    const reply = await $.model.complete({
      model: req.model,
      system: req.system,
      prompt: req.prompt,
      maxTokens: req.maxTokens,
      timeoutMs: req.timeoutMs,
    })

    return reply.isAnswered ? reply.text : undefined
  },
  }
}

type Turn = {
  turnId: string
  decision: Decision | undefined
  skipped: 'unknown-model' | 'no-prompt' | null
  sessionModel: string
  steps: number
}

type Memory = {
  router: Router | undefined
  // The prompt a turn began with, kept until its first step reads it.
  pending: { turnId: string; text: string } | undefined
}

const tierOfModel = (config: RouterConfig, model: string): Tier | undefined => {
  const exact = TIERS.find(t => {
    const v = config.tiers[t]

    return (Array.isArray(v) ? v : v ? [v] : []).some(x => x.model === model)
  })
  const family = familyOf(model)

  return exact ?? (family === 'haiku' ? 'simple' : family === 'sonnet' ? 'medium' : family === 'opus' ? 'complex' : undefined)
}

async function decide(
  $: EngineInterface,
  config: RouterConfig,
  memory: Memory,
  turnId: string,
  model: string,
): Promise<Turn> {
  const base: Turn = { turnId, decision: undefined, skipped: null, sessionModel: model, steps: 0 }
  const currentTier = tierOfModel(config, model)

  if (currentTier === undefined) {
    return { ...base, skipped: 'unknown-model' }
  }

  const rows = await $.session.messages()
  const ask = memory.pending?.turnId === turnId ? memory.pending.text : undefined

  memory.router ??= new Router(config, makeIo($))

  const decision = await memory.router.route({
    sessionId: await $.session.id(),
    system: '',
    turns: rows.map(r => ({
      role: r.role,
      text: r.text,
      hasToolResult: (r.toolResults?.length ?? 0) > 0,
      chars: r.text.length + (r.toolResults ?? []).reduce((n, t) => n + (t.text?.length ?? 0), 0),
    })),
    ask,
    isContinuation: false,
    currentTier,
  })

  return decision === undefined || decision.ask === ''
    ? { ...base, skipped: decision === undefined ? null : 'no-prompt' }
    : { ...base, decision }
}

export const register: Register = (on, options) => {
  const maxEffort: Effort = isEffort(options.maxEffort) ? options.maxEffort : 'high'
  const target = (model: string, extra: Partial<Target> = {}): Target => {
    const family = familyOf(model)

    return {
      model,
      ...(family === 'haiku' ? { supportsEffort: false } : { maxEffort }),
      ...(family ? { price: PRICE[family] } : {}),
      ...extra,
    }
  }
  const backend = text(options, 'classifier', 'decision')
  const classifiers: ClassifierSpec[] = [
    ...(backend === 'decision'
      ? [{ type: 'decision' as const, url: text(options, 'localUrl', 'http://localhost:1234/v1/decisions'), model: text(options, 'localModel', 'clef-flash'), coverage: num(options, 'coverage', 0.8), timeoutMs: 3000 }]
      : backend === 'claude'
        ? [{ type: 'llm' as const, provider: 'host' as const, model: text(options, 'classifierModel', 'claude-haiku-4-5'), timeoutMs: 6000 }]
        : []),
    { type: 'heuristic' },
  ]
  const config = resolveConfig({
    tiers: {
      simple: target(text(options, 'simpleModel', 'claude-haiku-4-5')),
      medium: target(text(options, 'mediumModel', 'claude-sonnet-5-5')),
      complex: target(text(options, 'complexModel', 'claude-opus-5-5')),
      reasoning: target(text(options, 'reasoningModel', 'claude-opus-5-5'), { minEffort: 'high' }),
    },
    classifiers,
    policy: POLICIES.find(p => p === options.policy) ?? 'cache-aware',
    maxTier: isTier(options.maxTier) ? options.maxTier : 'reasoning',
    cacheTtlMs: num(options, 'cacheTtlMinutes', 5) * 60_000,
    expectedSteps: num(options, 'expectedSteps', 6),
    // The engine marks turns itself; every step of a turn keeps the turn's decision.
    classificationMode: 'every_request',
  })
  const logMode: LogMode = isLogMode(options.decisionLog) ? options.decisionLog : 'metadata'
  const logDir = text(options, 'logDir', '')
  const memory: Memory = { router: undefined, pending: undefined }
  let turn: Turn | undefined

  on('turn.start', (_$, e, next) => {
    memory.pending = { turnId: e.turnId, text: e.text }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents keep the model their definition chose.
    if (config.policy === 'off' || e.agentId !== undefined) {
      return yield* next(e)
    }

    if (turn?.turnId !== e.turnId) {
      turn = await decide($, config, memory, e.turnId, e.model)
    }

    turn.steps += 1

    const d = turn.decision

    // An unrouted turn is decided once: a failed lookup is not retried per step.
    if (d === undefined) {
      return yield* next(e)
    }

    $.ui.status(`route ${d.tier}·${d.target.model.replace(/^claude-/, '')}${d.effort ? `·${d.effort}` : ''}${d.isHeld ? ' (kept: cache warm)' : ''}`)

    const isSwitch = d.target.model !== e.model

    return yield* next({
      ...e,
      model: d.target.model,
      ...(d.effort !== undefined && (e.effort !== undefined || isSwitch) ? { effort: d.effort } : {}),
    })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const d = turn?.decision

    if (logMode !== 'off' && e.agentId === undefined && turn?.turnId === e.turnId && d !== undefined) {
      try {
        const home = await $.env.get('HOME')
        const dir = logDir !== '' ? logDir : home ? `${home}/.model-router/decisions` : undefined

        if (dir !== undefined) {
          const at = new Date(await $.clock.now()).toISOString()
          const record = toRecord(
            d,
            { at, host: 'claude-code', router: 'claude-code', requestedModel: turn.sessionModel, mode: logMode },
            { reason: e.reason, isAborted: e.isAborted, durationMs: e.durationMs, usage: e.usage ?? null },
          )

          await $.fs.write(`${dir}/claude-code_${at.replace(/[:.]/g, '-')}_${e.turnId.slice(0, 8)}.json`, `${JSON.stringify(record)}\n`)
        }
      } catch {
        // A log that cannot be written never costs the person their turn.
      }
    }

    return done
  })
}
