import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildNativeTelemetry,
  telemetryEgressSnapshot,
  telemetryFactHash,
  writeVmProxyTelemetryEgress,
} from '../../src/lib/vm/native-telemetry.mjs'

const vm = {
  id: 'vm-claude',
  proxy: { id: 'px-1', host: '127.0.0.1', port: 1080, scheme: 'socks5' },
}
const geo = {
  ip: '203.0.113.10',
  timezone: 'Asia/Tokyo',
  country: 'Japan',
  country_code: 'JP',
  checked_at: '2020-01-01T00:00:00.000Z',
}

test('proxy geo overwrites a failed telemetry egress stub', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-telemetry-egress-'))
  const file = path.join(root, 'vms', vm.id, 'cli-home', '.claude', 'telemetry', 'egress.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ vm_id: vm.id, binding: 'old', error: 'telemetry_geo_failed', checked_at: 0 }))
  try {
    const now = 1_700_000_000_000
    const written = writeVmProxyTelemetryEgress(root, vm, geo, now)
    assert.equal(written.wrote, true)
    assert.equal(written.overwritten, true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const projection = buildNativeTelemetry(vm, root, { telemetry: {} })
    assert.equal(projection.proxy_url, '')
    assert.equal(projection.proxy_required, false)
    const binding = telemetryFactHash([projection.proxy_id, '', false])
    assert.equal(saved.binding, binding)
    assert.equal(saved.epoch, telemetryFactHash([binding, geo.ip]))
    assert.equal(saved.ip, geo.ip)
    assert.equal(saved.timezone, 'Asia/Tokyo')
    assert.equal(saved.error, null)
    assert.equal(saved.checked_at, now)
    assert.equal(telemetryEgressSnapshot(vm, { ...geo, error: 'geo_lookup_failed' }, now), null)
    assert.equal(writeVmProxyTelemetryEgress(root, vm, null, now).reason, 'proxy_geo_unavailable')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
