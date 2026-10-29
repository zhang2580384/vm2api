import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMailboxStore, mailboxError, normalizeMicrosoftEmail } from '../../src/lib/oauth/codex-mailbox-store.mjs'
import { createCodexMailboxService } from '../../src/lib/oauth/codex-mailbox-service.mjs'
import { recordMailboxAuthFailure } from '../../src/lib/oauth/codex-mailbox-events.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

process.env.VM2API_DB_SECRET = 'mailbox-unit-test-only-key'
const email = 'test@outlook.com',
  password = 'test-only-password'
const jwt = (e = email) => `x.${Buffer.from(JSON.stringify({ email: e })).toString('base64url')}.x`
const tokens = (e = email) => ({ access_token: jwt(e), refresh_token: 'test-refresh', id_token: jwt(e) })
function harness(t, opts = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-test-'))
  const store = createMailboxStore(projectRoot)
  const vm = {
    id: 'vm-01',
    platform: 'openai',
    status: 'running',
    schedulable: true,
    proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 },
  }
  const calls = []
  let clock = Date.now()
  const account = { access_token: jwt(), refresh_token: 'test-refresh', expires_at: clock - 1 }
  store.save(vm.id, { email, password })
  const service = createCodexMailboxService({
    projectRoot,
    store,
    getSlot: () => vm,
    accountFor: () => account,
    now: () => clock,
    checkNetwork: async () => calls.push('network'),
    runSlot: async ({ action }) => {
      calls.push(action)
      return { callback: 'http://localhost:1455/auth/callback?code=mock&state=test-state' }
    },
    generate: () => ({ session_id: 'test', auth_url: 'https://auth.openai.com/oauth/authorize?state=test-state' }),
    exchange: async () => {
      calls.push('exchange')
      return tokens()
    },
    commit: async () => {
      calls.push('commit')
    },
    refresh: async () => {
      calls.push('refresh')
      return { ok: true }
    },
    ...opts,
  })
  t.after(async () => {
    service.stop()
    await service.settle()
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })
  return {
    projectRoot,
    store,
    service,
    vm,
    calls,
    account,
    advance: (ms) => {
      clock += ms
    },
  }
}

test('snapshot refuses an active browser and blocks every browser entry until released', async (t) => {
  const h = harness(t, {
    runSlot: async ({ action, signal }) => {
      if (action === 'prepare') return { ok: true }
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { ok: true }
    },
  })
  h.service.remote('vm-01')
  await new Promise(setImmediate)
  assert.equal(h.service.busy, true)
  assert.throws(() => h.service.beginSnapshot(), { code: 'backup_browser_busy' })
  h.service.cancel('vm-01')
  await h.service.settle()
  assert.equal(h.service.busy, false)

  h.service.beginSnapshot()
  for (const start of [
    () => h.service.start('vm-01'),
    () => h.service.remote('vm-01'),
    () => h.service.register('vm-01', 'fixture@example.invalid', { id: 'fixture-owner' }),
    () => h.service.runtime('vm-01', 'install'),
  ])
    assert.throws(start, { code: 'service_stopped' })
  for (const start of [
    () => h.service.runtimeStatus('vm-01'),
    () => h.service.session('vm-01'),
    () => h.service.subscription('vm-01'),
  ])
    await assert.rejects(start(), { code: 'service_stopped' })
  h.calls.length = 0
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  h.service.endSnapshot()
  assert.equal(h.service.start('vm-01').state.running, true)
  await new Promise(setImmediate)
  h.service.cancel('vm-01')
  await h.service.settle()
})

test('snapshot refuses an in-flight refresh tick even when no browser has started', async (t) => {
  let finishRefresh
  const h = harness(t, {
    refresh: () =>
      new Promise((resolve) => {
        finishRefresh = resolve
      }),
  })
  h.store.save('vm-01', { email, password, auto_reauthorize: true, login_armed: true })
  const ticking = h.service.tick()
  assert.equal(h.service.busy, true)
  assert.throws(() => h.service.beginSnapshot(), { code: 'backup_browser_busy' })
  finishRefresh({ ok: true })
  await ticking
  assert.equal(h.service.busy, false)
  h.service.beginSnapshot()
  h.service.endSnapshot()
})

test('remote clipboard is explicit, validated, and absent from status and persisted state', async (t) => {
  const clipboard = 'offline-clipboard-service-fixture'
  let lastControl
  const h = harness(t, {
    runSlot: async ({ action, onControl, onEvent, signal }) => {
      if (action === 'prepare') return { ok: true }
      onControl((message) => {
        lastControl = message
        onEvent({ event: 'rpc', id: message.id, ok: true, data: { text: clipboard } })
      })
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { ok: true }
    },
  })
  h.service.remote('vm-01')
  await new Promise(setImmediate)
  assert.equal(lastControl, undefined)
  assert.throws(() => h.service.control('vm-01', { op: 'clipboard', text: 'unexpected' }), /invalid_browser_operation/)
  assert.deepEqual(await h.service.control('vm-01', { op: 'clipboard' }), { text: clipboard })
  assert.equal(lastControl.op, 'clipboard')
  assert.ok(!JSON.stringify(h.service.status('vm-01')).includes(clipboard))
  for (const name of fs.readdirSync(path.join(h.projectRoot, 'data/codex-mailbox'))) {
    assert.ok(!fs.readFileSync(path.join(h.projectRoot, 'data/codex-mailbox', name), 'utf8').includes(clipboard))
  }
})

test('runtime maintenance never generates OAuth or uses account credentials and shares the browser job lock', async (t) => {
  let complete
  const operations = []
  const h = harness(t, {
    manageRuntime: async ({ action, onStage }) => {
      operations.push(action)
      if (action === 'status') return { supported: true, installed: false }
      onStage('installing_browser_runtime')
      await new Promise((resolve) => {
        complete = resolve
      })
      return { supported: true, installed: action === 'install', verified: true }
    },
  })
  h.store.remove('vm-01')
  assert.equal((await h.service.runtimeStatus('vm-01')).installed, false)
  assert.equal(h.service.runtime('vm-01', 'install').running, true)
  await new Promise(setImmediate)
  assert.throws(() => h.service.start('vm-01'), /mailbox_login_busy/)
  assert.throws(() => h.service.remote('vm-01'), /mailbox_login_busy/)
  assert.equal((await h.service.runtimeStatus('vm-01')).stage, 'installing_browser_runtime')
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  complete()
  await h.service.settle()
  assert.equal((await h.service.runtimeStatus('vm-01')).running, false)
  assert.deepEqual(operations, ['status', 'install', 'status'])
  h.vm.schedulable = false
  assert.equal((await h.service.runtimeStatus('vm-01')).installed, false)
  assert.equal(h.service.runtime('vm-01', 'uninstall').running, true)
  await new Promise(setImmediate)
  complete()
  await h.service.settle()
  assert.equal(h.vm.schedulable, false)
  assert.deepEqual(h.calls, [])
})

test('a delayed status probe cannot overwrite active browser maintenance progress', async (t) => {
  let finishProbe, finishInstall
  const h = harness(t, {
    manageRuntime: async ({ action, onStage }) => {
      if (action === 'status')
        return new Promise((resolve) => {
          finishProbe = resolve
        })
      onStage('installing_browser_runtime')
      return new Promise((resolve) => {
        finishInstall = resolve
      })
    },
  })
  const probe = h.service.runtimeStatus('vm-01')
  h.service.runtime('vm-01', 'install')
  await new Promise(setImmediate)
  finishProbe({ installed: false })
  assert.equal((await probe).running, true)
  assert.equal((await h.service.runtimeStatus('vm-01')).stage, 'installing_browser_runtime')
  finishInstall({ installed: true })
  await h.service.settle()
})

test('mailbox password and email encrypted at rest; summary never returns secret', (t) => {
  const h = harness(t)
  const disk = fs.readFileSync(path.join(h.projectRoot, 'data/codex-mailbox/vm-01.login.json'), 'utf8')
  assert.ok(!disk.includes(password))
  assert.ok(!disk.includes(email))
  assert.match(disk, /enc:v1:/)
  assert.equal(h.store.read('vm-01').password, password)
  assert.ok(!JSON.stringify(h.service.status('vm-01')).includes(password))
  assert.equal(h.store.summary('vm-01').has_password, true)
  assert.deepEqual(h.store.ids(), ['vm-01'])
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(h.projectRoot, 'data/codex-mailbox/vm-01.login.json')).mode & 0o777, 0o600)
})
test('password may be retained only for same email; traversal and invalid domains rejected', (t) => {
  const h = harness(t)
  h.store.save('vm-01', { email: email.toUpperCase(), password: '' })
  assert.equal(h.store.read('vm-01').password, password)
  assert.throws(() => h.store.save('vm-01', { email: 'other@outlook.com' }), /mailbox_password_required/)
  assert.throws(() => h.store.read('../escape'), /invalid_vm_id/)
  assert.throws(() => normalizeMicrosoftEmail('test@example.com'), /microsoft_email_required/)
})
test('saving requires encryption; wrong encryption key cannot read credentials', (t) => {
  const h = harness(t),
    old = process.env.VM2API_DB_SECRET
  try {
    delete process.env.VM2API_DB_SECRET
    assert.throws(() => h.store.save('vm-01', { email, password }), /mailbox_encryption_required/)
    process.env.VM2API_DB_SECRET = 'wrong-key'
    assert.throws(() => h.store.read('vm-01'), /mailbox_decryption_failed/)
  } finally {
    process.env.VM2API_DB_SECRET = old
  }
})
test('disabled slot stays idle automatically but allows explicit login without enabling scheduling', async (t) => {
  const h = harness(t)
  h.vm.schedulable = false
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  assert.throws(() => h.service.start('vm-01', { automatic: true }), /slot_resting/)
  assert.deepEqual(h.calls, [])
  h.service.start('vm-01')
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.status, 'succeeded', h.service.status('vm-01').state.error_code)
  assert.equal(h.vm.schedulable, false)
  h.calls.length = 0
  await h.service.tick()
  assert.deepEqual(h.calls, [])
})
test('auto-off, stopped and fresh accounts stay idle', async (t) => {
  const h = harness(t)
  h.store.save('vm-01', { email, password, auto_reauthorize: false })
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  h.store.save('vm-01', { email, password })
  h.account.expires_at = Date.now() + 3600_000
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  h.service.stop()
  h.account.expires_at = 1
  await h.service.tick()
  assert.deepEqual(h.calls, [])
})
test('normal token refresh precedes browser login', async (t) => {
  const h = harness(t)
  await h.service.tick()
  assert.deepEqual(h.calls, ['refresh'])
})
test('transient refresh error does not launch browser', async (t) => {
  const h = harness(t, { refresh: async () => ({ ok: false, refresh_class: 'retryable' }) })
  await h.service.tick()
  await h.service.settle()
  assert.deepEqual(h.calls, [])
})
test('fatal refresh falls back to slot browser and commits same email', async (t) => {
  const h = harness(t, { refresh: async () => ({ ok: false, refresh_class: 'fatal' }) })
  await h.service.tick()
  await h.service.settle()
  assert.deepEqual(h.calls, ['network', 'prepare', 'network', 'login', 'exchange', 'commit'])
  assert.equal(h.service.status('vm-01').state.status, 'succeeded', h.service.status('vm-01').state.error_code)
  assert.ok(!JSON.stringify(h.service.status('vm-01')).includes(password))
})
test('401 signals force refreshing otherwise fresh credentials', async (t) => {
  let force
  const h = harness(t, {
    refresh: async (_id, f) => {
      force = f
      return { ok: true }
    },
  })
  h.account.expires_at = Date.now() + 3600_000
  recordMailboxAuthFailure(h.projectRoot, 'vm-01')
  await h.service.tick()
  assert.equal(force, true)
})
test('mismatched email and OAuth state cannot replace credentials', async (t) => {
  for (const mismatch of ['email', 'state']) {
    const h = harness(
      t,
      mismatch === 'email'
        ? { exchange: async () => tokens('other@outlook.com') }
        : { runSlot: async () => ({ callback: 'http://localhost:1455/auth/callback?code=mock&state=wrong' }) },
    )
    h.service.start('vm-01')
    await h.service.settle()
    assert.ok(!h.calls.includes('commit'))
    assert.equal(
      h.service.status('vm-01').state.error_code,
      mismatch === 'email' ? 'authorized_email_mismatch' : 'oauth_state_mismatch',
    )
  }
})
test('captcha pauses retries; ordinary failures apply backoff', async (t) => {
  for (const code of ['captcha_required', 'email_code_timeout']) {
    let attempts = 0
    const h = harness(t, {
      runSlot: async () => {
        attempts++
        throw mailboxError(code)
      },
    })
    h.account.refresh_error = 'invalid_grant'
    h.service.start('vm-01')
    await h.service.settle()
    await h.service.tick()
    assert.equal(attempts, 1)
    assert.equal(h.service.status('vm-01').state.status, code === 'captcha_required' ? 'needs_attention' : 'failed')
    h.advance(3600_001)
    await h.service.tick()
    await h.service.settle()
    assert.equal(attempts, code === 'captcha_required' ? 1 : 2)
  }
})
test('disable mid-login aborts slot job and prevents exchange/commit', async (t) => {
  let started
  const ready = new Promise((r) => {
    started = r
  })
  const h = harness(t, {
    runSlot: ({ signal }) =>
      new Promise((_resolve, reject) => {
        started()
        signal.addEventListener('abort', () => reject(mailboxError('login_cancelled')), { once: true })
      }),
  })
  h.service.start('vm-01')
  await ready
  h.vm.schedulable = false
  h.service.guardJobs()
  await h.service.settle()
  assert.equal(h.service.status('vm-01').state.status, 'cancelled')
  assert.ok(!h.calls.includes('exchange'))
  assert.ok(!h.calls.includes('commit'))
})
test('deleting config during a job prevents stale credentials from being committed', async (t) => {
  let finish
  const h = harness(t, {
    runSlot: async () =>
      new Promise((r) => {
        finish = r
      }),
  })
  h.service.start('vm-01')
  await new Promise((r) => setImmediate(r))
  h.service.remove('vm-01')
  finish({ ok: true })
  await h.service.settle()
  assert.equal(h.store.read('vm-01'), null)
  assert.equal(h.store.state('vm-01'), null)
  assert.ok(!h.calls.includes('commit'))
})
test('stopping service while refresh awaits cannot start a new login', async (t) => {
  let finish
  const h = harness(t, {
    refresh: () =>
      new Promise((r) => {
        finish = r
      }),
  })
  const pending = h.service.tick()
  h.service.stop()
  finish({ ok: false, refresh_class: 'fatal' })
  await pending
  assert.deepEqual(h.calls, [])
})
test('mailbox management respects existing panel roles', () => {
  const p = '/api/panel/vms/vm-01/oauth/microsoft-mailbox'
  for (const [method, suffix] of [
    ['GET', ''],
    ['POST', ''],
    ['POST', '/start'],
    ['POST', '/verify'],
    ['POST', '/cancel'],
    ['DELETE', ''],
  ]) {
    assert.equal(authorizePanelRoute(method, p + suffix, 'admin').ok, true)
    assert.equal(authorizePanelRoute(method, p + suffix, 'user').ok, true)
    if (method !== 'GET') assert.equal(authorizePanelRoute(method, p + suffix, 'super').ok, false)
  }
})

for (const reason of ['no_credential', 'oauth_invalid_grant', 'credential_refresh_failed', 'proxy_desynced']) {
  for (const off of [false, true]) {
    test(`explicit browser authorization repairs ${reason} with operator off=${off}`, async (t) => {
      let h
      h = harness(t, { commit: null, getSlot: () => getVm(h.projectRoot, 'vm-01') })
      const record = {
        ...h.vm,
        status: 'paused',
        schedulable: false,
        schedule_off: off,
        unschedulable: { reason },
        schedule_hold: { reason: 'maintenance', detail: { tag: 'fixture' } },
      }
      fs.mkdirSync(path.join(h.projectRoot, 'vms', 'vm-01'), { recursive: true })
      const file = path.join(h.projectRoot, 'vms', 'vm-01.json')
      fs.writeFileSync(file, JSON.stringify(record))
      await h.service.tick()
      assert.deepEqual(h.calls, [])
      assert.throws(() => h.service.start('vm-01', { automatic: true }), /slot_resting/)
      h.service.start('vm-01')
      await h.service.settle()
      assert.equal(h.service.status('vm-01').state.status, 'succeeded', h.service.status('vm-01').state.error_code)
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(saved.schedule_off, off)
      assert.equal(saved.unschedulable?.reason, reason === 'proxy_desynced' ? reason : undefined)
      assert.equal(saved.schedule_hold.reason, 'maintenance')
      assert.equal(saved.schedulable, false)
      assert.equal(saved.codex.has_access, true)
      h.calls.length = 0
      await h.service.tick()
      assert.deepEqual(h.calls, [])
    })
  }
}

test('successful native authorization saves credentials without uninstalling and keeps the slot resting', async (t) => {
  const sequence = []
  const h = harness(t, {
    runSlot: async ({ action, payload }) => {
      if (action === 'prepare') return { ok: true }
      assert.equal(payload.native, true)
      return { callback: 'http://localhost:1455/auth/callback?code=mock&state=test-state', native: true }
    },
    commit: async () => sequence.push('commit'),
    manageRuntime: async ({ action }) => {
      sequence.push(action)
      return { installed: false }
    },
  })
  h.vm.schedulable = false
  h.service.start('vm-01')
  await h.service.settle()
  assert.deepEqual(sequence, ['commit'])
  assert.equal(h.service.status('vm-01').state.status, 'succeeded')
  assert.equal(h.store.summary('vm-01').configured, true)
  assert.equal(h.vm.schedulable, false)
})

test('authorized native window stays controllable until explicit close, then supports manual uninstall', async (t) => {
  let authorized
  const ready = new Promise((resolve) => {
    authorized = resolve
  })
  const actions = []
  const h = harness(t, {
    runSlot: async ({ action, payload, onCallback, onControl, onEvent, signal }) => {
      if (action === 'prepare') return { ok: true }
      assert.equal(payload.keep_open, true)
      onControl((request) => {
        onEvent({ event: 'rpc', id: request.id, ok: true, data: { ok: true } })
      })
      await onCallback({ callback: 'http://localhost:1455/auth/callback?code=mock&state=test-state', native: true })
      authorized()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      throw mailboxError('login_cancelled', 409)
    },
    manageRuntime: async ({ action }) => {
      actions.push(action)
      return { installed: action !== 'uninstall', supported: true }
    },
  })
  h.vm.schedulable = false
  h.service.start('vm-01')
  await ready
  const active = h.service.status('vm-01')
  assert.equal(active.state.status, 'succeeded')
  assert.equal(active.state.running, false)
  assert.equal(active.browser.active, true)
  assert.equal(active.browser.ready, true)
  assert.equal(active.browser.retained, true)
  h.service.guardJobs()
  assert.equal(h.service.status('vm-01').browser.ready, true)
  assert.deepEqual(await h.service.control('vm-01', { op: 'navigate', url: 'https://chatgpt.com/api/auth/session' }), {
    ok: true,
  })
  assert.throws(() => h.service.runtime('vm-01', 'uninstall'), /mailbox_login_busy/)
  assert.throws(() => h.service.save('vm-01', { email, password }), /mailbox_login_busy/)
  assert.deepEqual(actions, [])
  h.service.cancel('vm-01')
  await h.service.settle()
  const state = h.service.status('vm-01').state
  assert.equal(state.status, 'succeeded')
  assert.equal(state.error_code, null)
  assert.equal(state.browser_error_code, null)
  assert.equal(h.service.status('vm-01').browser.active, false)
  assert.equal(h.store.summary('vm-01').configured, true)
  assert.equal(h.store.summary('vm-01').login_armed, true)
  assert.equal(h.vm.schedulable, false)
  assert.deepEqual(actions, [])
  h.service.runtime('vm-01', 'uninstall')
  await h.service.settle()
  assert.deepEqual(actions, ['uninstall'])
  assert.equal(h.store.summary('vm-01').configured, true)
  assert.equal(h.store.summary('vm-01').login_armed, true)
})

test('late browser cleanup errors preserve credentials committed by the live callback', async (t) => {
  const h = harness(t, {
    runSlot: async ({ action, onCallback }) => {
      if (action === 'prepare') return { ok: true }
      await onCallback({ callback: 'http://localhost:1455/auth/callback?code=mock&state=test-state', native: true })
      throw Object.assign(mailboxError('browser_closed', 502), {
        resource_cleanup_error_code: 'browser_resources_failed',
      })
    },
  })
  h.service.start('vm-01')
  await h.service.settle()
  const state = h.service.status('vm-01').state
  assert.equal(state.status, 'succeeded')
  assert.equal(state.error_code, null)
  assert.equal(state.browser_error_code, 'browser_closed')
  assert.equal(state.cleanup_error_code, 'browser_resources_failed')
  assert.equal(h.calls.filter((action) => action === 'commit').length, 1)
})

test('resource cleanup warning commits authorization and defers uninstalling a possibly live browser', async (t) => {
  const h = harness(t, {
    runSlot: async ({ action }) =>
      action === 'prepare'
        ? { ok: true }
        : {
            callback: 'http://localhost:1455/auth/callback?code=mock&state=test-state',
            native: true,
            resource_cleanup_error_code: 'browser_resources_failed',
          },
    manageRuntime: async () => {
      throw new Error('must not uninstall before resource cleanup completes')
    },
  })
  h.service.start('vm-01')
  await h.service.settle()
  assert.ok(h.calls.includes('commit'))
  const state = h.service.status('vm-01').state
  assert.equal(state.status, 'succeeded')
  assert.equal(state.error_code, null)
  assert.equal(state.cleanup_error_code, 'browser_resources_failed')
})

test('soft-paused slot supports manual browser maintenance; stopped runtime is still rejected', async (t) => {
  const h = harness(t, { manageRuntime: async () => ({ installed: true }) })
  h.vm.status = 'paused'
  h.vm.schedule_off = true
  h.vm.schedulable = false
  assert.equal((await h.service.runtimeStatus('vm-01')).installed, true)
  h.vm.runtime = { stopped: true }
  assert.throws(() => h.service.start('vm-01'), /slot_not_running/)
  await assert.rejects(h.service.runtimeStatus('vm-01'), /slot_not_running/)
  assert.deepEqual(h.calls, [])
})
