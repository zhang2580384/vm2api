import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotVmConnectivity } from '../../src/lib/admin/vm-connectivity.mjs'
import {
  createNotifyMonitor,
  detectPoolNotifyEvents,
  dispatchNotify,
  formatNotifyMessage,
  normalizeNotifyConfig,
} from '../../src/lib/admin/notify.mjs'

const config = () =>
  normalizeNotifyConfig({
    enabled: true,
    events: { digest: false, pool_empty: false, pool_low: false, revoked: false, invalid: false },
  })
const pool = (vms) => ({ at: '2026-10-28T12:00:00Z', available: 1, with_token: 1, vms })
const vm = (id, online, reason = null) => ({ id, online, reason, node_id: 'node-1' })

test('connectivity uses scheduler node links and kernel faults without credential or quota gates', () => {
  const rows = snapshotVmConnectivity(
    [
      { id: 'node-slot', status: 'running', node_id: 'lost-node' },
      { id: 'kernel-slot', status: 'running' },
      { id: 'quota-slot', status: 'running', has_token: false, cooldown_reason: 'provider_overloaded' },
      { id: 'dead-slot', status: 'dead' },
      { id: 'unknown-slot', status: 'unknown' },
      { id: 'stopped-on-lost-node', status: 'stopped', node_id: 'lost-node' },
    ],
    { nodeReady: (v) => v.node_id !== 'lost-node', faults: new Map([['kernel-slot', 'restart budget exhausted']]) },
  )
  assert.equal(rows[0].reason, 'node_offline')
  assert.equal(rows[1].reason, 'kernel_faulted')
  assert.equal(rows[1].detail, 'restart budget exhausted')
  assert.equal(rows[2].online, true)
  assert.equal(rows[3].reason, 'runtime_dead')
  assert.equal(rows[4].online, null)
  assert.equal(rows[5].reason, 'runtime_stopped')
})

test('manual shutdowns and maintenance do not produce connectivity alarms', () => {
  const rows = snapshotVmConnectivity(
    [
      { id: 'manual', status: 'stopped', schedule_off: true },
      { id: 'maintenance', status: 'stopped', schedule_hold: { reason: 'maintenance' } },
      { id: 'disabled', status: 'disabled' },
    ],
    { nodeReady: () => false, faults: new Map() },
  )
  assert.ok(rows.every((row) => row.online === null && row.monitored === false))
})

test('outages are transitions, with startup alerts for failed links and kernel faults only', () => {
  const failed = pool([
    vm('a', false, 'node_offline'),
    vm('b', false, 'kernel_faulted'),
    vm('c', false, 'runtime_stopped'),
  ])
  assert.deepEqual(
    detectPoolNotifyEvents(null, failed, config()).map((e) => e.id),
    ['a', 'b'],
  )
  assert.equal(detectPoolNotifyEvents(failed, failed, config()).length, 0)
  assert.equal(detectPoolNotifyEvents(pool([vm('c', true)]), failed, config()).length, 3)
  const disabled = config()
  disabled.events.vm_down = false
  assert.equal(detectPoolNotifyEvents(null, failed, disabled).length, 0)
})

test('different VM outages within the global cooldown each deliver once', async () => {
  let rows = [vm('a', true), vm('b', true)]
  const sent = []
  const monitor = createNotifyMonitor({
    config: config(),
    snapshot: () => pool([]),
    vmSnapshot: () => rows,
    send: async (_message, event) => {
      sent.push(event.id)
      return { ok: true }
    },
  })
  await monitor.runOnce()
  rows = [vm('a', false, 'node_offline'), vm('b', false, 'node_offline')]
  await monitor.runOnce()
  await monitor.runOnce()
  assert.deepEqual(sent, ['a', 'b'])
  rows = [vm('a', true), vm('b', false, 'node_offline')]
  await monitor.runOnce()
  rows = [vm('a', false, 'kernel_faulted'), vm('b', false, 'node_offline')]
  await monitor.runOnce()
  assert.deepEqual(sent, ['a', 'b', 'a'])
})

test('partial delivery retries only the failed channel on the next interval', async () => {
  const deliveries = []
  const monitor = createNotifyMonitor({
    config: config(),
    snapshot: () => pool([vm('a', false, 'node_offline')]),
    send: async (_message, _event, extra) => {
      deliveries.push(extra.channels)
      return deliveries.length === 1
        ? {
            ok: true,
            results: [
              { channel: 'telegram', ok: true },
              { channel: 'wecom', ok: false, error: 'timeout' },
            ],
          }
        : { ok: true, results: [{ channel: 'wecom', ok: true }] }
    },
  })
  const first = await monitor.runOnce()
  assert.equal(first.dispatched[0].ok, false)
  assert.equal(monitor.getStatus().last_error, 'timeout')
  await monitor.runOnce()
  await monitor.runOnce()
  assert.deepEqual(deliveries, [null, ['wecom']])
  assert.equal(monitor.getStatus().last_error, null)
})

test('delivery exceptions retry but a recovered or removed VM cancels pending alerts', async () => {
  let rows = [vm('a', false, 'node_offline')]
  let calls = 0
  const monitor = createNotifyMonitor({
    config: config(),
    snapshot: () => pool(rows),
    send: async () => {
      calls++
      throw new Error('network failure')
    },
  })
  await monitor.runOnce()
  await monitor.runOnce()
  assert.equal(calls, 2)
  rows = [vm('a', true)]
  await monitor.runOnce()
  assert.equal(calls, 2)
  rows = [vm('a', false, 'node_offline')]
  await monitor.runOnce()
  rows = []
  await monitor.runOnce()
  assert.equal(calls, 3)
})

test('unknown observations preserve the previous known state without a false recovery', async () => {
  let rows = [vm('a', true)]
  const sent = []
  const monitor = createNotifyMonitor({
    config: config(),
    snapshot: () => pool([]),
    vmSnapshot: () => rows,
    send: async (_message, event) => {
      sent.push(event.id)
      return { ok: true }
    },
  })
  await monitor.runOnce()
  rows = [vm('a', null)]
  await monitor.runOnce()
  rows = [vm('a', false, 'node_offline')]
  await monitor.runOnce()
  rows = [vm('a', null)]
  await monitor.runOnce()
  rows = [vm('a', false, 'node_offline')]
  await monitor.runOnce()
  assert.deepEqual(sent, ['a'])
})

test('dispatch routes an outage to both Telegram and WeCom and honors retry channel selection', async () => {
  const cfg = normalizeNotifyConfig({
    enabled: true,
    telegram: { enabled: true, bot_token: 'test-token', chat_id: 'test-chat' },
    wecom: { enabled: true, webhook: 'test-key' },
  })
  const message = formatNotifyMessage(
    { type: 'vm_down', id: 'a', node_id: 'node-1', reason: 'node_offline' },
    pool([]),
    cfg,
  )
  assert.match(message.text, /VM \/ 节点下线/)
  assert.match(message.text, /节点 node-1/)
  assert.match(message.text, /node_offline/)
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    return { ok: true, text: async () => JSON.stringify({ ok: true, errcode: 0 }) }
  }
  const result = await dispatchNotify(cfg, message, { fetch: fetchImpl })
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.results.map((row) => row.channel),
    ['telegram', 'wecom'],
  )
  urls.length = 0
  const retry = await dispatchNotify(cfg, message, { fetch: fetchImpl, channels: ['wecom'] })
  assert.equal(retry.ok, true)
  assert.deepEqual(
    retry.results.map((row) => row.channel),
    ['wecom'],
  )
  assert.equal(urls.length, 1)
  assert.match(urls[0], /qyapi.weixin.qq.com/)
})
