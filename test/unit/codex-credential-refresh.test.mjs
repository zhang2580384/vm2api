import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureCodexCredential } from '../../src/lib/oauth/codex-credential-refresh.mjs'
import {
  readCodexAccounts,
  upsertCodexAccount,
  summarizeCodexSlot,
  codexAccessExpiresAt,
} from '../../src/lib/vm/codex-slot.mjs'
import { needsScheduledRefresh } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { buildVmList, buildVmDetail } from '../../src/lib/admin/panel-api.mjs'

const jwt = (body) => `e30.${Buffer.from(JSON.stringify(body)).toString('base64url')}.sig`
function slot(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = 'vm-01'
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      status: 'running',
      proxy: { host: '127.0.0.1', port: 1080 },
      codex: {},
    }),
  )
  upsertCodexAccount(root, id, {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Date.now() - 1000,
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_subscription_active_until: '2026-11-22T08:00:00Z' } }),
    ...patch,
  })
  return { root, id, read: () => readCodexAccounts(root, id)[0] }
}
const rotated = {
  ok: true,
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  expires_at: Date.now() + 86400_000,
}

test('scheduled rotation persists new tokens and retains subscription when response omits id_token', async (t) => {
  const s = slot(t)
  const result = await ensureCodexCredential(s.root, s.id, { refresh: async () => rotated })
  assert.equal(result.refreshed, true)
  assert.equal(s.read().refresh_token, 'new-refresh')
  assert.equal(s.read().chatgpt_subscription_active_until, '2026-11-22T08:00:00Z')
  assert.ok(s.read().refreshed_at)
  assert.ok(!JSON.stringify(result).includes('new-access'))
  assert.ok(!JSON.stringify(result).includes('new-refresh'))
})

test('fresh access JWT with no explicit expiry is skipped instead of continuously rotating', async (t) => {
  const exp = Math.floor(Date.now() / 1000) + 86400
  const s = slot(t, { access_token: jwt({ exp }), expires_at: 0 })
  const result = await ensureCodexCredential(s.root, s.id, { refresh: () => assert.fail('unnecessary refresh') })
  assert.equal(result.refresh_class, 'already_fresh')
  assert.equal(summarizeCodexSlot(s.root, { id: s.id }).expires_at, exp * 1000)
  assert.equal(codexAccessExpiresAt({ expires_at: '2026-11-22T08:00:00Z' }), Date.parse('2026-11-22T08:00:00Z'))
})

test('concurrent manual and scheduled refresh rotate the grant once', async (t) => {
  const s = slot(t)
  let calls = 0
  const refresh = async () => {
    calls++
    await Promise.resolve()
    return rotated
  }
  const results = await Promise.all([
    ensureCodexCredential(s.root, s.id, { force: true, refresh }),
    ensureCodexCredential(s.root, s.id, { force: true, refresh }),
  ])
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.refreshed).length, 1)
})

test('explicit refresh can run while resting without enabling scheduling; background refresh still skips', async (t) => {
  const s = slot(t)
  const file = path.join(s.root, 'vms', `${s.id}.json`)
  const vm = JSON.parse(fs.readFileSync(file))
  fs.writeFileSync(file, JSON.stringify({ ...vm, schedulable: false }))
  const skipped = await ensureCodexCredential(s.root, s.id, {
    refresh: () => assert.fail('background refresh must skip'),
  })
  assert.equal(skipped.refresh_class, 'skipped')
  const explicit = await ensureCodexCredential(s.root, s.id, {
    force: true,
    allowResting: true,
    refresh: async () => rotated,
  })
  assert.equal(explicit.refreshed, true)
  assert.equal(JSON.parse(fs.readFileSync(file)).schedulable, false)
})

test('an account imported during refresh is never overwritten', async (t) => {
  const s = slot(t)
  const result = await ensureCodexCredential(s.root, s.id, {
    refresh: async () => {
      upsertCodexAccount(
        s.root,
        s.id,
        { access_token: 'import-access', refresh_token: 'import-refresh' },
        { replaceCredentials: true },
      )
      return rotated
    },
  })
  assert.equal(result.refreshed, false)
  assert.equal(s.read().refresh_token, 'import-refresh')
})

test('temporary failures retry while revoked grants wait for new authorization', async (t) => {
  const s = slot(t)
  const temporary = await ensureCodexCredential(s.root, s.id, {
    refresh: async () => ({ ok: false, error: 'timeout' }),
  })
  assert.equal(temporary.refresh_class, 'retryable')
  assert.equal(s.read().refresh_error, undefined)
  const fatal = await ensureCodexCredential(s.root, s.id, {
    refresh: async () => ({ ok: false, error: 'invalid_grant' }),
  })
  assert.equal(fatal.refresh_class, 'fatal')
  const state = summarizeCodexSlot(s.root, { id: s.id })
  assert.equal(needsScheduledRefresh(state), false)
  upsertCodexAccount(s.root, s.id, { refresh_token: 'reauthorized' }, { replaceCredentials: true })
  assert.equal(s.read().refresh_error, undefined)
})

test('Codex scheduler enters refresh window ten minutes before expiry', () => {
  const now = Date.now()
  assert.equal(needsScheduledRefresh({ platform: 'openai', expires_at: now + 9 * 60_000 }, now), true)
  assert.equal(needsScheduledRefresh({ platform: 'openai', expires_at: now + 11 * 60_000 }, now), false)
})

test('public list and detail retain subscription and automatic-refresh metadata without tokens', async (t) => {
  const s = slot(t)
  const cfg = { paths: { project: s.root }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const accountQuota = { config: {}, snapshot: () => ({ accounts: [] }) }
  const list = await buildVmList({ cfg, accountQuota, routingConfig: { credential_refresh: { enabled: true } } })
  const detail = await buildVmDetail({ cfg, accountQuota, id: s.id, slotProcessStatus: () => ({}) })
  for (const vm of [list.data.items[0], detail.data.vm]) {
    assert.equal(vm.chatgpt_subscription_active_until, '2026-11-22T08:00:00Z')
    assert.equal(vm.auto_refresh_enabled, true)
    assert.ok(!JSON.stringify(vm).includes('old-access'))
    assert.ok(!JSON.stringify(vm).includes('old-refresh'))
  }
})
