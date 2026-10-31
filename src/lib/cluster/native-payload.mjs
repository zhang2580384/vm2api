/**
 * darwin/arm64 slot payload for macOS cluster nodes. The Linux payload (ELF,
 * glibc shim, slot image) cannot run on a Mac, so a native node needs its own
 * build of every process that lives in the slot:
 *
 *   kin-kernel   slot kernel (prebuilt; ships separately from the Linux payload)
 *   cli-node     wrap dataplane CLI (prebuilt)
 *   cc-node      cc dataplane CLI (prebuilt)
 *   kin-worker   OAuth command helper (Go, `GOOS=darwin GOARCH=arm64`)
 *
 * They are read from KIN_DARWIN_PAYLOAD_DIR, default <project>/payload/darwin-arm64.
 * On the node they live in <root>/native/<digest>/: content-addressed, shared by
 * every slot, published by renaming a complete directory so a slot never starts
 * from a half-uploaded payload.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openSftp, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'
import { ClusterError } from './ssh-link.mjs'

export const NATIVE_PAYLOAD_FILES = Object.freeze(['kin-kernel', 'cli-node', 'cc-node', 'kin-worker'])
const COMPLETE_MARK = '.complete'
const CPU_TYPE_ARM64 = 0x0100000c
const FAT_MAGIC = 0xcafebabe
const MH_MAGIC_64 = 0xfeedfacf

export function nativePayloadDir(projectRoot) {
  const env = String(process.env.KIN_DARWIN_PAYLOAD_DIR || '').trim()
  return env || path.join(projectRoot, 'payload', 'darwin-arm64')
}

/** Thin arm64 Mach-O, or a universal binary with an arm64 slice. */
export function isDarwinArm64MachO(head) {
  if (!Buffer.isBuffer(head) || head.length < 8) return false
  if (head.readUInt32LE(0) === MH_MAGIC_64) return head.readUInt32LE(4) === CPU_TYPE_ARM64
  if (head.readUInt32BE(0) !== FAT_MAGIC) return false
  // Java class files share 0xcafebabe; their next word is a version, far above any arch count.
  const count = head.readUInt32BE(4)
  if (count === 0 || count > 16 || head.length < 8 + count * 20) return false
  for (let i = 0; i < count; i += 1) {
    if (head.readUInt32BE(8 + i * 20) === CPU_TYPE_ARM64) return true
  }
  return false
}

function readHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(8 + 16 * 20)
    const n = fs.readSync(fd, head, 0, head.length, 0)
    return head.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

const digestCache = new Map()

/**
 * Validated local payload: `{ dir, files: [{ name, src }], digest }`. Throws
 * native_payload_missing / native_payload_invalid naming the file, so preflight
 * can say exactly what the maintainer build still lacks.
 */
export function describeNativePayload(projectRoot) {
  const dir = nativePayloadDir(projectRoot)
  const files = []
  const hash = crypto.createHash('sha256')
  const keyParts = []
  for (const name of NATIVE_PAYLOAD_FILES) {
    const src = path.join(dir, name)
    let st
    try {
      st = fs.statSync(src)
    } catch {
      throw new ClusterError(500, 'native_payload_missing', `缺少 darwin/arm64 产物 ${name}（${src}）`)
    }
    if (!st.isFile()) throw new ClusterError(500, 'native_payload_missing', `缺少 darwin/arm64 产物 ${name}（${src}）`)
    if (!isDarwinArm64MachO(readHead(src))) {
      throw new ClusterError(500, 'native_payload_invalid', `${name} 不是 darwin/arm64 Mach-O：${src}`)
    }
    files.push({ name, src })
    keyParts.push(`${src}\0${st.size}\0${st.mtimeMs}`)
  }
  const key = keyParts.join('\n')
  const hit = digestCache.get(dir)
  if (hit?.key === key) return { dir, files, digest: hit.digest }
  for (const { name, src } of files) hash.update(name).update('\0').update(fs.readFileSync(src))
  const digest = hash.digest('hex').slice(0, 16)
  digestCache.set(dir, { key, digest })
  return { dir, files, digest }
}

/** Node-side directory of a payload digest. */
export function remoteNativePayloadDir(root, digest) {
  return `${root}/native/${digest}`
}

/**
 * Make <root>/native/<digest>/ exist on the node. Uploads into a private temp
 * directory and renames it into place; an already published digest is left alone.
 */
export async function ensureNativePayload(session, projectRoot) {
  const payload = describeNativePayload(projectRoot)
  const target = remoteNativePayloadDir(session.host.root, payload.digest)
  const q = shellQuote(target)
  const present = await runRemote(session.client, `test -f ${q}/${COMPLETE_MARK} && echo yes || echo no`, {
    timeoutMs: 10_000,
  })
  if (present.trim() === 'yes') return { ...payload, remoteDir: target, uploaded: false }
  const staging = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`
  await runRemote(
    session.client,
    `umask 022 && mkdir -p ${shellQuote(`${session.host.root}/native`)} && mkdir ${shellQuote(staging)}`,
    { timeoutMs: 15_000 },
  )
  try {
    const sftp = await openSftp(session.client)
    for (const { name, src } of payload.files) {
      await writeRemoteFile(sftp, `${staging}/${name}`, fs.readFileSync(src), { mode: 0o755 })
    }
    await writeRemoteFile(sftp, `${staging}/${COMPLETE_MARK}`, `${payload.digest}\n`, { mode: 0o644 })
    // A concurrent start may have published the same digest first; its copy is byte-identical.
    await runRemote(
      session.client,
      `if [ -e ${q} ]; then rm -rf ${shellQuote(staging)}; else mv ${shellQuote(staging)} ${q}; fi`,
      { timeoutMs: 15_000 },
    )
  } catch (err) {
    await runRemote(session.client, `rm -rf ${shellQuote(staging)}`, { timeoutMs: 15_000 }).catch(() => {})
    throw err
  }
  return { ...payload, remoteDir: target, uploaded: true }
}
