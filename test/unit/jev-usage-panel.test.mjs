/** Actual local handler regression; synthetic data only, no listener or upstream requests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { JevUsageRepo } from '../../src/lib/db/repos/jev-usage-repo.mjs'
import { normalizeJevUsage } from '../../src/lib/protocol/jev-usage.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

test('JEV actual panel route enforces roles, sanitization and pagination', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-usage-panel-'))
  t.after(() => {
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir)
  const passed = []
  openDatabase({ dataDir })
  const repo = new JevUsageRepo()
  for (const extra of [{}, { http_status: 402, outcome: 'http_error', usage: null }]) {
    repo.record(
      normalizeJevUsage({
        provider: 'jev',
        model: 'jev-1.14.0',
        official_typesafe: true,
        key_fingerprint: 'abcdef123456',
        request_id: 'isolated-panel-fixture',
        http_status: 200,
        outcome: 'success',
        usage: { input_tokens: 281, output_tokens: 20 },
        api_key: 'DO_NOT_EXPOSE_SYNTHETIC_KEY',
        state: 'DO_NOT_EXPOSE_SYNTHETIC_BODY',
        ...extra,
      }),
    )
  }
  async function request(identity, suffix = '') {
    const response = {}
    const handler = createPanelHandler({
      cfg: { paths: { project: tmp } },
      routingConfig: {},
      requireAuth(req) {
        if (identity === null) {
          response.status = 401
          return false
        }
        Object.assign(req, identity)
        return true
      },
      json(_res, status, body) {
        Object.assign(response, { status, body })
        return true
      },
    })
    await handler({ method: 'GET' }, {}, new URL('http://localhost/api/panel/jev-usage' + suffix))
    return response
  }
  assert.equal((await request(null)).status, 401)
  passed.push('unauthenticated rejected')
  for (const role of ['user', 'super']) {
    assert.equal((await request({ panelUser: 'isolated-user', panelRole: role })).status, 403)
    passed.push(role + ' cannot read global ledger')
  }
  assert.equal((await request({ apiKeyKind: 'managed' })).status, 403)
  passed.push('managed protocol credential cannot read panel')
  const admin = { panelUser: 'isolated-admin', panelRole: 'admin' }
  const result = await request(admin)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.data.total.requests, 2)
  assert.equal(result.body.data.total.successful, 1)
  assert.equal(result.body.data.total.unknown_usage_requests, 1)
  assert.equal(result.body.data.rows.length, 2)
  assert.equal(result.body.data.rows.find((row) => row.http_status === 402).estimated_cost_nano_usd, null)
  assert.ok(!JSON.stringify(result.body).includes('DO_NOT_EXPOSE_'))
  passed.push('admin sees exact totals, unknowns and sanitized rows')
  assert.equal((await request({ apiKeyKind: 'master' })).status, 200)
  passed.push('existing master-key admin identity supported')
  const first = await request(admin, '?limit=1')
  assert.equal(first.body.data.rows.length, 1)
  assert.equal(first.body.data.has_more, true)
  const cursor = first.body.data.next_cursor
  const next = await request(
    admin,
    '?' + new URLSearchParams({ limit: '1', cursor_created_at: cursor.created_at, cursor_id: cursor.id }),
  )
  assert.equal(next.body.data.rows.length, 1)
  assert.notEqual(next.body.data.rows[0].id, first.body.data.rows[0].id)
  passed.push('actual route cursor pages have no duplicate')
  assert.equal((await request(admin, '?cursor_id=invalid')).status, 400)
  assert.equal((await request(admin, '?key_fingerprint=invalid')).status, 400)
  passed.push('malformed cursor and key filter rejected')
  const missing = await request(admin, '?key_fingerprint=000000000000')
  assert.equal(missing.body.data.rows.length, 0)
  assert.equal(missing.body.data.total.requests, 2)
  passed.push('filter does not alter global totals')
  assert.equal(passed.length, 9)
})
