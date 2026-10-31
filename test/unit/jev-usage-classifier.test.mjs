import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyJev } from '../../src/lib/protocol/jev-intercept.mjs'
import { installJevUsageRecorder, jevKeyFingerprint } from '../../src/lib/protocol/jev-usage.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
const config = (extra) => ({
  enabled: true,
  provider: 'jev',
  base_url: 'https://api.typesafe.ai',
  model: 'jev-latest',
  dedup_sec: 0,
  api_keys: ['synthetic-usage-key'],
  max_state_chars: 16000,
  ...extra,
})
function capture(t) {
  const events = []
  installJevUsageRecorder((e) => events.push(e))
  t.after(() => installJevUsageRecorder(null))
  return events
}
const success = () =>
  new Response(
    JSON.stringify({
      model: 'jev-1.14.0',
      answers: { safety: { noul: 0.99 } },
      usage: { input_tokens: 123, output_tokens: 20 },
    }),
    { status: 200 },
  )
test('real classifier success records reported tokens and only a key fingerprint', async (t) => {
  const events = capture(t)
  await classifyJev(
    'Explain neutral interface spacing.',
    config({ policy_request_id: 'request-fixture-1' }),
    async () => success(),
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].input_tokens, 123)
  assert.equal(events[0].outcome, 'success')
  assert.equal(events[0].key_fingerprint, jevKeyFingerprint('synthetic-usage-key'))
  assert.equal(events[0].request_id, 'request-fixture-1')
  assert.ok(!JSON.stringify(events).includes('synthetic-usage-key'))
  assert.ok(!JSON.stringify(events).includes('neutral interface'))
})
test('cache hits do not invent additional billable calls', async (t) => {
  const events = capture(t)
  let calls = 0
  const cfg = config({ dedup_sec: 60, api_keys: ['synthetic-cache-usage-key'] })
  const fetch = async () => {
    calls++
    return success()
  }
  await classifyJev('Neutral cache usage sample.', cfg, fetch)
  await classifyJev('Neutral cache usage sample.', cfg, fetch)
  assert.equal(calls, 1)
  assert.equal(events.length, 1)
})
test('402 and failed transport are visible with unknown usage', async (t) => {
  const events = capture(t)
  await classifyJev(
    'Neutral HTTP sample.',
    config({ api_keys: ['synthetic-billing-key'] }),
    async () => new Response('{}', { status: 402 }),
  )
  await classifyJev('Neutral network sample.', config({ api_keys: ['synthetic-network-key'] }), async () => {
    throw new Error('synthetic network failure')
  })
  assert.equal(events.length, 2)
  assert.equal(events[0].http_status, 402)
  assert.equal(events[0].input_tokens, null)
  assert.equal(events[0].estimated_cost_nano_usd, null)
  assert.equal(events[1].http_status, null)
})
test('the provider usage endpoint is not exposed to non-admin panel roles', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/jev-usage', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/jev-usage', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/jev-usage', 'super').ok, false)
})

test('usage persistence failure cannot turn a valid model decision into a request failure', async (t) => {
  installJevUsageRecorder(() => {
    throw new Error('synthetic disk failure')
  })
  t.after(() => installJevUsageRecorder(null))
  const verdict = await classifyJev(
    'Explain neutral menu spacing.',
    config({ api_keys: ['synthetic-storage-failure'] }),
    async () => success(),
  )
  assert.equal(verdict.action, 'pass')
})
test('an unavailable response followed by a successful attempt records both actual requests', async (t) => {
  const events = capture(t)
  let calls = 0
  await classifyJev(
    'Explain neutral panel spacing.',
    config({ api_keys: ['synthetic-attempt-a', 'synthetic-attempt-b'] }),
    async () => (++calls === 1 ? new Response('{}', { status: 429 }) : success()),
  )
  assert.equal(calls, 2)
  assert.equal(events.length, 2)
  assert.equal(events[0].http_status, 429)
  assert.equal(events[1].http_status, 200)
  assert.notEqual(events[0].key_fingerprint, events[1].key_fingerprint)
})
