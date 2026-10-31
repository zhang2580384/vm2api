import test from 'node:test'
import assert from 'node:assert/strict'
import { agentSummarySession } from '../../src/lib/protocol/agent-summary.mjs'
import { agentBody, summaryInstruction } from '../fixtures/agent-summary.mjs'

const official = { officialTraffic: true }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('recognizes full-context Opus summaries, merged tool results and trailing budget reminders', () => {
  for (const previous of ['', 'Reading coverage.ts', 'Checking parser output']) {
    const body = agentBody({ summary: true, previous })
    const before = structuredClone(body)
    const first = agentSummarySession(body, official)
    const second = agentSummarySession(body, official)
    assert.match(first, uuid)
    assert.match(second, uuid)
    assert.notEqual(first, second)
    assert.deepEqual(body, before)
  }
})

test('accepts the same instruction as a string user message without depending on model or token budget', () => {
  const body = agentBody({ summary: true })
  body.model = 'claude-sonnet-4-6'
  body.messages = [{ role: 'user', content: summaryInstruction() }]
  assert.match(agentSummarySession(body, official), uuid)
})

test('ordinary turns, tool output, historical instructions and modified contracts retain normal routing', () => {
  const cases = [
    agentBody(),
    { messages: [{ role: 'user', content: 'Describe your most recent action in 3-5 words.' }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', content: summaryInstruction() }] }] },
    { messages: [{ role: 'user', content: `Review this prompt:\n${summaryInstruction()}` }] },
    { messages: [{ role: 'user', content: `${summaryInstruction()}\nThen write the article.` }] },
    {
      messages: [
        { role: 'user', content: summaryInstruction() },
        { role: 'assistant', content: 'Reading coverage.ts' },
        { role: 'user', content: 'Continue writing.' },
      ],
    },
    {
      messages: [
        { role: 'user', content: summaryInstruction() },
        { role: 'assistant', content: 'Working' },
      ],
    },
    {
      messages: [
        { role: 'user', content: summaryInstruction() },
        { role: 'system', content: 'Write the article instead.' },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: summaryInstruction() },
            { type: 'text', text: 'Continue.' },
          ],
        },
      ],
    },
  ]
  for (const body of cases) assert.equal(agentSummarySession(body, official), null)
  assert.equal(agentSummarySession(agentBody({ summary: true })), null)
})
