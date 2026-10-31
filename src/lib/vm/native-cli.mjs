import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runtimeKind } from './runtime-kind.mjs'
import { isCodexVm } from './vm-kind.mjs'

export const NATIVE_CLI_FILES = Object.freeze([
  'cli-node',
  ...['bun', 'cli.js', 'ld-linux-aarch64.so.1', 'libc.so.6', 'libpthread.so.0', 'libdl.so.2', 'libm.so.6'].map(
    (name) => `glibc239/arm64/${name}`,
  ),
])
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Keep the portable template for remote/KVM/Codex slots, even on an ARM controller. */
export function nativeCliForVm(
  vm,
  portableDir,
  { root = process.env.KIN_NATIVE_CLI_ROOT, arch = process.arch, platform = process.platform } = {},
) {
  if (!root || platform !== 'linux' || arch !== 'arm64' || vm?.node_id || runtimeKind(vm) !== 'docker') return null
  if (isCodexVm(vm)) return null
  try {
    const dir = path.resolve(root)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    if (manifest.schema !== 1 || manifest.source_sha256 !== sha256(path.join(portableDir, 'cli-node'))) {
      return {
        ok: false,
        code: 'native_cli_source_mismatch',
        error: 'Rebuild native CLI for the current release payload',
      }
    }
    if (
      Object.keys(manifest.files || {})
        .sort()
        .join() !== [...NATIVE_CLI_FILES].sort().join()
    ) {
      throw new Error('incomplete native CLI manifest')
    }
    for (const file of NATIVE_CLI_FILES) {
      const target = path.join(dir, file)
      if (!fs.lstatSync(target).isFile() || sha256(target) !== manifest.files[file]) {
        throw new Error(`native CLI integrity mismatch: ${file}`)
      }
    }
    return { ok: true, dir, manifest }
  } catch (error) {
    return { ok: false, code: 'native_cli_invalid', error: String(error?.message || error) }
  }
}
