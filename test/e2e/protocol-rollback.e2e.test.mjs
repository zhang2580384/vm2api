/** Fictional, offline upgrade/rollback between exact source and payload revisions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'

const previous = process.env.KIN_PREVIOUS_SOURCE

function payloadEnv(root) {
  return Object.fromEntries(
    Object.entries({
      KIN_KERNEL_BIN: 'bin/kin-kernel',
      KIN_EGRESS_BIN: 'bin/kin-egress',
      KIN_WORKER_BIN: 'bin/kin-worker',
      KIN_CODEX_KERNEL_BIN: 'bin/kin-codex-kernel',
      KIN_API_KERNEL_BIN: 'bin/kin-api-kernel',
    }).map(([key, relative]) => [key, path.join(root, relative)]),
  )
}

function verifyPayload(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payload.json')))
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, file.path))
    assert.equal(bytes.length, file.size, file.path)
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
  }
  return manifest.release
}

test('v2.4.4 source, database, configuration and pinned payload remain usable after an isolated full-state rollback', {
  skip: !previous,
  timeout: 120000,
}, async (t) => {
  assert.equal(fs.readFileSync(path.join(previous, 'VERSION'), 'utf8').trim(), '2.4.4')
  assert.equal(verifyPayload(previous), 'payload-2026.10.24-cli-303-sdk')
  assert.equal(verifyPayload(REPO_ROOT), 'payload-2026.10.29-telemetry-kernel')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-protocol-rollback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = path.join(root, 'instance')
  const saved = path.join(root, 'pre-upgrade-state')
  const vm = seedVm({ project })
  vm.status = 'stopped'
  vm.schedulable = false
  vm.proxy.domain_forward = true
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const profile = path.join(project, 'vms', vm.id, 'cli-home', 'fictional-profile')
  fs.writeFileSync(profile, 'FICTIONAL_SESSION_BYTES')
  const routing = JSON.parse(fs.readFileSync(path.join(previous, 'src/config/routing.json')))
  routing.compatibility.persona_preset = 'official_303'
  routing.compatibility.persona_templates = {
    official_303: [{ type: 'text', text: 'FICTIONAL_303_ACTIVE' }],
    official_full: [{ type: 'text', text: 'FICTIONAL_FULL_INDEPENDENT' }],
  }
  const routingFile = path.join(project, 'config/routing.json')
  fs.mkdirSync(path.dirname(routingFile), { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify(routing, null, '\t') + '\r\n')
  let gw
  try {
    gw = await startGateway({ project, sourceRoot: previous, env: payloadEnv(previous) })
    const originalKey = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'FICTIONAL_KEEP' } })
    assert.equal(originalKey.status, 201, originalKey.text)
    assert.equal((await api(gw, 'GET', '/api/panel/routing')).json.data.compatibility.persona_preset, 'official_303')
    await gw.stop()
    const originalRouting = fs.readFileSync(routingFile)
    const dbPath = path.join(project, 'data/kin.db')
    let db = new DatabaseSync(dbPath)
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(
      'fictional-quality-recovery',
      '{"restore_schedule":true,"unknown_action":"record_only"}',
    )
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, '043')
    db.close()
    fs.cpSync(project, saved, { recursive: true })

    gw = await startGateway({ project, env: payloadEnv(REPO_ROOT) })
    const upgraded = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(upgraded.json.data.compatibility.persona_preset, 'official_full')
    assert.equal(upgraded.json.data.compatibility.persona_templates.official_full[0].text, 'FICTIONAL_303_ACTIVE')
    assert.equal(
      (await api(gw, 'GET', '/api/panel/api-keys')).json.keys.some((key) => key.name === 'FICTIONAL_KEEP'),
      true,
    )
    assert.equal(
      (await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'FICTIONAL_AFTER_UPGRADE' } })).status,
      201,
    )
    await gw.stop()
    db = new DatabaseSync(dbPath)
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, '048')
    assert.equal(
      JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('fictional-quality-recovery').value)
        .unknown_action,
      'record_only',
    )
    db.close()
    assert.equal(fs.readFileSync(profile, 'utf8'), 'FICTIONAL_SESSION_BYTES')

    // Only this test's mkdtemp tree is replaced; no running gateway or host service exists here.
    fs.rmSync(project, { recursive: true, force: true })
    fs.cpSync(saved, project, { recursive: true })
    assert.deepEqual(fs.readFileSync(routingFile), originalRouting)
    verifyPayload(previous)
    gw = await startGateway({ project, sourceRoot: previous, env: payloadEnv(previous) })
    const restored = (await api(gw, 'GET', '/api/panel/routing')).json.data.compatibility
    assert.equal(restored.persona_preset, 'official_303')
    assert.equal(restored.persona_templates.official_303[0].text, 'FICTIONAL_303_ACTIVE')
    assert.equal(restored.persona_templates.official_full[0].text, 'FICTIONAL_FULL_INDEPENDENT')
    const names = (await api(gw, 'GET', '/api/panel/api-keys')).json.keys.map((key) => key.name)
    assert.ok(names.includes('FICTIONAL_KEEP'))
    assert.ok(!names.includes('FICTIONAL_AFTER_UPGRADE'))
    const restoredVm = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${vm.id}.json`)))
    assert.equal(restoredVm.schedulable, false)
    assert.equal(restoredVm.proxy.domain_forward, true)
    assert.equal(fs.readFileSync(profile, 'utf8'), 'FICTIONAL_SESSION_BYTES')
    await gw.stop()
    db = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, '043')
    assert.equal(
      JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('fictional-quality-recovery').value)
        .restore_schedule,
      true,
    )
    db.close()
  } finally {
    await gw?.stop()
  }
})
