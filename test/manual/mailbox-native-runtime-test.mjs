/** Actual slot supervisor + native callback + Docker resource lease, offline only. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dockerJson, localDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { runMailboxSlotProcess } from '../../src/lib/oauth/codex-mailbox-runtime.mjs'
import { BROWSER_MEMORY_BYTES } from '../../src/lib/oauth/mailbox-browser-resources.mjs'

const [projectRoot, container] = process.argv.slice(2)
assert.equal(process.env.VM2API_NATIVE_OFFLINE_FIXTURE, '1', 'Explicit offline fixture opt-in is required')
assert.match(container || '', /^vm2api-native-fixture-[a-zA-Z0-9_.-]+$/)
assert.ok(path.isAbsolute(projectRoot))
const connect = localDocker()
const prefix = '/containers/' + encodeURIComponent(container)
const before = await dockerJson(connect, { path: prefix + '/json' })
assert.equal(before.HostConfig.NetworkMode, 'none', 'Never use an existing or networked slot')
assert.equal(before.HostConfig.ReadonlyRootfs, true)
const vm = { id: 'vm-05', runtime: { container }, locale: 'ja_JP.UTF-8', timezone: 'Asia/Tokyo' }
await runMailboxSlotProcess({ projectRoot, vm, action: 'prepare' })
console.log('PASS offline supervisor preparation')

let send, ready
const started = new Promise((resolve) => {
  ready = resolve
})
let callbackReady
const authorized = new Promise((resolve) => {
  callbackReady = resolve
})
let ended = false
const pending = new Map()
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 70_000)
const task = runMailboxSlotProcess({
  projectRoot,
  vm,
  action: 'login',
  signal: controller.signal,
  payload: {
    native: true,
    keep_open: true,
    email: 'fixture@example.invalid',
    state: 'native-runtime-fixture',
    auth_url: 'https://auth.openai.com/oauth/authorize?state=native-runtime-fixture',
  },
  onStage: (stage) => {
    console.log('offline browser stage:', stage)
    if (stage === 'native_manual_login') ready()
  },
  onCallback: (value) => {
    assert.equal(value.native, true)
    assert.match(value.callback, /code=fictional/)
    console.log('PASS offline live callback delivered')
    callbackReady()
  },
  onControl: (value) => {
    send = value
  },
  onEvent: (event) => {
    const request = pending.get(event.id)
    if (!request) return
    pending.delete(event.id)
    event.ok ? request.resolve(event.data) : request.reject(new Error(event.error_code))
  },
})
task.catch(() => {})
task
  .finally(() => {
    ended = true
  })
  .catch(() => {})
function control(op, data = {}) {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, op, ...data })
  })
}
try {
  await Promise.race([
    started,
    task.then(() => {
      throw new Error('Browser ended before readiness')
    }),
  ])
  const active = await dockerJson(connect, { path: prefix + '/json' })
  assert.ok(active.HostConfig.Memory >= BROWSER_MEMORY_BYTES)
  console.log('PASS native browser started with temporary resource budget')
  // Deliver the fictional callback through the actual loopback HTTP listener.
  // Desktop input is tested after authorization, independently of startup focus.
  await promisify(execFile)('docker', [
    'exec',
    '-u',
    '10005:987',
    container,
    'python3',
    '-c',
    'import urllib.request; assert urllib.request.urlopen("http://localhost:1455/auth/callback?state=native-runtime-fixture&code=fictional", timeout=5).status == 200',
  ])
  await Promise.race([
    authorized,
    task.then(() => {
      throw new Error('Browser exited before callback')
    }),
  ])
  await delay(300)
  assert.equal(ended, false, 'Authorization must keep the same browser process open')
  const retained = await dockerJson(connect, { path: prefix + '/json' })
  assert.ok(retained.HostConfig.Memory >= BROWSER_MEMORY_BYTES)
  const frame = await control('frame')
  assert.equal(frame.mime, 'image/png')
  assert.ok(frame.image.length > 1000)
  await control('key', { key: 'Control+l' })
  await control('key', { key: 'Control+a' })
  await control('text', { text: 'retained browser fictional clipboard' })
  await control('key', { key: 'Control+a' })
  await control('key', { key: 'Control+c' })
  await delay(150)
  assert.equal((await control('clipboard')).text, 'retained browser fictional clipboard')
  controller.abort()
  await assert.rejects(task, { code: 'login_cancelled' })
  const restored = await dockerJson(connect, { path: prefix + '/json' })
  assert.equal(restored.HostConfig.Memory, before.HostConfig.Memory)
  assert.equal(restored.HostConfig.MemorySwap, before.HostConfig.MemorySwap)
  assert.equal(restored.HostConfig.NanoCpus, before.HostConfig.NanoCpus)
  assert.ok(restored.HostConfig.CpuQuota <= 0)
  assert.equal(fs.existsSync(path.join(projectRoot, 'data/browser-resource-leases/vm-05.json')), false)
  const top = await dockerJson(connect, { path: prefix + '/top?ps_args=-eo%20pid,stat,comm' })
  assert.ok(
    !(top.Processes || []).some((row) => !row[1]?.startsWith('Z') && /^(chrome|chromium|Xvfb)/.test(row[2] || '')),
  )
  console.log(
    JSON.stringify({
      native_slot_supervisor_callback: 'passed',
      retained_window_and_clipboard: 'passed',
      manual_close: 'passed',
      resource_restore: 'passed',
      live_browser_processes: 0,
      real_accounts_used: false,
      network: 'none',
    }),
  )
} finally {
  clearTimeout(timeout)
  controller.abort()
  await task.catch(() => {})
}
