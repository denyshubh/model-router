import { expect, test } from 'bun:test'

import { extract, resolveConfig } from '../src/core'
import { fromAnthropic, sessionOf } from '../src/wire/anthropic'
import { fromChat, fromResponses } from '../src/wire/openai'

const config = resolveConfig({ tiers: { medium: { model: 'm' } } })

// The shape Claude Code sent through the proxy (captured 2026-10-17): the typed
// prompt, then the environment block as a mid-conversation system message.
test('Claude Code: the ask is the typed prompt, not the environment system message', () => {
  const req = fromAnthropic(
    {
      model: 'claude-auto',
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 'c864c118-46c4-4bd3-979d-d057eda3cb18' }) },
      messages: [
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>skills list</system-reminder>' }, { type: 'text', text: 'rename foo to bar' }] },
        { role: 'system', content: [{ type: 'text', text: '# Environment\nYou have been invoked in the following environment: ...'.repeat(200) }] },
      ],
    },
    new Headers(),
  )
  const x = extract(req, config)

  expect(req.sessionId).toBe('c864c118-46c4-4bd3-979d-d057eda3cb18')
  expect(x.ask).toBe('rename foo to bar')
  expect(x.isContinuation).toBe(false)
  expect(req.system).toContain('# Environment')
})

test('session id: header first, then the legacy metadata form', () => {
  expect(sessionOf({ model: 'x' }, new Headers({ 'x-claude-code-session-id': 'h1' }))).toBe('h1')
  expect(sessionOf({ model: 'x', metadata: { user_id: 'user_abc_account_def_session_0b5e1c2d-aaaa' } }, new Headers())).toBe('0b5e1c2d-aaaa')
})

test('OpenAI chat: tool output is never the ask; developer text is system', () => {
  const req = fromChat(
    {
      model: 'auto',
      messages: [
        { role: 'developer', content: 'You are Copilot.' },
        { role: 'user', content: [{ type: 'text', text: 'fix the flaky test' }, { type: 'image_url' }] },
        { role: 'assistant', content: null },
        { role: 'tool', content: 'FAIL src/a.test.ts' },
      ],
    },
    new Headers(),
  )
  const x = extract(req, config)

  expect(x).toMatchObject({ ask: 'fix the flaky test', isContinuation: true, hasImages: true })
  expect(req.system).toBe('You are Copilot.')
})

test('OpenAI responses: instructions are system, function output continues the turn', () => {
  const req = fromResponses(
    {
      model: 'auto',
      instructions: 'be brief',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'add a health check' }] },
        { type: 'function_call' },
        { type: 'function_call_output', output: 'ok' },
      ],
    },
    new Headers(),
  )

  expect(extract(req, config)).toMatchObject({ ask: 'add a health check', isContinuation: true })
})
