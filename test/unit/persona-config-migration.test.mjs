import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { migratePersonaConfigFile, restorePersonaConfigFile } from '../../src/lib/admin/persona-config-migration.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

function fixture(t, selection = 'official_303') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-persona-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'routing.json')
  const original = Buffer.from(
    JSON.stringify(
      {
        codex: { quota: {} },
        compatibility: {
          persona_preset: selection,
          persona_templates: {
            official_303: [{ type: 'text', text: 'FICTIONAL_303' }],
            official_full: [{ type: 'text', text: 'FICTIONAL_FULL' }],
          },
          persona_env_presets: { official_303: false, official_full: true },
          agent_standing_presets: { official_303: true, official_full: false },
          persona_block_presets: { official_303: { guidance: true }, official_full: { guidance: false } },
          unrelated: { preserved: true },
        },
      },
      null,
      '\t',
    ) + '\r\n',
  )
  fs.writeFileSync(file, original)
  return { root, file, original }
}

test('selected 303 keeps its own template and switches; restart is idempotent and exact rollback retains both', (t) => {
  const { root, file, original } = fixture(t)
  const migrated = migratePersonaConfigFile(file)
  const compat = migrated.document.compatibility
  assert.equal(compat.persona_preset, 'official_full')
  assert.equal(compat.persona_templates.official_full[0].text, 'FICTIONAL_303')
  assert.equal(compat.persona_env_presets.official_full, false)
  assert.equal(compat.agent_standing_presets.official_full, true)
  assert.deepEqual(compat.persona_block_presets.official_full, { guidance: true })
  assert.deepEqual(compat.unrelated, { preserved: true })
  assert.equal(compat.persona_templates.official_303, undefined)
  assert.equal(migratePersonaConfigFile(file).changed, false)
  const saved = path.join(root, '.protocol-migrations/official-303-to-full', migrated.snapshot, 'routing.json')
  assert.deepEqual(fs.readFileSync(saved), original)
  const result = restorePersonaConfigFile(file, migrated.snapshot)
  assert.match(result.previous, /^[a-f0-9]{64}$/)
  assert.deepEqual(fs.readFileSync(file), original)
  assert.equal(JSON.parse(original).compatibility.persona_templates.official_full[0].text, 'FICTIONAL_FULL')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(saved)).mode & 0o777, 0o700)
  }
})

for (const selection of ['official_full', 'zero']) {
  test(`selection ${selection} keeps full edits and stores retired 303 for rollback`, (t) => {
    const { file, original } = fixture(t, selection)
    const result = migratePersonaConfigFile(file)
    assert.equal(result.document.compatibility.persona_preset, selection)
    assert.equal(result.document.compatibility.persona_templates.official_full[0].text, 'FICTIONAL_FULL')
    assert.equal(result.document.compatibility.persona_env_presets.official_full, true)
    restorePersonaConfigFile(file, result.snapshot)
    assert.deepEqual(fs.readFileSync(file), original)
  })
}

for (const selection of ['303', 'official-303']) {
  test(`legacy selection alias ${selection} preserves the active 303 edits`, (t) => {
    const { file, original } = fixture(t, selection)
    const result = migratePersonaConfigFile(file)
    assert.equal(result.document.compatibility.persona_preset, 'official_full')
    assert.equal(result.document.compatibility.persona_templates.official_full[0].text, 'FICTIONAL_303')
    assert.equal(result.document.compatibility.persona_env_presets.official_full, false)
    restorePersonaConfigFile(file, result.snapshot)
    assert.deepEqual(fs.readFileSync(file), original)
  })
}

for (const only of ['official_303', 'official_full']) {
  test(`a ${only}-only configuration preserves its template and opt-out`, (t) => {
    const { file } = fixture(t, only)
    const doc = JSON.parse(fs.readFileSync(file))
    const other = only === 'official_303' ? 'official_full' : 'official_303'
    for (const value of Object.values(doc.compatibility)) {
      if (value && typeof value === 'object') delete value[other]
    }
    doc.compatibility.persona_env_presets[only] = false
    fs.writeFileSync(file, JSON.stringify(doc))
    const original = fs.readFileSync(file)
    const result = migratePersonaConfigFile(file)
    assert.equal(result.changed, only === 'official_303')
    assert.equal(result.document.compatibility.persona_preset, 'official_full')
    assert.equal(result.document.compatibility.persona_env_presets.official_full, false)
    assert.equal(
      result.document.compatibility.persona_templates.official_full[0].text,
      only === 'official_303' ? 'FICTIONAL_303' : 'FICTIONAL_FULL',
    )
    if (result.changed) restorePersonaConfigFile(file, result.snapshot)
    assert.deepEqual(fs.readFileSync(file), original)
  })
}

test('an unavailable snapshot directory blocks migration before the live file is changed', (t) => {
  const { root, file, original } = fixture(t)
  fs.writeFileSync(path.join(root, '.protocol-migrations'), 'fictional blocking regular file')
  assert.throws(() => migratePersonaConfigFile(file), /must not be a link/)
  assert.deepEqual(fs.readFileSync(file), original)
})

test('migration snapshots are included in backup scope while incomplete and unrelated paths are excluded', async (t) => {
  const { root, file, original } = fixture(t)
  const result = migratePersonaConfigFile(file)
  const { stageState, selected } = await import('../../src/lib/admin/backup-layout.mjs')
  const stage = path.join(root, 'archive-stage')
  const ctx = { configDir: root, dataDir: path.join(root, 'empty-data') }
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const manifest = stageState(ctx, stage, hash)
  const key = `config/.protocol-migrations/official-303-to-full/${result.snapshot}/routing.json`
  assert.deepEqual(fs.readFileSync(path.join(stage, key)), original)
  assert.equal(manifest.sha256s[key], hash(path.join(stage, key)))
  assert.equal(selected('config', '.protocol-migrations/official-303-to-full/.creating-abc/routing.json'), false)
  assert.equal(selected('config', `.protocol-migrations/official-303-to-full/${result.snapshot}/private.txt`), false)
})

test('runtime load migrates before normalizers, keeps snapshot and loads the saved selection on restart', (t) => {
  const { root, file } = fixture(t)
  const make = () => createRoutingRuntime({ cfg: { paths: { project: root } }, routingConfigPath: file })
  const first = make().loadRoutingConfig()
  const second = make().loadRoutingConfig()
  assert.equal(first.compatibility.persona_preset, 'official_full')
  assert.deepEqual(first.compatibility, second.compatibility)
  assert.equal(fs.readdirSync(path.join(root, '.protocol-migrations/official-303-to-full')).length, 1)
})

test('snapshot corruption or creation failure blocks migration without modifying the original', (t) => {
  const { root, file, original } = fixture(t)
  const id = crypto.createHash('sha256').update(original).digest('hex')
  const snapshotDir = path.join(root, '.protocol-migrations/official-303-to-full', id)
  fs.mkdirSync(snapshotDir, { recursive: true })
  fs.writeFileSync(path.join(snapshotDir, 'routing.json'), '{}')
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify({ sha256: id }))
  assert.throws(() => migratePersonaConfigFile(file), /checksum mismatch/)
  assert.deepEqual(fs.readFileSync(file), original)
  assert.throws(() => restorePersonaConfigFile(file, '../routing.json'), /Invalid protocol snapshot/)
  assert.throws(() => restorePersonaConfigFile(file, id), /checksum mismatch/)
  assert.deepEqual(fs.readFileSync(file), original)
})

test('a matching snapshot digest cannot substitute for a valid migration manifest', (t) => {
  const { root, file, original } = fixture(t)
  const id = crypto.createHash('sha256').update(original).digest('hex')
  const saved = path.join(root, '.protocol-migrations/official-303-to-full', id)
  fs.mkdirSync(saved, { recursive: true })
  fs.writeFileSync(path.join(saved, 'routing.json'), original)
  for (const invalid of [
    { version: 2, migration: 'official-303-to-full' },
    { version: 1, migration: 'other' },
  ]) {
    fs.writeFileSync(path.join(saved, 'manifest.json'), JSON.stringify({ ...invalid, sha256: id }))
    assert.throws(() => migratePersonaConfigFile(file), /checksum mismatch/)
    assert.throws(() => restorePersonaConfigFile(file, id), /checksum mismatch/)
    assert.deepEqual(fs.readFileSync(file), original)
  }
})
