/**
 * E2E: local backup — manual create/list/download/restore/config,
 * automatic scheduled backup (boot catch-up), retention pruning.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'
import { startBackupApiKernel } from '../fixtures/backup-api-kernel.mjs'
import { startBackupS3 } from '../fixtures/backup-s3.mjs'

test('manual backup → download → mutate → restore rolls back', async (t) => {
  // disable auto backup so record counts stay deterministic
  const kernel = await startBackupApiKernel(t)
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1', KIN_API_KERNEL_SOCK: kernel.socket } })
  try {
    // state to protect
    const k1 = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'kept' } })
    assert.equal(k1.status, 201)
    const endpoint = await api(gw, 'POST', '/api/panel/api-endpoints', {
      body: {
        name: 'offline fixture',
        kind: 'custom',
        protocol: 'anthropic',
        base_url: 'https://backup.invalid',
        api_key_entries: [{ api_key: 'sk-fictitious-backup' }],
        models: [{ name: 'upstream-fixture', alias: 'claude-haiku-4-5-20251001' }],
      },
    })
    assert.equal(endpoint.status, 201, endpoint.text)
    const inferenceKey = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'inference fixture', category: 'api' },
    })
    assert.equal(inferenceKey.status, 201, inferenceKey.text)

    // 1. create backup
    const b = await api(gw, 'POST', '/api/panel/backups')
    assert.equal(b.status, 201, b.text)
    const rec = b.json.item
    assert.equal(rec.status, 'ok')
    assert.equal(rec.kind, 'manual')
    assert.ok(rec.size_bytes > 0)
    assert.ok(rec.includes.vms >= 1, 'vm files included')

    // 2. list
    const list = await api(gw, 'GET', '/api/panel/backups')
    assert.equal(list.status, 200)
    assert.ok(list.json.items.some((x) => x.id === rec.id))
    assert.equal(list.json.config.enabled, false) // env disabled
    assert.equal(list.json.restoring, false)

    // 3. download and verify the archive is a valid tar.gz containing the db
    const res = await fetch(`${gw.baseUrl}/api/panel/backups/${rec.id}/download`, {
      headers: { authorization: `Bearer ${gw.apiKey}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/gzip')
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.length, rec.size_bytes)
    // gzip magic
    assert.equal(buf[0], 0x1f)
    assert.equal(buf[1], 0x8b)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-dl-'))
    fs.writeFileSync(path.join(tmp, 'a.tar.gz'), buf)
    const tar = spawnSync('tar', ['-xzf', path.join(tmp, 'a.tar.gz'), '-C', tmp])
    assert.equal(tar.status, 0)
    assert.ok(fs.existsSync(path.join(tmp, 'db', 'kin.db')))
    assert.ok(fs.existsSync(path.join(tmp, 'manifest.json')))
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 2)
    fs.rmSync(tmp, { recursive: true, force: true })

    // 4. mutate state after the backup
    const k2 = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'lost-after-restore' } })
    assert.equal(k2.status, 201)

    // 5. restore requires confirm
    const noConfirm = await api(gw, 'POST', `/api/panel/backups/${rec.id}/restore`, { body: {} })
    assert.equal(noConfirm.status, 400)
    assert.equal(noConfirm.json.error.code, 'confirm_required')

    const restored = await api(gw, 'POST', `/api/panel/backups/${rec.id}/restore`, { body: { confirm: true } })
    assert.equal(restored.status, 200, restored.text)
    assert.equal(restored.json.restored, rec.id)
    assert.ok(restored.json.pre_restore, 'pre_restore snapshot id returned')

    // 6. state rolled back — kept key survives, later key is gone
    const keys = await api(gw, 'GET', '/api/panel/api-keys')
    const names = (keys.json.keys || []).map((k) => k.name)
    assert.ok(names.includes('kept'))
    assert.ok(!names.includes('lost-after-restore'))

    // gateway still serves inference after restore
    const m = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${inferenceKey.json.item.key}` },
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'after-restore' }],
      },
    })
    assert.equal(m.status, 200, m.text)
    assert.equal(kernel.requests.at(-1).body.model, 'upstream-fixture')
    assert.equal(kernel.requests.at(-1).headers['x-api-key'], 'sk-fictitious-backup')

    // The pre_restore archive is the safety net, without a duplicate full DB.
    assert.equal(
      fs.readdirSync(path.join(gw.project, 'data')).some((name) => name.includes('.restore-')),
      false,
    )

    // ledger after restore still shows the pre_restore snapshot (undo path)
    const after = await api(gw, 'GET', '/api/panel/backups')
    assert.ok(
      after.json.items.some((x) => x.id === restored.json.pre_restore && x.kind === 'pre_restore'),
      'pre_restore record visible in panel after restore',
    )
  } finally {
    await gw.stop()
  }
})

test('restore rebinds billing, API scheduler, and routing config without restart', async (t) => {
  const kernel = await startBackupApiKernel(t)
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1', KIN_API_KERNEL_SOCK: kernel.socket } })
  try {
    const routingBefore = await api(gw, 'PUT', '/api/panel/routing', {
      body: {
        compatibility: { cache_ttl: '5m' },
        failover: { max_total_attempts: 2 },
      },
    })
    assert.equal(routingBefore.status, 200, routingBefore.text)

    const endpointBefore = await api(gw, 'POST', '/api/panel/api-endpoints', {
      body: {
        name: 'before-restore',
        kind: 'custom',
        protocol: 'anthropic',
        base_url: 'https://before.invalid',
        api_key_entries: [{ api_key: 'sk-before-restore-secret' }],
        models: [{ name: 'claude-haiku-4-5-20251001', alias: 'claude-haiku-4-5-20251001' }],
      },
    })
    assert.equal(endpointBefore.status, 201, endpointBefore.text)
    const endpointBeforeId = endpointBefore.json.item.id

    const keyResponse = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'api-model-catalog', category: 'api' },
    })
    assert.equal(keyResponse.status, 201, keyResponse.text)
    const apiKey = keyResponse.json.item.key

    const dbPath = path.join(gw.project, 'data', 'kin.db')
    const beforeDb = new DatabaseSync(dbPath)
    beforeDb.prepare('UPDATE groups SET rate_multiplier = 0 WHERE id = 1').run()
    beforeDb.close()

    const backup = await api(gw, 'POST', '/api/panel/backups')
    assert.equal(backup.status, 201, backup.text)
    const backupId = backup.json.item.id

    const afterDb = new DatabaseSync(dbPath)
    afterDb.prepare('UPDATE groups SET rate_multiplier = 2 WHERE id = 1').run()
    afterDb.close()
    assert.equal((await api(gw, 'DELETE', `/api/panel/api-endpoints/${endpointBeforeId}`)).status, 200)
    const endpointAfter = await api(gw, 'POST', '/api/panel/api-endpoints', {
      body: {
        name: 'after-restore',
        base_url: 'https://after.invalid',
        api_key_entries: [{ api_key: 'sk-after-restore-secret' }],
        models: [{ name: 'upstream-after', alias: 'mutated-model' }],
      },
    })
    assert.equal(endpointAfter.status, 201, endpointAfter.text)
    const routingAfter = await api(gw, 'PUT', '/api/panel/routing', {
      body: {
        compatibility: { cache_ttl: '1h' },
        failover: { max_total_attempts: 12 },
      },
    })
    assert.equal(routingAfter.status, 200, routingAfter.text)

    const restored = await api(gw, 'POST', `/api/panel/backups/${backupId}/restore`, {
      body: { confirm: true },
    })
    assert.equal(restored.status, 200, restored.text)

    const routing = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(routing.status, 200, routing.text)
    assert.equal(routing.json.data.compatibility.cache_ttl, '5m')
    assert.equal(routing.json.data.failover.max_total_attempts, 2)

    const models = await api(gw, 'GET', '/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(models.status, 200, models.text)
    const modelIds = (models.json.data || []).map((model) => model.id)
    assert.ok(modelIds.includes('claude-haiku-4-5-20251001'))
    assert.ok(!modelIds.includes('mutated-model'))

    const requestId = `restore-rebind-${Date.now()}`
    const inference = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-request-id': requestId, authorization: `Bearer ${apiKey}` },
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'after runtime rebind' }],
      },
    })
    assert.equal(inference.status, 200, inference.text)
    assert.equal(kernel.requests.at(-1).body.model, 'claude-haiku-4-5-20251001')
    assert.equal(kernel.requests.at(-1).headers['x-api-key'], 'sk-before-restore-secret')
    const logs = await api(gw, 'GET', `/api/panel/request-logs?q=${requestId}&limit=10`)
    assert.equal(logs.status, 200, logs.text)
    const row = (logs.json.items || []).find((item) => item.request_id === requestId)
    assert.ok(row, 'request after restore must persist through the rebound log store')
    assert.equal(row.rate_multiplier, 0)
    assert.ok(row.total_cost > 0, 'the offline response uses a priced model and nonzero token usage')
    assert.equal(row.actual_cost, 0)
  } finally {
    await gw.stop()
  }
})

test('backup config get/update via panel', async () => {
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const g = await api(gw, 'GET', '/api/panel/backups/config')
    assert.equal(g.status, 200)
    assert.equal(g.json.config.interval_hours, 24)
    assert.equal(g.json.config.retention, 7)

    const put = await api(gw, 'PUT', '/api/panel/backups/config', {
      body: { interval_hours: 6, retention: 3 },
    })
    assert.equal(put.status, 200, put.text)
    assert.equal(put.json.config.interval_hours, 6)
    assert.equal(put.json.config.retention, 3)

    const bad = await api(gw, 'PUT', '/api/panel/backups/config', { body: { retention: 0 } })
    assert.equal(bad.status, 400)
  } finally {
    await gw.stop()
  }
})

test('bucket panel seals secrets, restricts access and restores after the local ledger is lost', async (t) => {
  const fixture = await startBackupS3(t)
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const saved = await api(gw, 'PUT', '/api/panel/backups/storage', { body: fixture.config })
    assert.equal(saved.status, 200, saved.text)
    const config = await api(gw, 'GET', '/api/panel/backups/storage')
    assert.equal(config.json.storage.has_encryption_password, true)
    for (const name of ['access_key', 'secret_key', 'encryption_password']) {
      assert.equal(config.json.storage[name], undefined)
      assert.ok(!config.text.includes(fixture.config[name]))
    }
    assert.equal((await api(gw, 'POST', '/api/panel/backups/storage/test', { body: {} })).status, 200)
    assert.equal(
      (
        await api(gw, 'POST', '/api/panel/users', {
          body: { username: 'backup-reader', password: 'fixture-password', role: 'user' },
        })
      ).status,
      201,
    )
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'backup-reader', password: 'fixture-password' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    await login.arrayBuffer()
    for (const [method, endpoint] of [
      ['GET', '/storage'],
      ['PUT', '/storage'],
      ['GET', '/remote'],
      ['POST', '/remote/restore'],
      ['POST', '/bak_fixture/upload'],
    ]) {
      const denied = await fetch(gw.baseUrl + '/api/panel/backups' + endpoint, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      })
      assert.equal(denied.status, 403)
      await denied.arrayBuffer()
    }
    assert.equal((await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'before-cloud-backup' } })).status, 201)
    const backup = await api(gw, 'POST', '/api/panel/backups')
    assert.equal(backup.status, 201, backup.text)
    assert.equal(backup.json.item.file_path, null)
    assert.equal(backup.json.item.upload_status, 'uploaded')
    assert.equal((await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'after-cloud-backup' } })).status, 201)
    const db = new DatabaseSync(path.join(gw.project, 'data/kin.db'))
    db.exec('DELETE FROM backup_records')
    db.close()
    assert.deepEqual((await api(gw, 'GET', '/api/panel/backups')).json.items, [])
    const remote = await api(gw, 'GET', '/api/panel/backups/remote')
    assert.equal(remote.status, 200, remote.text)
    const item = remote.json.items.find((r) => r.id === backup.json.item.id)
    assert.ok(item)
    assert.equal(
      (await api(gw, 'POST', '/api/panel/backups/remote/restore', { body: { index_key: item.index_key } })).status,
      400,
    )
    const restored = await api(gw, 'POST', '/api/panel/backups/remote/restore', {
      body: { index_key: item.index_key, confirm: true },
    })
    assert.equal(restored.status, 200, restored.text)
    const keys = (await api(gw, 'GET', '/api/panel/api-keys')).json.keys.map((k) => k.name)
    assert.ok(keys.includes('before-cloud-backup'))
    assert.ok(!keys.includes('after-cloud-backup'))
    assert.equal(fs.readdirSync(path.join(gw.project, 'data/backups')).length, 0)
  } finally {
    await gw.stop()
  }
})

test('automatic scheduled backup runs at boot catch-up (default enabled)', async () => {
  // default schedule is enabled; boot catch-up timer fires ~5s after start
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '0' } })
  try {
    let items = []
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const list = await api(gw, 'GET', '/api/panel/backups')
      items = list.json.items || []
      if (items.some((x) => x.kind === 'scheduled' && x.status === 'ok')) break
    }
    const auto = items.find((x) => x.kind === 'scheduled' && x.status === 'ok')
    assert.ok(auto, 'scheduled backup should run automatically after boot')
    assert.ok(fs.existsSync(auto.file_path))
    // next_auto_at now points ~interval ahead
    const list = await api(gw, 'GET', '/api/panel/backups')
    assert.ok(list.json.next_auto_at, 'next auto backup scheduled')
    assert.ok(Date.parse(list.json.next_auto_at) > Date.now() + 3600_000)
  } finally {
    await gw.stop()
  }
})

test('delete backup removes record + file', async () => {
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const b = await api(gw, 'POST', '/api/panel/backups')
    const rec = b.json.item
    const del = await api(gw, 'DELETE', `/api/panel/backups/${rec.id}`)
    assert.equal(del.status, 200)
    assert.equal(fs.existsSync(rec.file_path), false)
    const list = await api(gw, 'GET', '/api/panel/backups')
    assert.ok(!list.json.items.some((x) => x.id === rec.id))
  } finally {
    await gw.stop()
  }
})
