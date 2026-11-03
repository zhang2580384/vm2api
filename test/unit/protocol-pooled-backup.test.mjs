import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { dbSecret, decryptString, encryptString } from '../../src/lib/db/secure.mjs'
import { readAll, usagePoolEnabled } from '../../src/lib/db/sqlite-pool.mjs'
import { enqueueWrite, pendingWrites } from '../../src/lib/db/write-behind.mjs'

test('pooled startup preserves restore maintenance, credential recovery and shutdown durability', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-pooled-backup-'))
  const marker = path.join(dir, 'backup-restore-pending.json')
  const key = 'fictional-offline-recovery-key'
  fs.writeFileSync(marker, '{}')
  fs.writeFileSync(path.join(dir, 'credential-secret.key'), key)
  try {
    assert.throws(() => openDatabase({ dataDir: dir, pooled: true }), /未完成的备份恢复/)
    assert.equal(usagePoolEnabled(), false)
    assert.equal(fs.existsSync(path.join(dir, 'kin.db')), false)
    const db = openDatabase({ dataDir: dir, pooled: true, allowRestore: true })
    const plain = 'fictional-restored-credential'
    assert.equal(dbSecret(), key)
    assert.equal(decryptString(encryptString(plain, key)), plain)
    assert.equal(Number((await readAll('SELECT 1 AS n'))[0].n), 1)
    db.exec('CREATE TABLE protocol_durability (value TEXT)')
    enqueueWrite(() => db.prepare('INSERT INTO protocol_durability VALUES (?)').run(plain))
    assert.equal(pendingWrites(), 1)
    closeDatabase()
    assert.equal(pendingWrites(), 0)
    assert.equal(usagePoolEnabled(), false)
    assert.equal(fs.readFileSync(marker, 'utf8'), '{}')
    const check = new DatabaseSync(path.join(dir, 'kin.db'), { readOnly: true })
    try {
      assert.equal(check.prepare('SELECT value FROM protocol_durability').get().value, plain)
    } finally {
      check.close()
    }
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
