import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toClaudeMessages,
  isClientStream,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  createResponsesStreamState,
  claudeSSELineToResponsesEvents,
  createOpenAICompletionStreamState,
  claudeSSELineToOpenAICompletionChunks,
  createClaudeMessageAssembler,
  applyClaudeSSELineToMessage,
} from '../../src/lib/protocol/convert.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

const PRETTY_SSE = [
  'event: message_start',
  'data: {',
  '  "type": "message_start",',
  '  "message": { "id": "msg_1", "model": "claude-sonnet-5", "type": "message" }',
  '}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {',
  '  "type": "content_block_delta",',
  '  "index": 0,',
  '  "delta": { "type": "text_delta", "text": "pong" }',
  '}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
]

function collect(fn, state, lines) {
  const out = []
  for (const line of lines) out.push(...fn(line, state))
  return out
}

test('isClientStream follows Anthropic/OpenAI default: omitted stream is JSON', () => {
  assert.equal(isClientStream(undefined), false)
  assert.equal(isClientStream({}), false)
  assert.equal(
    isClientStream({ model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    false,
  )
  assert.equal(isClientStream({ stream: true }), true)
  assert.equal(isClientStream({ stream: false }), false)
  assert.equal(isClientStream({}, { accept: 'text/event-stream' }), true)
  assert.equal(isClientStream({ stream: false }, { accept: 'text/event-stream' }), false)
})

test('isClientStream streams an omitted stream only when Accept prefers SSE over JSON', () => {
  // Claude Code 2.1.311+ auto-mode classifier: non-streaming body, mixed Accept, parses JSON.
  assert.equal(isClientStream({}, { accept: 'application/json, text/event-stream' }), false)
  assert.equal(isClientStream({}, { Accept: 'text/event-stream, application/json' }), false)
  assert.equal(isClientStream({}, { accept: 'application/json;q=0.5, text/event-stream' }), true)
  assert.equal(isClientStream({}, { accept: 'text/event-stream;q=0.5, application/json' }), false)
  assert.equal(isClientStream({}, { accept: 'text/event-stream;q=0' }), false)
  assert.equal(isClientStream({}, { accept: 'TEXT/EVENT-STREAM; charset=utf-8' }), true)
  assert.equal(isClientStream({}, { accept: '*/*' }), false)
  assert.equal(isClientStream({ stream: true }, { accept: 'application/json' }), true)
})

test('openai.chat convert copies stream:true onto Claude body', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(claude.stream, true)
  const official = officialMessagesBody(claude, { stream: true })
  assert.equal(official.stream, true)
})

test('openai.chat convert forces stream:true even when inbound is not streaming', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(claude.stream, true)
  const official = officialMessagesBody(claude, { stream: true })
  assert.equal(official.stream, true)
})

test('all protocols force upstream stream:true when inbound is not streaming', () => {
  const messages = toClaudeMessages('anthropic.messages', {
    model: MODEL,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(messages.claude.stream, true)
  const completions = toClaudeMessages('openai.completions', {
    model: MODEL,
    prompt: 'hi',
  })
  assert.equal(completions.claude.stream, true)
  const responses = toClaudeMessages('openai.responses', {
    model: MODEL,
    input: 'hi',
  })
  assert.equal(responses.claude.stream, true)
})

test('openai.responses and openai.completions copy stream:true', () => {
  const responses = toClaudeMessages('openai.responses', {
    model: MODEL,
    stream: true,
    input: 'hi',
  })
  assert.equal(responses.claude.stream, true)
  const completions = toClaudeMessages('openai.completions', {
    model: MODEL,
    stream: true,
    prompt: 'hi',
  })
  assert.equal(completions.claude.stream, true)
})

test('pretty-printed multiline Anthropic SSE converts to OpenAI chat chunks', () => {
  const state = createOpenAIChatStreamState(MODEL, 'vm-1')
  const chunks = collect(claudeSSELineToOpenAIChatChunks, state, PRETTY_SSE)
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.role === 'assistant'))
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.content === 'pong'))
  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.equal(finish.choices[0].finish_reason, 'stop')
  assert.equal(state.dataBuf, '')
})

test('compact single-line Anthropic SSE still converts', () => {
  const state = createOpenAIChatStreamState(MODEL, 'vm-1')
  const chunks = collect(claudeSSELineToOpenAIChatChunks, state, [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    '',
  ])
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.content === 'ok'))
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop')
})

test('pretty-printed SSE converts to Responses events', () => {
  const state = createResponsesStreamState(MODEL, 'vm-1')
  const events = collect(claudeSSELineToResponsesEvents, state, PRETTY_SSE)
  assert.ok(events.some((e) => e.type === 'response.created'))
  assert.ok(events.some((e) => e.type === 'response.output_text.delta' && e.delta === 'pong'))
  assert.ok(events.some((e) => e.type === 'response.completed'))
})

test('SSE assembler rebuilds a Claude message for buffered chat completions', () => {
  const state = createClaudeMessageAssembler()
  for (const line of PRETTY_SSE) applyClaudeSSELineToMessage(line, state)
  assert.equal(state.message.stop_reason, 'end_turn')
  assert.equal(state.message.content[0].type, 'text')
  assert.equal(state.message.content[0].text, 'pong')
  assert.equal(state.message.usage.output_tokens, 1)
})

test('SSE assembler preserves safeguard results and diagnostic delta fields', () => {
  const state = createClaudeMessageAssembler()
  applyClaudeSSELineToMessage(
    'data: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","content":[]}}',
    state,
  )
  applyClaudeSSELineToMessage(
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","safeguard_results":{"classifier":"allow"},"diagnostics":{"trace":"t1"}}}',
    state,
  )
  assert.deepEqual(state.message.safeguard_results, { classifier: 'allow' })
  assert.deepEqual(state.message.diagnostics, { trace: 't1' })
})

test('SSE assembler rebuilds tool_use input from json deltas', () => {
  const state = createClaudeMessageAssembler()
  const lines = [
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
    '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/tmp/x\\"}"}}',
    '',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
    '',
  ]
  for (const line of lines) applyClaudeSSELineToMessage(line, state)
  assert.equal(state.message.stop_reason, 'tool_use')
  assert.equal(state.message.content[0].name, 'read_file')
  assert.equal(state.message.content[0].input.path, '/tmp/x')
  assert.equal(state.message.content[0]._inputJson, undefined)
})

test('pretty-printed SSE converts to completion chunks', () => {
  const state = createOpenAICompletionStreamState(MODEL, 'vm-1')
  const chunks = collect(claudeSSELineToOpenAICompletionChunks, state, PRETTY_SSE)
  assert.ok(chunks.some((c) => c.choices?.[0]?.text === 'pong'))
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop')
})
