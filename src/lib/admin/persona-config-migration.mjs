/** Reversible migration of the retired 303 preset. Snapshots contain private configuration. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { canonicalPersonaCompat, OFFICIAL_303_PRESET, PRESET_FLAG_FIELDS } from '../identity/persona-template.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'

const fields = ['persona_templates', 'persona_block_presets', ...PRESET_FLAG_FIELDS]
const aliases = [OFFICIAL_303_PRESET, '303', 'official-303']
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const directory = (file) => path.join(path.dirname(file), '.protocol-migrations', 'official-303-to-full')
const failure = (message) => Object.assign(new Error(message), { code: 'persona_migration_failed' })

function regularFile(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    throw failure('Protocol configuration and snapshots must be regular files')
}

function privateDirectory(dir) {
  if (fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()))
    throw failure('Protocol migration directory must not be a link')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function snapshot(file, bytes) {
  const id = digest(bytes)
  const root = directory(file)
  privateDirectory(path.dirname(root))
  privateDirectory(root)
  const target = path.join(root, id)
  if (fs.existsSync(target)) {
    privateDirectory(target)
    regularFile(path.join(target, 'routing.json'))
    regularFile(path.join(target, 'manifest.json'))
    const saved = fs.readFileSync(path.join(target, 'routing.json'))
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))
    if (digest(saved) !== id || manifest.sha256 !== id) throw failure('Protocol snapshot checksum mismatch')
    return id
  }
  const stage = fs.mkdtempSync(path.join(root, '.creating-'))
  try {
    fs.chmodSync(stage, 0o700)
    fs.writeFileSync(path.join(stage, 'routing.json'), bytes, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(
      path.join(stage, 'manifest.json'),
      JSON.stringify({
        version: 1,
        migration: 'official-303-to-full',
        sha256: id,
        created_at: new Date().toISOString(),
      }),
      { flag: 'wx', mode: 0o600 },
    )
    fs.renameSync(stage, target)
    return id
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** Active 303 edits win when 303 was selected; otherwise an explicit full value wins. */
export function migratePersonaCompatibility(compat) {
  if (!compat || typeof compat !== 'object' || Array.isArray(compat)) return compat
  const selected303 = aliases.includes(compat.persona_preset)
  const next = structuredClone(compat)
  for (const field of fields) {
    const map = next[field]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    if (selected303 && Object.hasOwn(map, OFFICIAL_303_PRESET)) map.official_full = map[OFFICIAL_303_PRESET]
  }
  return canonicalPersonaCompat(next)
}

/** Called before any normalizer or save can discard the legacy map entries. */
export function migratePersonaConfigFile(file) {
  regularFile(file)
  const bytes = fs.readFileSync(file)
  const doc = JSON.parse(bytes.toString('utf8'))
  const compat = doc.compatibility
  const legacy =
    aliases.includes(compat?.persona_preset) ||
    fields.some((field) => Object.hasOwn(compat?.[field] || {}, OFFICIAL_303_PRESET))
  if (!legacy) return { changed: false, document: doc }
  const id = snapshot(file, bytes)
  const next = { ...doc, compatibility: migratePersonaCompatibility(compat) }
  // The original byte snapshot is complete before the live configuration changes.
  atomicWriteJson(file, next, { mode: 0o600 })
  return { changed: true, snapshot: id, document: next }
}

/** Offline operator tool: restores exact bytes and first snapshots the current configuration. */
export function restorePersonaConfigFile(file, id) {
  if (!/^[a-f0-9]{64}$/.test(id || '')) throw failure('Invalid protocol snapshot id')
  const root = directory(file)
  for (const dir of [path.dirname(root), root, path.join(root, id)]) privateDirectory(dir)
  const source = path.join(root, id, 'routing.json')
  const meta = path.join(root, id, 'manifest.json')
  regularFile(source)
  regularFile(meta)
  const bytes = fs.readFileSync(source)
  const manifest = JSON.parse(fs.readFileSync(meta, 'utf8'))
  if (digest(bytes) !== id || manifest.sha256 !== id || manifest.migration !== 'official-303-to-full')
    throw failure('Protocol snapshot checksum mismatch')
  JSON.parse(bytes.toString('utf8'))
  regularFile(file)
  const previous = snapshot(file, fs.readFileSync(file))
  atomicWriteJson(file, bytes.toString('utf8'), { mode: 0o600 })
  return { restored: id, previous }
}
