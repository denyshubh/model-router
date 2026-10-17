import { describe as group, expect, test } from 'bun:test'

import {
  type Io,
  type RouteRequest,
  Router,
  Timeout,
  extract,
  matchKeywords,
  parseDecision,
  resolveConfig,
  scoreHeuristic,
  stripReminders,
} from '../src/core'

const PRICES = {
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
}

const base = (extra: Record<string, unknown> = {}) =>
  resolveConfig({
    tiers: {
      simple: { model: 'haiku', supportsEffort: false, price: PRICES.haiku, vision: false, contextWindow: 200_000 },
      medium: { model: 'sonnet', effort: 'medium', price: PRICES.sonnet, contextWindow: 1_000_000 },
      complex: { model: 'opus', effort: 'medium', price: PRICES.opus, contextWindow: 1_000_000 },
      reasoning: { model: 'opus', effort: 'high', minEffort: 'high', price: PRICES.opus, contextWindow: 1_000_000 },
    },
    ...extra,
  })

/** A clock the test moves, and a fetch the test answers. */
const fakeIo = (reply?: (url: string, body: string) => { ok: boolean; status: number; text: string } | 'timeout') => {
  let clock = 1_000
  const calls: string[] = []
  const io: Io = {
    now: async () => clock,
    random: () => 0,
    env: async () => undefined,
    sleep: async ms => {
      clock += ms
    },
    async fetch(url, init) {
      calls.push(url)

      const r = reply?.(url, init.body) ?? { ok: false, status: 503, text: '' }

      if (r === 'timeout') {
        throw new Timeout('timed out')
      }

      return r
    },
  }

  return { io, calls, advance: (ms: number) => (clock += ms) }
}

const ask = (text: string, extra: Partial<RouteRequest> = {}): RouteRequest => ({
  sessionId: 's1',
  system: 'You are a coding agent. Always think step by step about the architecture.',
  turns: [{ role: 'user', text, hasToolResult: false }],
  ...extra,
})

group('extract', () => {
  test('finds the human ask past tool output and reminder blocks', () => {
    const x = extract(
      {
        system: '',
        turns: [
          { role: 'user', text: 'refactor the auth module', hasToolResult: false },
          { role: 'assistant', text: 'Reading files', hasToolResult: false },
          { role: 'user', text: '<system-reminder>todo list empty</system-reminder>', hasToolResult: true, chars: 40_000 },
        ],
      },
      base(),
    )

    expect(x.ask).toBe('refactor the auth module')
    expect(x.isContinuation).toBe(true)
    expect(x.contextTokens).toBeGreaterThan(10_000)
  })

  test('keeps the ask written around a reminder, leaves an unclosed tag', () => {
    expect(stripReminders('fix <System-Reminder>x</system-reminder>the typo', [['<system-reminder>', '</system-reminder>']])).toBe('fix the typo')
    expect(stripReminders('a <system-reminder> b', [['<system-reminder>', '</system-reminder>']])).toBe('a <system-reminder> b')
  })
})

group('heuristic', () => {
  test('a definition question is simple, whatever the system prompt says', () => {
    expect(scoreHeuristic('what is a mutex?', base()).tier).toBe('simple')
  })

  test('two reasoning markers force reasoning', () => {
    const v = scoreHeuristic('Think through the trade-offs and analyze which design is safer', base())

    expect(v.tier).toBe('reasoning')
  })

  test('a code-heavy multi-step ask scores above simple', () => {
    const v = scoreHeuristic(
      'First add a database migration for the new schema, then update the API endpoint and its tests to handle the async transaction error path.',
      base(),
    )

    expect(['complex', 'reasoning']).toContain(v.tier)
  })

  test('a follow-up inherits the previous tier', () => {
    expect(scoreHeuristic('yes, do it', base(), 'complex')).toMatchObject({ tier: 'complex', cause: 'follow_up' })
  })

  test('keyword rules escalate to the highest tier matched', () => {
    const config = base({
      keywordRules: [
        { keywords: ['typo'], tier: 'simple' },
        { keywords: ['race condition'], tier: 'reasoning' },
      ],
    })

    expect(matchKeywords('fix the typo near the race condition', config)?.tier).toBe('reasoning')
  })
})

group('decision model', () => {
  const body = (probs: number[]) =>
    JSON.stringify({
      answers: [
        { name: 'tier', choice: 'simple', probabilities: ['simple', 'medium', 'complex', 'reasoning'].map((value, i) => ({ value, probability: probs[i] })) },
        { name: 'effort', choice: 'low' },
      ],
    })

  test('widens to the cheapest tier reaching the coverage', () => {
    expect(parseDecision(body([0.5, 0.2, 0.2, 0.1]), 0.8, 'd')?.tier).toBe('complex')
    expect(parseDecision(body([0.9, 0.05, 0.05, 0]), 0.8, 'd')?.tier).toBe('simple')
    expect(parseDecision(body([0.5, 0.2, 0.2, 0.1]), 0, 'd')?.tier).toBe('simple')
  })

  test('reads three-tier answers from older decision prompts', () => {
    const old = JSON.stringify({ answers: [{ name: 'tier', choice: 'opus' }, { name: 'effort', choice: 'medium' }] })

    expect(parseDecision(old, 0.8, 'd')).toMatchObject({ tier: 'complex', effort: 'medium' })
  })
})

group('router', () => {
  test('an unreachable classifier falls back to the heuristic and says so', async () => {
    const { io } = fakeIo(() => ({ ok: false, status: 503, text: '' }))
    const router = new Router(base({ classifiers: [{ type: 'decision', url: 'http://lm/v1/decisions', model: 'clef' }] }), io)
    const d = await router.route(ask('what is a mutex?'))

    expect(d).toMatchObject({ tier: 'simple', cause: 'heuristic', failures: ['decision:clef: http 503'] })
    expect(d?.effort).toBeUndefined()
  })

  test('the decision model answers when it is up', async () => {
    const { io } = fakeIo(() => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ answers: [{ name: 'tier', choice: 'complex' }, { name: 'effort', choice: 'xhigh' }] }),
    }))
    const router = new Router(base({ classifiers: [{ type: 'decision', url: 'http://lm', model: 'clef' }] }), io)

    expect(await router.route(ask('what is a mutex?'))).toMatchObject({ tier: 'complex', cause: 'decision', effort: 'xhigh' })
  })

  test('effort is clamped into the target bounds', async () => {
    const { io } = fakeIo(() => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ answers: [{ name: 'tier', choice: 'reasoning' }, { name: 'effort', choice: 'low' }] }),
    }))
    const router = new Router(base({ classifiers: [{ type: 'decision', url: 'http://lm', model: 'clef' }] }), io)

    expect((await router.route(ask('design it')))?.effort).toBe('high')
  })

  test('a timeout opens the breaker, so the next request skips the classifier', async () => {
    const { io, calls, advance } = fakeIo(() => 'timeout')
    const router = new Router(base({ classifiers: [{ type: 'decision', url: 'http://lm', model: 'clef' }] }), io)

    await router.route(ask('what is a mutex?', { sessionId: 'a' }))
    const second = await router.route(ask('what is a mutex?', { sessionId: 'b' }))

    expect(calls).toHaveLength(1)
    expect(second?.failures).toEqual(['decision:clef: circuit open'])

    advance(31_000)
    await router.route(ask('what is a mutex?', { sessionId: 'c' }))
    expect(calls).toHaveLength(2)
  })

  test('tool-loop steps keep the turn decision without classifying again', async () => {
    const { io, calls } = fakeIo(() => ({
      ok: true,
      status: 200,
      text: JSON.stringify({ answers: [{ name: 'tier', choice: 'complex' }, { name: 'effort', choice: 'medium' }] }),
    }))
    const router = new Router(base({ classifiers: [{ type: 'decision', url: 'http://lm', model: 'clef' }] }), io)
    const first = ask('migrate the auth service')

    await router.route(first)

    const step = await router.route({
      ...first,
      turns: [
        ...first.turns,
        { role: 'assistant', text: '', hasToolResult: false },
        { role: 'user', text: '', hasToolResult: true, chars: 9000 },
      ],
    })

    expect(step).toMatchObject({ tier: 'complex', cause: 'continuation' })
    expect(calls).toHaveLength(1)
  })

  test('a warm long chat holds opus against sonnet, but drops to haiku', async () => {
    const { io } = fakeIo()
    const router = new Router(base(), io)
    const history = { role: 'user' as const, text: 'design the cache layer', hasToolResult: false, chars: 200_000 }
    const opus = await router.route({
      ...ask(''),
      turns: [history, { role: 'assistant', text: 'ok', hasToolResult: false }, { role: 'user', text: 'Think through the trade-offs and analyze the design', hasToolResult: false }],
    })

    expect(opus?.target.model).toBe('opus')

    const toSonnet = await router.route({
      ...ask(''),
      turns: [history, { role: 'assistant', text: 'done', hasToolResult: false }, { role: 'user', text: 'now write unit tests for the parser function and fix the failing build in the api module', hasToolResult: false }],
    })

    expect(toSonnet).toMatchObject({ wantedTier: 'medium', target: { model: 'opus' }, isHeld: true })

    const toHaiku = await router.route({
      ...ask(''),
      turns: [history, { role: 'assistant', text: 'done', hasToolResult: false }, { role: 'user', text: 'what is the file name?', hasToolResult: false }],
    })

    expect(toHaiku).toMatchObject({ tier: 'simple', target: { model: 'haiku' }, isHeld: false })
  })

  test('images skip a tier that cannot see them', async () => {
    const { io } = fakeIo()
    const router = new Router(base(), io)
    const d = await router.route({ ...ask(''), turns: [{ role: 'user', text: 'what is this?', hasToolResult: false, hasImage: true }] })

    expect(d).toMatchObject({ tier: 'medium', escalated: 'vision', wantedTier: 'simple' })
  })

  test('a prompt that provably overflows a tier moves up', async () => {
    const { io } = fakeIo()
    const router = new Router(base({ contextEscalation: { enabled: true, buffer: 0.95 } }), io)
    const d = await router.route({ ...ask('what is x?'), promptTokens: 400_000 })

    expect(d).toMatchObject({ tier: 'medium', escalated: 'context' })
  })

  test('maxTier caps, and policy off routes nothing', async () => {
    const { io } = fakeIo()

    expect((await new Router(base({ maxTier: 'medium' }), io).route(ask('Think through the trade-offs and analyze it')))?.tier).toBe('medium')
    expect(await new Router(base({ policy: 'off' }), io).route(ask('hi'))).toBeUndefined()
  })

  test('config errors name the key', () => {
    expect(() => resolveConfig({ tiers: { hard: 'x' } as never })).toThrow('tiers.hard')
    expect(() => resolveConfig({ tiers: { simple: [] } })).toThrow('empty pool')
    expect(() => resolveConfig({ tiers: {} })).toThrow('at least one tier')
  })
})

group('agent traffic', () => {
  test('a terse delegation of work is not trivial', () => {
    expect(scoreHeuristic('Great, start working on the P0 tasks', base()).tier).toBe('medium')
    expect(scoreHeuristic('rename foo to bar', base()).tier).toBe('simple')
  })

  test('a subagent hand-back inherits the conversation tier without classifying', async () => {
    const { io, calls } = fakeIo(() => ({ ok: true, status: 200, text: JSON.stringify({ answers: [{ name: 'tier', choice: 'complex' }] }) }))
    const router = new Router(base({ classifiers: [{ type: 'decision', url: 'http://lm', model: 'clef' }] }), io)
    const first = ask('migrate the billing service to the new queue')

    await router.route(first)

    const handBack = await router.route({
      ...first,
      turns: [
        ...first.turns,
        { role: 'assistant', text: 'delegated', hasToolResult: false },
        { role: 'user', text: '<agent-message from="a1">[Subagent hand-back] done</agent-message>', hasToolResult: false },
      ],
    })

    expect(handBack).toMatchObject({ tier: 'complex', cause: 'follow_up', source: 'harness' })
    expect(calls).toHaveLength(1)
  })
})
