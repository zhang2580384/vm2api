/** Explicit persistent state scopes shared by backup and restore. Never follow links. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isEncrypted, decryptString, encryptString } from '../db/secure.mjs'

const dataFolders = new Set([
  'codex-login-pool',
  'codex-mailbox',
  'codex-registration',
  'quality-preview',
  'quality-records',
])
const volatile = new Set([
  'run',
  'tmp',
  'cache',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'Crash Reports',
  'BrowserMetrics',
  '.cache',
  '.npm',
  '.kin',
  'node_modules',
  'logs',
])
const dataExcluded = new Set([
  'panel-sessions.json',
  'backup-storage.json',
  'backup-restore-pending.json',
  'credential-secret.key',
])
const error = (message) => Object.assign(new Error(message), { code: 'backup_corrupt' })

export function selected(scope, relative, directory = false) {
  const parts = relative.split('/')
  const name = parts.at(-1)
  const leveldb = parts.some((p) => /leveldb$/i.test(p))
  if (
    parts.some((p) => volatile.has(p)) ||
    /^(Singleton|DevToolsActivePort)/.test(name) ||
    name === 'LOCK' ||
    /\.(sock|pid|lock|tmp)$/.test(name) ||
    (name.endsWith('.log') && !leveldb)
  )
    return false
  if (scope === 'data' || scope === 'project-data') {
    return parts.length === 1
      ? directory
        ? dataFolders.has(name)
        : name.endsWith('.json') && !dataExcluded.has(name)
      : dataFolders.has(parts[0])
  }
  if (scope === 'config') {
    if (parts[0] === '.protocol-migrations') {
      if (parts.length === 1) return directory
      if (parts[1] !== 'official-303-to-full') return false
      if (parts.length === 2) return directory
      if (!/^[a-f0-9]{64}$/.test(parts[2])) return false
      return parts.length === 3
        ? directory
        : parts.length === 4 && !directory && ['routing.json', 'manifest.json'].includes(name)
    }
    return !directory && parts.length === 1 && name.endsWith('.json')
  }
  if (scope === 'vms') {
    const mailbox = parts.indexOf('kin-mailbox')
    if (mailbox !== -1 && parts.length > mailbox + 1 && !['profiles', 'config'].includes(parts[mailbox + 1]))
      return false
    if (parts.length === 1) return directory || name.endsWith('.json')
    return !/\.(qcow2|img|vmdk|iso|tar|gz|zip)$/.test(name)
  }
  return false
}

export function stateRoots(ctx) {
  const roots = [{ name: 'data', dir: ctx.dataDir }]
  if (ctx.projectRoot) {
    roots.push({ name: 'vms', dir: path.join(ctx.projectRoot, 'vms') })
    const projectData = path.join(ctx.projectRoot, 'data')
    if (path.resolve(projectData) !== path.resolve(ctx.dataDir)) roots.push({ name: 'project-data', dir: projectData })
  }
  if (ctx.configDir) roots.push({ name: 'config', dir: ctx.configDir })
  return roots
}

export function walkFiles(root, filter = () => true, prefix = '') {
  if (!fs.existsSync(root)) return []
  if (fs.lstatSync(root).isSymbolicLink()) throw error('备份或恢复范围不能使用符号链接目录')
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (!filter(relative, entry.isDirectory())) continue
    if (entry.isDirectory())
      files.push(
        ...walkFiles(path.join(root, entry.name), (p, d) => filter(`${relative}/${p}`, d)).map(
          (p) => `${relative}/${p}`,
        ),
      )
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function ensureNoLinks(root, relative) {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw error('恢复范围不能使用符号链接目录')
  let current = root
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw error('恢复目标中存在符号链接，请先移走该链接')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
}

function snapshotFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(source, 'r')
  const header = Buffer.alloc(16)
  try {
    fs.readSync(fd, header, 0, 16, 0)
  } finally {
    fs.closeSync(fd)
  }
  // Chromium stores cookies/history in SQLite with WAL. Snapshot the logical DB,
  // rather than copying a main file and silently losing committed WAL pages.
  if (header.toString() === 'SQLite format 3\0') {
    const db = new DatabaseSync(source, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 10000')
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
  } else fs.copyFileSync(source, target)
  fs.chmodSync(target, 0o600)
}

export function stageState(ctx, staging, hashFile) {
  const sha256s = {},
    files = {},
    scopes = [],
    includes = { db: true, vms: 0, config: 0, data: 0 }
  for (const { name, dir } of stateRoots(ctx)) {
    scopes.push(name) // Empty scope still matters: restore must remove newer state.
    for (const relative of walkFiles(dir, (p, d) => selected(name, p, d))) {
      if (/-(wal|shm)$/.test(relative)) {
        const main = path.join(dir, relative.replace(/-(wal|shm)$/, ''))
        if (fs.existsSync(main)) continue
      }
      const source = path.join(dir, relative),
        key = `${name}/${relative}`,
        target = path.join(staging, key)
      snapshotFile(source, target)
      const stat = fs.statSync(source)
      sha256s[key] = hashFile(target)
      files[key] = { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }
      includes[name === 'project-data' ? 'data' : name] += 1
    }
  }
  return { sha256s, files, scopes, includes }
}

export function stageDeployment(ctx, staging, hashFile) {
  const hashes = {}
  if (!ctx.projectRoot) return hashes
  for (const name of [
    '.env',
    'compose.yml',
    'compose.yaml',
    'docker-compose.yml',
    'docker-compose.yaml',
    'VERSION',
    'deploy/payload.json',
  ]) {
    const file = path.join(ctx.projectRoot, name)
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue
    const target = path.join(staging, 'deployment', name)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.copyFileSync(file, target)
    fs.chmodSync(target, 0o600)
    hashes[`deployment/${name}`] = hashFile(target)
  }
  return hashes
}

export function validateManifest(staging, hashFile) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'))
  } catch {
    throw error('备份缺少有效清单')
  }
  if (![1, 2].includes(manifest.version) || !manifest.sha256s?.['db/kin.db']) throw error('备份清单格式不受支持')
  const allowedScopes = new Set(['vms', 'config', 'data', 'project-data'])
  if (manifest.version === 2 && (!Array.isArray(manifest.scopes) || manifest.scopes.some((s) => !allowedScopes.has(s))))
    throw error('备份范围无效')
  const actual = walkFiles(staging).filter((p) => p !== 'manifest.json')
  for (const file of actual) {
    if (!manifest.sha256s[file] || hashFile(path.join(staging, file)) !== manifest.sha256s[file])
      throw error('备份文件校验失败')
    const parts = file.split('/'),
      scope = parts.shift()
    if (
      allowedScopes.has(scope) &&
      (!selected(scope, parts.join('/')) || (manifest.version === 2 && !manifest.scopes.includes(scope)))
    )
      throw error('备份包含范围外文件')
    if (
      !allowedScopes.has(scope) &&
      file !== 'db/kin.db' &&
      file !== 'recovery.json' &&
      !file.startsWith('deployment/')
    )
      throw error('备份包含未知范围')
  }
  if (actual.length !== Object.keys(manifest.sha256s).length) throw error('备份清单中的文件不完整')
  const db = new DatabaseSync(path.join(staging, 'db/kin.db'), { readOnly: true })
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw error('数据库完整性检查失败')
  } finally {
    db.close()
  }
  return manifest
}

const quote = (s) => '"' + s.replace(/"/g, '""') + '"'
function rekeyValue(value, source, target) {
  if (typeof value === 'string') {
    if (isEncrypted(value)) return encryptString(rekeyValue(decryptString(value, source), source, target), target)
    if (/^[\[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value),
          changed = rekeyValue(parsed, source, target)
        if (JSON.stringify(parsed) !== JSON.stringify(changed)) return JSON.stringify(changed)
      } catch (e) {
        if (e instanceof SyntaxError) return value
        throw e
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => rekeyValue(v, source, target))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rekeyValue(v, source, target)]))
  return value
}

export function rekeyStagedState(staging, manifest, targetSecret) {
  let sourceSecret
  if (manifest.version === 2) {
    const recovery = JSON.parse(fs.readFileSync(path.join(staging, 'recovery.json'), 'utf8'))
    sourceSecret = recovery.db_secret ?? undefined
  } else sourceSecret = targetSecret // Legacy archives did not carry the source key.
  const db = new DatabaseSync(path.join(staging, 'db/kin.db'))
  try {
    db.exec('BEGIN')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all()
      const pks = columns.filter((c) => c.pk).map((c) => c.name)
      const text = columns.filter((c) => /TEXT|CHAR|CLOB/i.test(c.type)).map((c) => c.name)
      if (!text.length || !pks.length) continue
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).iterate()) {
        const changes = text
          .map((c) => [c, rekeyValue(row[c], sourceSecret, targetSecret)])
          .filter(([c, v]) => v !== row[c])
        if (changes.length)
          db.prepare(
            `UPDATE ${quote(name)} SET ${changes.map(([c]) => `${quote(c)} = ?`).join(',')} WHERE ${pks.map((c) => `${quote(c)} = ?`).join(' AND ')}`,
          ).run(...changes.map(([, v]) => v), ...pks.map((c) => row[c]))
      }
    }
    db.exec('COMMIT')
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error('凭据无法解密，请确认源数据库加密密钥')
  } finally {
    db.close()
  }
  for (const file of walkFiles(staging).filter((p) => /^(data|project-data|vms|config)\/.+\.json$/.test(p))) {
    const target = path.join(staging, file)
    let value
    try {
      value = JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch {
      continue
    }
    try {
      const changed = rekeyValue(value, sourceSecret, targetSecret)
      if (JSON.stringify(value) !== JSON.stringify(changed))
        fs.writeFileSync(target, JSON.stringify(changed), { mode: 0o600 })
    } catch {
      throw error('文件凭据无法解密，请确认源数据库加密密钥')
    }
  }
}

/** Journal every mutation so an error in file installation or store rebind can roll back. */
export function installState(ctx, staging, manifest, rollbackDir) {
  const journal = []
  const rememberedDirs = new Set()
  const metadata = (file) => {
    const s = fs.statSync(file)
    return { uid: s.uid, gid: s.gid, mode: s.mode & 0o777 }
  }
  const record = (entry) => {
    journal.push(entry)
    fs.mkdirSync(rollbackDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(rollbackDir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 })
  }
  const parents = (dir, parent, info) => {
    if (parent === path.dirname(dir) || !parent.startsWith(dir)) return
    if (parent !== dir) parents(dir, path.dirname(parent), info)
    if (!rememberedDirs.has(parent)) {
      const existed = fs.existsSync(parent)
      record({ type: 'directory', dest: parent, existed, metadata: existed ? metadata(parent) : null })
      rememberedDirs.add(parent)
      if (!existed) fs.mkdirSync(parent, { mode: 0o700 })
    }
    if (parent !== dir && process.platform !== 'win32' && process.getuid?.() === 0 && info)
      fs.chownSync(parent, info.uid, info.gid)
  }
  try {
    for (const { name, dir } of stateRoots(ctx)) {
      if (manifest.version === 1 && !['vms', 'config'].includes(name)) continue
      if (manifest.version === 2 && !manifest.scopes.includes(name)) continue
      const source = path.join(staging, name)
      const incoming = new Set(walkFiles(source)),
        current = walkFiles(dir, (p, d) => selected(name, p, d))
      for (const relative of new Set([...current, ...incoming])) {
        ensureNoLinks(dir, relative)
        const dest = path.join(dir, relative),
          saved = path.join(rollbackDir, name, relative)
        const existed = fs.existsSync(dest)
        if (existed) {
          fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 })
          // The staging volume can differ from the slot volume. Copy before
          // removing the original so EXDEV never leaves a partial restore.
          fs.copyFileSync(dest, saved)
        }
        const info = manifest.files?.[`${name}/${relative}`]
        if (incoming.has(relative)) parents(dir, path.dirname(dest), info)
        record({ dest, saved, existed, metadata: existed ? metadata(dest) : null })
        if (existed) fs.rmSync(dest)
        if (incoming.has(relative)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
          fs.copyFileSync(path.join(source, relative), dest)
          fs.chmodSync(dest, info?.mode ? info.mode & 0o700 : 0o600)
          if (process.platform !== 'win32' && process.getuid?.() === 0 && info) {
            fs.chownSync(dest, info.uid, info.gid)
          }
        }
      }
    }
  } catch (e) {
    try {
      rollbackState(journal)
    } catch (rollbackError) {
      e.restoreJournal = journal
      e.rollbackFailed = true
      e.cause = rollbackError
    }
    throw e
  }
  return journal
}

export function rollbackState(journal) {
  for (const { type, dest, saved, existed, metadata } of [...journal].reverse()) {
    if (type === 'directory') {
      if (!existed) {
        try {
          fs.rmdirSync(dest)
        } catch (e) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e
        }
      } else if (metadata) {
        fs.chmodSync(dest, metadata.mode)
        if (process.platform !== 'win32' && process.getuid?.() === 0) fs.chownSync(dest, metadata.uid, metadata.gid)
      }
      continue
    }
    fs.rmSync(dest, { force: true })
    if (existed) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(saved, dest)
      if (metadata) {
        fs.chmodSync(dest, metadata.mode)
        if (process.platform !== 'win32' && process.getuid?.() === 0) fs.chownSync(dest, metadata.uid, metadata.gid)
      }
    }
  }
}
