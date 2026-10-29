/**
 * Align remaining slots to the vm-05/13/30 init+telemetry contract.
 * Never touches SKIP (in-pool). Never docker rm. Never restarts kin-gateway.
 * Official ~/.claude.json IDs only — no invented sidecar identity.
 *
 *   node scripts/align-remaining-slots.mjs --dry
 *   node scripts/align-remaining-slots.mjs
 */
import { execFileSync } from 'node:child_process'
import { finalizeOfficialCcTelemetry, officialCcHome } from '../src/lib/oauth/official-cc-bootstrap.mjs'
import { readOfficialCcIdentity } from '../src/lib/identity/official-fingerprint.mjs'
import { listVms, getVm } from '../src/lib/vm/vm-registry.mjs'
import { containerName } from '../src/lib/vm/vm-runtime.mjs'
import { runFleetUpdateWithDatabase as runFleetUpdate } from '../src/lib/vm/fleet-cli.mjs'

const ROOT = process.argv.find((a) => a.startsWith('--root='))?.slice(7) || '/opt/kin-gateway'
const DRY = process.argv.includes('--dry')
const SKIP = new Set(
  (process.argv.find((a) => a.startsWith('--skip='))?.slice(7) || 'vm-05,vm-13,vm-30')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

function hasSocks5(vm) {
  const px = vm?.proxy || {}
  return !!(px.host && px.port)
}

function hasOfficial(projectRoot, vmId) {
  const ids = readOfficialCcIdentity(officialCcHome(projectRoot, vmId))
  return !!(ids.user_id || ids.machine_id)
}

function sh(argv, timeout = 20_000) {
  try {
    execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message || e).slice(0, 200) }
  }
}

function sidecarRunning(name) {
  try {
    const out = execFileSync('docker', ['exec', name, 'ps', '-eo', 'args'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return /kin-worker/.test(out) && /telemetry/.test(out)
  } catch {
    return false
  }
}

const all = listVms(ROOT)
  .map((row) => getVm(ROOT, row.id))
  .filter((vm) => vm?.id)
const targets = all.filter((vm) => !SKIP.has(vm.id))
const proxyIds = targets.filter(hasSocks5).map((vm) => vm.id)
const unofficialSidecar = []

console.log(
  JSON.stringify({
    dry: DRY,
    skip: [...SKIP],
    total: all.length,
    targets: targets.length,
    proxy_reload: proxyIds,
  }),
)

const disk = []
for (const vm of targets) {
  const official = hasOfficial(ROOT, vm.id)
  const name = containerName(vm.id)
  const hadSidecar = sidecarRunning(name)
  if (hadSidecar && !official) unofficialSidecar.push(vm.id)
  if (DRY) {
    disk.push({
      id: vm.id,
      official,
      proxy: hasSocks5(vm),
      had_sidecar: hadSidecar,
      action: official ? 'finalize' : 'finalize_wait_official',
    })
    continue
  }
  const out = finalizeOfficialCcTelemetry(ROOT, vm.id, { reload: false, enable: true })
  disk.push({
    id: vm.id,
    official,
    proxy: hasSocks5(vm),
    had_sidecar: hadSidecar,
    enabled: out.enabled,
    wrote: out.wrote,
    seed_aligned: out.seed_aligned,
  })
}

const killed = []
if (!DRY) {
  for (const id of unofficialSidecar) {
    const name = containerName(id)
    const r = sh(['docker', 'exec', name, 'pkill', '-f', 'kin-worker telemetry'], 8000)
    killed.push({ id, ok: r.ok || !sidecarRunning(name) })
  }
}

let roll = null
if (!DRY && proxyIds.length) {
  roll = await runFleetUpdate(ROOT, {
    action: 'roll',
    ids: proxyIds,
    concurrency: 3,
    readyTimeoutMs: 20000,
  })
}

const leftoverSidecar = unofficialSidecar.filter((id) => sidecarRunning(containerName(id)))
const skipSidecar = [...SKIP].map((id) => ({ id, sidecar: sidecarRunning(containerName(id)) }))

const report = {
  dry: DRY,
  skip: [...SKIP],
  disk_aligned: disk.length,
  official_on_targets: disk.filter((r) => r.official).map((r) => r.id),
  unofficial_sidecar_killed: DRY ? unofficialSidecar : killed,
  leftover_unofficial_sidecar: leftoverSidecar,
  proxy_roll: roll
    ? {
        total: roll.total,
        ok_count: roll.ok_count,
        failed_count: roll.failed_count,
        failed: (roll.items || []).filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error, code: r.code })),
      }
    : { planned: proxyIds },
  skip_still: skipSidecar,
}
console.log(JSON.stringify(report, null, 2))
if (!DRY && leftoverSidecar.length) process.exit(2)
if (!DRY && roll?.failed_count) process.exit(1)
