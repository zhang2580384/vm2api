import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeCliForVm, NATIVE_CLI_FILES } from '../../src/lib/vm/native-cli.mjs'
import { materializeWrapCli, inspectKernelChanges } from '../../src/lib/vm/wrap-cli-runtime.mjs'

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const portable = path.join(root, 'share/wrap-cli')
  const native = path.join(root, 'native')
  fs.mkdirSync(portable, { recursive: true })
  for (const file of ['cli-node', 'cc-node', 'kin-kernel.bin'])
    fs.writeFileSync(path.join(portable, file), `x86-${file}`)
  const files = {}
  for (const file of NATIVE_CLI_FILES) {
    const target = path.join(native, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const body = `native-${file}`
    fs.writeFileSync(target, body)
    files[file] = hash(body)
  }
  const manifest = { schema: 1, source_sha256: hash('x86-cli-node'), files }
  const save = () => fs.writeFileSync(path.join(native, 'manifest.json'), JSON.stringify(manifest))
  save()
  return { root, portable, native, manifest, save, opts: { root: native, arch: 'arm64', platform: 'linux' } }
}

test('native overlay selects only local Linux ARM docker slots', (t) => {
  const f = fixture(t)
  assert.equal(nativeCliForVm({ id: 'vm-01' }, f.portable, f.opts).ok, true)
  for (const vm of [
    { id: 'vm-01', node_id: 'remote' },
    { id: 'vm-01', runtime: { type: 'kvm' } },
    { id: 'vm-01', kind: 'codex' },
  ]) {
    assert.equal(nativeCliForVm(vm, f.portable, f.opts), null)
  }
  assert.equal(nativeCliForVm({}, f.portable, { ...f.opts, arch: 'x64' }), null)
  assert.equal(nativeCliForVm({}, f.portable, { ...f.opts, platform: 'darwin' }), null)
  assert.equal(nativeCliForVm({}, f.portable, { ...f.opts, root: '' }), null)
})

test('source drift and damaged bundles fail closed before slot writes', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.portable, 'cli-node'), 'new release')
  const result = materializeWrapCli(f.root, { id: 'vm-01' }, { nativeCliOptions: f.opts })
  assert.equal(result.code, 'native_cli_source_mismatch')
  assert.equal(fs.existsSync(path.join(f.root, 'vms')), false)
  fs.writeFileSync(path.join(f.portable, 'cli-node'), 'x86-cli-node')
  fs.writeFileSync(path.join(f.native, 'glibc239/arm64/bun'), 'corrupt')
  assert.equal(nativeCliForVm({}, f.portable, f.opts).code, 'native_cli_invalid')
})

test('manifest rejects missing, extra and symlinked files', (t) => {
  const f = fixture(t)
  f.manifest.files['../outside'] = 'x'
  f.save()
  assert.equal(nativeCliForVm({}, f.portable, f.opts).ok, false)
  delete f.manifest.files['../outside']
  f.save()
  const target = path.join(f.native, 'cli-node')
  fs.renameSync(target, `${target}.real`)
  fs.symlinkSync(`${target}.real`, target)
  assert.equal(nativeCliForVm({}, f.portable, f.opts).ok, false)
})

test('materialization preserves x86 templates, credentials and remote placement', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.portable, 'glibc239/arm64'), { recursive: true })
  fs.writeFileSync(path.join(f.portable, 'glibc239/arm64/bun'), 'old manual overlay')
  const vm = { id: 'vm-01' }
  const dest = path.join(f.root, 'vms/vm-01/cli-home/.kin')
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'credentials.json'), 'do not touch')
  const applied = materializeWrapCli(f.root, vm, { nativeCliOptions: f.opts })
  assert.equal(applied.ok, true)
  assert.equal(fs.readFileSync(path.join(dest, 'glibc239/arm64/bun'), 'utf8'), 'native-glibc239/arm64/bun')
  assert.equal(applied.kernel_changed, true)
  assert.equal(fs.readFileSync(path.join(dest, 'cli-node'), 'utf8'), 'native-cli-node')
  assert.equal(fs.readFileSync(path.join(dest, 'cc-node'), 'utf8'), 'x86-cc-node')
  assert.equal(fs.readFileSync(path.join(dest, 'credentials.json'), 'utf8'), 'do not touch')
  assert.equal(fs.readFileSync(path.join(f.portable, 'cli-node'), 'utf8'), 'x86-cli-node')
  assert.equal(materializeWrapCli(f.root, vm, { nativeCliOptions: f.opts }).kernel_changed, false)
  const inspection = inspectKernelChanges(f.root, [vm], { nativeCliOptions: f.opts })
  assert.equal(inspection.items[0].kernel_changed, false)
  fs.writeFileSync(path.join(dest, 'glibc239/arm64/bun'), 'broken destination')
  assert.equal(inspectKernelChanges(f.root, [vm], { nativeCliOptions: f.opts }).items[0].kernel_changed, true)
  assert.equal(materializeWrapCli(f.root, vm, { nativeCliOptions: f.opts }).kernel_changed, true)
  assert.equal(materializeWrapCli(f.root, { ...vm, node_id: 'remote-amd64' }, { nativeCliOptions: f.opts }).ok, true)
  assert.equal(fs.readFileSync(path.join(dest, 'cli-node'), 'utf8'), 'x86-cli-node')
})
