import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../../src/lib/db/database.mjs'

test('v2.4.4 database upgrades without renumbering its applied cloud backup migration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-protocol-db-upgrade-'))
  const legacy = path.join(root, 'migrations')
  fs.mkdirSync(legacy)
  const source = path.resolve('src/lib/db/migrations')
  for (const name of fs.readdirSync(source)) {
    if (name.endsWith('.sql') && name < '044') fs.copyFileSync(path.join(source, name), path.join(legacy, name))
  }
  const db = new DatabaseSync(path.join(root, 'kin.db'))
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  applyMigrations(db, { migrationsDir: legacy })
  const before = db.prepare("SELECT * FROM schema_migrations WHERE version = '043'").get()
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('fictional-account-setting', 'KEEP_ME')
  db.prepare('INSERT INTO backup_records (id, created_at, status, remote_json) VALUES (?, ?, ?, ?)').run(
    'fictional-cloud-archive',
    '2026-10-01T00:00:00Z',
    'ok',
    '{"bucket":"fictional-only"}',
  )
  assert.doesNotThrow(() => applyMigrations(db))
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version = '043'").get(), before)
  assert.equal(before.name, '043_backup_remote.sql')
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('fictional-account-setting').value, 'KEEP_ME')
  assert.equal(
    db.prepare('SELECT remote_json FROM backup_records WHERE id = ?').get('fictional-cloud-archive').remote_json,
    '{"bucket":"fictional-only"}',
  )
  assert.ok(
    db
      .prepare('PRAGMA table_info(usage_logs)')
      .all()
      .some((column) => column.name === 'generation_ms'),
  )
  assert.doesNotThrow(() => applyMigrations(db))
  const versions = fs
    .readdirSync(source)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.split('_')[0])
  assert.equal(new Set(versions).size, versions.length)
})
