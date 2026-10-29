import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, createDatabase, getDb, isDbOpen, openDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { configuredDnsEmptyTypes, configuredDnsUpstream, configuredDomainForward } from '../../src/lib/vm/egress.mjs'
import { runFleetUpdateWithDatabase } from '../../src/lib/vm/fleet-cli.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-cli-'))
  const dataDir = path.join(root, 'data')
  const db = createDatabase({ dataDir })
  db.prepare('INSERT INTO proxies (id, domain_forward) VALUES (?, ?)').run('px-fixture', 1)
  new SettingsRepo(db).set('proxy_pool_config', {
    dns_primary: 'https://cloudflare-dns.com/dns-query',
    dns_disable_svcb_https: true,
  })
  db.close()
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(
    path.join(root, 'vms/vm-01.json'),
    JSON.stringify({
      id: 'vm-01',
      status: 'running',
      runtime: { type: 'docker', worker: 'go' },
      proxy: { id: 'px-fixture', domain_forward: false, url: 'socks5h://192.0.2.1:1080' },
    }),
  )
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dataDir }
}

test('standalone fleet maintenance restores saved domain and DNS settings before touching services', async (t) => {
  const { root } = fixture(t)
  assert.equal(isDbOpen(), false)
  assert.equal(configuredDomainForward({ id: 'px-fixture', domain_forward: false }), false)
  assert.equal(configuredDnsUpstream(), '')
  let calls = 0
  const report = await runFleetUpdateWithDatabase(root, {
    action: 'telemetry',
    telemetryFn: async ({ vm }) => {
      calls++
      assert.equal(configuredDomainForward(vm.proxy), true)
      assert.match(configuredDnsUpstream(), /^https:\/\/cloudflare-dns\.com\/dns-query,/)
      assert.deepEqual(configuredDnsEmptyTypes(), [64, 65])
      return { ok: true }
    },
  })
  assert.equal(calls, 1)
  assert.equal(report.failed_count, 0)
  assert.equal(isDbOpen(), false)
})

test('standalone fleet closes its database after a service failure', async (t) => {
  const { root } = fixture(t)
  const report = await runFleetUpdateWithDatabase(root, {
    action: 'telemetry',
    telemetryFn: async () => {
      throw new Error('fixture service failure')
    },
  })
  assert.equal(report.failed_count, 1)
  assert.equal(isDbOpen(), false)
})

test('an unfinished restore blocks fleet maintenance before any service is changed', async (t) => {
  const { root, dataDir } = fixture(t)
  fs.writeFileSync(path.join(dataDir, 'backup-restore-pending.json'), '{}')
  let calls = 0
  await assert.rejects(
    runFleetUpdateWithDatabase(root, {
      action: 'telemetry',
      telemetryFn: async () => {
        calls++
        return { ok: true }
      },
    }),
    /备份恢复/,
  )
  assert.equal(calls, 0)
  assert.equal(isDbOpen(), false)
})

test('maintenance reuses an existing matching database without closing it', async (t) => {
  const { root, dataDir } = fixture(t)
  const db = openDatabase({ dataDir })
  await runFleetUpdateWithDatabase(root, { action: 'collect', ids: ['vm-missing'] })
  assert.equal(getDb(), db)
  await assert.rejects(runFleetUpdateWithDatabase(path.join(root, 'other')), /does not match/)
  assert.equal(getDb(), db)
})

test('a wrong project path cannot silently create an empty maintenance database', async (t) => {
  const { root } = fixture(t)
  const wrong = path.join(root, 'missing')
  await assert.rejects(runFleetUpdateWithDatabase(wrong), /existing project database/)
  assert.equal(fs.existsSync(wrong), false)
})
