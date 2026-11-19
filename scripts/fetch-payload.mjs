#!/usr/bin/env node
/**
 * Slot payloads (closed-source kernels, wrap CLIs, glibc shim) live in GitHub
 * releases, not in git. Files inherit the manifest repo and release unless they pin their own source.
 *
 *   node scripts/fetch-payload.mjs [--dest DIR]   download missing / stale files
 *   node scripts/fetch-payload.mjs --check        verify local files, no network
 *   node scripts/fetch-payload.mjs --stage DIR    copy local files out under their
 *                                                 asset names, for `gh release upload`
 *   node scripts/fetch-payload.mjs --pin TAG      re-hash local files into the
 *                                                 manifest and point it at release TAG
 *
 * VM2API_PAYLOAD_BASE_URL overrides https://github.com/<repo>/releases/download.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const { values: opts } = parseArgs({
  options: {
    dest: { type: 'string', default: root },
    manifest: { type: 'string', default: path.join(root, 'deploy', 'payload.json') },
    check: { type: 'boolean', default: false },
    stage: { type: 'string' },
    pin: { type: 'string' },
  },
})

const manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'))
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function readLocal(file) {
  try {
    return fs.readFileSync(path.join(opts.dest, file.path))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function matches(buf, file) {
  return buf !== null && buf.length === file.size && sha256(buf) === file.sha256
}

if (opts.pin) {
  for (const file of manifest.files) {
    const buf = readLocal(file)
    if (buf === null) throw new Error(`${file.path} is missing; cannot pin`)
    file.size = buf.length
    file.sha256 = sha256(buf)
    // All staged assets will be published to the same repository and tag.
    delete file.release
    delete file.repo
  }
  manifest.release = opts.pin
  fs.writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`pinned ${manifest.files.length} files to ${opts.pin}`)
} else if (opts.stage) {
  fs.mkdirSync(opts.stage, { recursive: true })
  const staged = new Map()
  for (const file of manifest.files) {
    const buf = readLocal(file)
    if (!matches(buf, file)) throw new Error(`${file.path} does not match the manifest; run --pin first`)
    // One asset may back several paths (bin/kin-kernel = share/wrap-cli/kin-kernel.bin).
    if (staged.has(file.asset)) {
      if (staged.get(file.asset) !== file.sha256) throw new Error(`asset ${file.asset} maps to different files`)
      continue
    }
    fs.writeFileSync(path.join(opts.stage, file.asset), buf, { mode: 0o755 })
    staged.set(file.asset, file.sha256)
  }
  console.log(`staged ${staged.size} assets in ${opts.stage}`)
} else if (opts.check) {
  const bad = manifest.files.filter((file) => !matches(readLocal(file), file)).map((file) => file.path)
  if (bad.length) {
    console.error(`payload mismatch (${manifest.release}): ${bad.join(', ')}`)
    process.exit(1)
  }
  console.log(`payload ok (${manifest.release}, ${manifest.files.length} files)`)
} else {
  const mirror = process.env.VM2API_PAYLOAD_BASE_URL?.replace(/\/+$/, '')
  const downloads = new Map()
  for (const file of manifest.files) {
    const target = path.join(opts.dest, file.path)
    if (matches(readLocal(file), file)) continue
    const base = mirror || `https://github.com/${file.repo || manifest.repo}/releases/download`
    const url = `${base}/${file.release || manifest.release}/${file.asset}`
    if (!downloads.has(url)) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
      downloads.set(url, Buffer.from(await res.arrayBuffer()))
    }
    const buf = downloads.get(url)
    if (!matches(buf, file)) {
      throw new Error(`${url} does not match ${file.path} (size ${buf.length}, sha256 ${sha256(buf)})`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.download`
    fs.writeFileSync(tmp, buf, { mode: 0o755 })
    fs.renameSync(tmp, target)
    console.log(`fetched ${file.path}`)
  }
  console.log(`payload ready (${manifest.release}, ${manifest.files.length} files)`)
}
