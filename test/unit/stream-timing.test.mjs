import test from 'node:test'
import assert from 'node:assert/strict'
import { createStreamTiming } from '../../src/lib/protocol/stream-timing.mjs'

test('hidden reasoning uses the upstream window, not the short visible token tail', () => {
  const timing = createStreamTiming(1_000)
  timing.observe({ type: 'kin_outbound_headers', headers: {} }, 1_050)
  timing.observe({ type: 'response.created' }, 1_200)
  timing.observe({ type: 'response.output_item.added', item: { type: 'reasoning' } }, 1_300)
  timing.observe({ type: 'response.output_text.delta', delta: 'answer' }, 16_565)
  timing.observe({ type: 'response.completed', response: { usage: { output_tokens: 621 } } }, 16_688)
  assert.deepEqual(timing.snapshot(), {
    firstByteAt: 1_200,
    firstByteMs: 200,
    firstTokenAt: 16_565,
    ttftMs: 15_565,
    generationMs: 15_488,
  })
  assert.ok(621_000 / timing.snapshot().generationMs < 41)
})

test('Claude output window stops before message_stop and transport cleanup', () => {
  const timing = createStreamTiming(100)
  timing.observe({ type: 'message_start' }, 200)
  timing.observe({ type: 'content_block_start', content_block: { type: 'text', text: '' } }, 300)
  timing.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }, 1_200)
  timing.observe({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 2_200)
  timing.observe({ type: 'message_stop' }, 9_200)
  timing.observe({ type: 'content_block_delta', delta: { text: 'late invalid output' } }, 10_000)
  assert.equal(timing.snapshot().ttftMs, 1_100)
  assert.equal(timing.snapshot().firstByteMs, 100)
  assert.equal(timing.snapshot().generationMs, 2_000)
})

test('metadata, empty blocks and signatures do not fabricate a first token', () => {
  const timing = createStreamTiming(0)
  timing.observe({ type: 'message_start' }, 100)
  timing.observe({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }, 200)
  timing.observe({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'opaque' } }, 300)
  timing.observe({ type: 'message_stop' }, 400)
  assert.equal(timing.snapshot().ttftMs, null)
  assert.equal(timing.snapshot().generationMs, null)
})

test('a single buffered packet or an interrupted stream cannot supply a measured rate', () => {
  const buffered = createStreamTiming(0)
  buffered.observe({ type: 'message_start' }, 100)
  buffered.observe({ type: 'content_block_delta', delta: { text: 'ok' } }, 100)
  buffered.observe({ type: 'message_stop' }, 100)
  assert.equal(buffered.snapshot().ttftMs, 100)
  assert.equal(buffered.snapshot().generationMs, null)
  const interrupted = createStreamTiming(0)
  interrupted.observe({ type: 'message_start' }, 100)
  interrupted.observe({ type: 'content_block_delta', delta: { text: 'partial' } }, 200)
  assert.equal(interrupted.snapshot().generationMs, null)
})

test('omitted thinking and generated tool names establish real first content', () => {
  for (const event of [
    { type: 'content_block_delta', delta: { type: 'thinking_delta', estimated_tokens: 50 } },
    { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'Read' } },
  ]) {
    const timing = createStreamTiming(100)
    timing.observe(event, 500)
    assert.equal(timing.snapshot().ttftMs, 400)
  }
})
