import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Sent = { model: string; effort?: unknown }

const answer = (e: { turnId: string; index: number }) => ({
  turnId: e.turnId,
  index: e.index,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: null,
})

test('with the decision model down, a trivial prompt still routes to haiku through the heuristic', async ($, on) => {
  const sent: Sent[] = []

  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.clock(on, { now: 1_000 })
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'what is a mutex?', toolUses: [] }] }))
  on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '' } }))
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })

    return answer(e)
  })

  await $.turn.start({ turnId: 't1', text: 'what is a mutex?' })
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) {
    void chunk
  }

  expect(sent).toEqual([{ model: 'claude-haiku-4-5', effort: 'medium' }])
})

test('the claude classifier picks the tier, and every step of the turn agrees', { options: { classifier: 'claude' } }, async ($, on) => {
  const sent: Sent[] = []

  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.clock(on, { now: 1_000 })
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'design the sync protocol', toolUses: [] }] }))
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: '{"tier":"reasoning","effort":"xhigh","why":"protocol design"}', usage: USAGE },
  }))
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })

    return answer(e)
  })

  await $.turn.start({ turnId: 't1', text: 'design the sync protocol' })
  for (const index of [0, 1]) {
    for await (const chunk of $.turn.step({ turnId: 't1', index, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })) {
      void chunk
    }
  }

  // xhigh is capped at maxEffort (high by default).
  expect(sent).toEqual([
    { model: 'claude-opus-5-5', effort: 'high' },
    { model: 'claude-opus-5-5', effort: 'high' },
  ])
})

test('subagent steps are left alone', async ($, on) => {
  const sent: Sent[] = []

  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model })

    return answer(e)
  })

  for await (const chunk of $.turn.step({ turnId: 't9', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' })) {
    void chunk
  }

  expect(sent).toEqual([{ model: 'claude-sonnet-5-5' }])
})
