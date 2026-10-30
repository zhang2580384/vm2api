import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { queryCodexAccountStatus } from '../../src/lib/oauth/codex-account-status.mjs'
import { summarizeOpenaiAccountStatus, openaiAccountObservation } from '../../src/lib/oauth/openai-account-status.mjs'
import { readCodexAccounts, summarizeCodexSlot, upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'
import { refreshCodexAccessToken } from '../../src/lib/protocol/codex-models.mjs'
import { buildVmList, buildVmDetail } from '../../src/lib/admin/panel-api.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const NOW = Date.parse('2026-10-30T00:00:00Z')
const jwt = (payload) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`
function fixture(t, { resting = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-status-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = 'vm-status-fixture'
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      schedulable: !resting,
      proxy: { host: '127.0.0.1', port: 1080 },
      codex: {},
    }),
  )
  upsertCodexAccount(root, id, {
    access_token: 'fixture-access-secret',
    refresh_token: 'fixture-refresh-secret',
    id_token: jwt({
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'prolite',
        chatgpt_subscription_active_until: '2026-10-01T00:00:00Z',
      },
    }),
    expires_at: Date.now() + 86400_000,
  })
  return { root, id, read: () => readCodexAccounts(root, id)[0] }
}
const response = (status, payload) => ({ status, json: async () => payload })

test('credential dates alone never establish current paid status, nor equate access expiry with subscription expiry', () => {
  const base = {
    access_token: 'at',
    chatgpt_plan_type: 'pro',
    chatgpt_subscription_active_until: '2026-11-17T00:00:00Z',
    expires_at: NOW - 1,
  }
  const view = summarizeOpenaiAccountStatus(base, {}, NOW)
  assert.equal(view.subscription_status, 'claim_active')
  assert.equal(view.credential_status, 'expired')
  assert.equal(view.stale, true)
})

test('explicit query uses only wham/usage, works while resting and confirms renewed Pro over an old JWT date', async (t) => {
  const s = fixture(t, { resting: true })
  const calls = []
  const result = await queryCodexAccountStatus({
    projectRoot: s.root,
    vmId: s.id,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return response(200, {
        plan_type: 'prolite',
        rate_limit: { allowed: true, limit_reached: false },
        secret: 'untrusted',
      })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.account_status.subscription_status, 'paid')
  assert.equal(result.account_status.credential_status, 'valid')
  assert.equal(result.account_status.usage_allowed, true)
  assert.equal(result.account_status.plan_type, 'prolite')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-access-secret')
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'vms', `${s.id}.json`))).schedulable, false)
  assert.equal(s.read().refresh_token, 'fixture-refresh-secret')
  assert.doesNotMatch(JSON.stringify(result), /fixture-access-secret|fixture-refresh-secret|untrusted|credential_stamp/)
})

test('a successful Free response overrides old paid claims without claiming a cancellation date', async (t) => {
  const s = fixture(t)
  const r = await queryCodexAccountStatus({
    projectRoot: s.root,
    vmId: s.id,
    fetchImpl: async () => response(200, { plan_type: 'free' }),
  })
  assert.equal(r.account_status.subscription_status, 'free')
  assert.equal(r.account_status.plan_type, 'free')
})

test('401, CF 403, rate limit and 503 do not declare subscription expired or disable scheduling', async (t) => {
  for (const status of [401, 403, 429, 503]) {
    const s = fixture(t)
    const result = await queryCodexAccountStatus({
      projectRoot: s.root,
      vmId: s.id,
      fetchImpl: async () => response(status, { error: { message: 'private upstream data' } }),
    })
    assert.equal(result.ok, false)
    assert.notEqual(result.account_status.subscription_status, 'paid')
    assert.equal(result.account_status.stale, true)
    assert.equal(result.account_status.credential_status, status === 401 ? 'rejected' : 'unverified')
    assert.doesNotMatch(JSON.stringify(result), /private upstream data/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'vms', `${s.id}.json`))).schedulable, true)
  }
})

test('a failed query keeps the prior successful plan and time as stale history', async (t) => {
  const s = fixture(t)
  await queryCodexAccountStatus({
    projectRoot: s.root,
    vmId: s.id,
    fetchImpl: async () => response(200, { plan_type: 'pro' }),
  })
  const checked = s.read().account_status.last_success_at
  const failed = await queryCodexAccountStatus({
    projectRoot: s.root,
    vmId: s.id,
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(failed.account_status.plan_type, 'pro')
  assert.equal(failed.account_status.last_success_at, checked)
  assert.equal(failed.account_status.stale, true)
})

test('unending connection and unending response body terminate without late credential writes', async (t) => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => ({ status: 200, json: () => new Promise(() => {}) }),
  ]) {
    const s = fixture(t)
    const result = await queryCodexAccountStatus({ projectRoot: s.root, vmId: s.id, fetchImpl, timeoutMs: 20 })
    assert.equal(result.error.code, 'timeout')
    assert.equal(result.status, 504)
    assert.equal(result.account_status.stale, true)
    assert.equal(s.read().access_token, 'fixture-access-secret')
  }
})

test('an actual HTTP peer sending headers then stalling is aborted during OAuth body reading', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const { default: fetch } = await import('node-fetch')
  let signal
  const tok = await refreshCodexAccessToken({
    refreshToken: 'fixture-rt',
    timeoutMs: 50,
    fetchImpl: (_url, init) => {
      signal = init.signal
      return fetch(`http://127.0.0.1:${server.address().port}/token`, init)
    },
  })
  assert.equal(tok.error, 'timeout')
  assert.equal(signal.aborted, true)
})

test('concurrent state queries coalesce and account replacement invalidates in-flight results', async (t) => {
  const s = fixture(t)
  let release
  let calls = 0
  const fetchImpl = () => {
    calls++
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const a = queryCodexAccountStatus({ projectRoot: s.root, vmId: s.id, fetchImpl })
  const b = queryCodexAccountStatus({ projectRoot: s.root, vmId: s.id, fetchImpl })
  assert.equal(a, b)
  assert.equal(calls, 1)
  upsertCodexAccount(
    s.root,
    s.id,
    { access_token: 'replacement', chatgpt_account_id: 'different-fixture' },
    { replaceCredentials: true },
  )
  release(response(200, { plan_type: 'pro' }))
  assert.equal((await a).error.code, 'account_changed')
  assert.equal(s.read().account_status, undefined)
})

test('successful observations expire and are invalidated by credential rotation', () => {
  const a = { access_token: 'at', expires_at: NOW + 86400_000 }
  a.account_status = openaiAccountObservation(a, { status: 200, payload: { plan_type: 'pro' }, now: NOW })
  assert.equal(summarizeOpenaiAccountStatus(a, {}, NOW).subscription_status, 'paid')
  assert.equal(summarizeOpenaiAccountStatus(a, {}, NOW + 16 * 60_000).stale, true)
  assert.equal(summarizeOpenaiAccountStatus({ ...a, access_token: 'rotated' }, {}, NOW).last_success_at, null)
})

test('a usage response without a plan cannot confirm the plan from an old credential', () => {
  const a = { access_token: 'at', chatgpt_plan_type: 'pro' }
  a.account_status = openaiAccountObservation(a, { status: 200, payload: {}, now: NOW })
  assert.equal(summarizeOpenaiAccountStatus(a, {}, NOW).subscription_status, 'unknown')
})

test('a successful Access query takes precedence over old expiry metadata and Refresh rejection', () => {
  const account = { access_token: 'fixture-access', expires_at: NOW - 1000, refresh_error: 'invalid_grant' }
  account.account_status = openaiAccountObservation(account, { status: 200, payload: { plan_type: 'pro' }, now: NOW })
  assert.equal(summarizeOpenaiAccountStatus(account, {}, NOW).credential_status, 'valid')
  assert.equal(account.refresh_error, 'invalid_grant')
})

test('refresh forbidden by a gateway is retryable while explicit grant revocation is fatal', async () => {
  const cf = await refreshCodexAccessToken({ refreshToken: 'fixture-rt', fetchImpl: async () => response(403, null) })
  assert.equal(cf.error, 'refresh_forbidden')
  const revoked = await refreshCodexAccessToken({
    refreshToken: 'fixture-rt',
    fetchImpl: async () => response(400, { error: 'invalid_grant' }),
  })
  assert.equal(revoked.error, 'invalid_grant')
})

test('the panel account-status route returns and persists an offline response without credentials', async (t) => {
  const s = fixture(t)
  let reply
  let calls = 0
  const handler = createPanelHandler({
    cfg: { paths: { project: s.root } },
    routingConfig: {},
    requireAuth: (req) => {
      Object.assign(req, { apiKeyKind: 'master', panelRole: 'admin' })
      return true
    },
    fetchImpl: async () => {
      calls++
      return response(200, { plan_type: 'prolite', rate_limit: { allowed: true } })
    },
    json: (_res, status, body) => {
      reply = { status, body }
      return true
    },
  })
  await handler(
    { method: 'POST', headers: {} },
    {},
    new URL(`http://localhost/api/panel/vms/${s.id}/oauth/account-status`),
  )
  assert.equal(reply.status, 200)
  assert.equal(reply.body.data.account_status.subscription_status, 'paid')
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(reply), /fixture-access-secret|fixture-refresh-secret|credential_stamp/)
})

test('manual refresh without a Refresh Token remains a client error and does not change credentials', async (t) => {
  const s = fixture(t)
  upsertCodexAccount(s.root, s.id, { access_token: 'fixture-access-only' }, { replaceCredentials: true })
  let reply
  const handler = createPanelHandler({
    cfg: { paths: { project: s.root } },
    routingConfig: {},
    requireAuth: (req) => {
      Object.assign(req, { apiKeyKind: 'master', panelRole: 'admin' })
      return true
    },
    json: (_res, status, body) => {
      reply = { status, body }
      return true
    },
  })
  await handler({ method: 'POST', headers: {} }, {}, new URL(`http://localhost/api/panel/vms/${s.id}/oauth/refresh`))
  assert.equal(reply.status, 400)
  assert.equal(reply.body.error.code, 'missing_refresh_token')
  assert.equal(s.read().access_token, 'fixture-access-only')
})

test('list/detail carry only redacted observations and tenant guards reject foreign queries before network access', async (t) => {
  const s = fixture(t)
  await queryCodexAccountStatus({
    projectRoot: s.root,
    vmId: s.id,
    fetchImpl: async () => response(200, { plan_type: 'pro' }),
  })
  const cfg = { paths: { project: s.root }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const accountQuota = { config: {}, snapshot: () => ({ accounts: [] }) }
  const list = await buildVmList({ cfg, accountQuota })
  const detail = await buildVmDetail({ cfg, accountQuota, id: s.id, slotProcessStatus: () => ({}) })
  for (const vm of [list.data.items[0], detail.data.vm]) {
    assert.equal(vm.openai_account_status.subscription_status, 'paid')
    assert.doesNotMatch(
      JSON.stringify(vm.openai_account_status),
      /fixture-access-secret|fixture-refresh-secret|credential_stamp/,
    )
  }
  let reply
  const handler = createPanelHandler({
    cfg,
    routingConfig: {},
    requireAuth: (req) => {
      Object.assign(req, { panelUser: 'tenant', panelRole: 'user', panelUserId: 'foreign-tenant' })
      return true
    },
    json: (_res, status, body) => {
      reply = { status, body }
      return true
    },
  })
  await handler(
    { method: 'POST', headers: {} },
    {},
    new URL(`http://localhost/api/panel/vms/${s.id}/oauth/account-status`),
  )
  assert.equal(reply.status, 404)
  assert.equal(summarizeCodexSlot(s.root, { id: s.id }).account_status.subscription_status, 'paid')
})
