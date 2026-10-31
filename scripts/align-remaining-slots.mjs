/**
 * Publish existing VM telemetry policies to native owners without opting in,
 * rotating identities, restarting guests/egress, or generating activity.
 *
 *   node scripts/align-remaining-slots.mjs --dry
 *   node scripts/align-remaining-slots.mjs --root=/opt/kin-gateway
 */
import { listVms, getVm } from '../src/lib/vm/vm-registry.mjs'
import { runFleetUpdateWithDatabase as runFleetUpdate } from '../src/lib/vm/fleet-cli.mjs'
import { normalizeVmKind } from '../src/lib/vm/vm-kind.mjs'
import { slotHost } from '../src/lib/vm/slot-host.mjs'

const ROOT = process.argv.find((a) => a.startsWith('--root='))?.slice(7) || '/opt/kin-gateway'
const DRY = process.argv.includes('--dry')
const SKIP = new Set(
  (process.argv.find((a) => a.startsWith('--skip='))?.slice(7) || 'vm-05,vm-13,vm-30')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
const targets = listVms(ROOT)
  .map((row) => getVm(ROOT, row.id))
  .filter((vm) => vm?.id && !SKIP.has(vm.id))
const supported = targets.filter((vm) => normalizeVmKind(vm).platform === 'anthropic' && !slotHost(vm).native)

if (DRY) {
  console.log(
    JSON.stringify(
      {
        dry: true,
        skip: [...SKIP],
        targets: supported.map((vm) => ({ id: vm.id, enabled: vm.seed_policy?.telemetry_disabled === false })),
        unsupported: targets.filter((vm) => !supported.includes(vm)).map((vm) => vm.id),
      },
      null,
      2,
    ),
  )
} else {
  const report = supported.length
    ? await runFleetUpdate(ROOT, {
        action: 'telemetry',
        ids: supported.map((vm) => vm.id),
        concurrency: 3,
      })
    : { total: 0, ok_count: 0, failed_count: 0, items: [] }
  console.log(
    JSON.stringify(
      {
        total: report.total,
        ok_count: report.ok_count,
        failed_count: report.failed_count,
        items: report.items.map((row) => ({
          id: row.id,
          ok: row.ok,
          enabled: row.telemetry?.enabled === true,
          published: row.telemetry?.published === true,
          applied: row.telemetry?.applied === true,
          state: row.telemetry?.state || null,
          error: row.ok ? null : row.code || 'telemetry_publish_failed',
        })),
      },
      null,
      2,
    ),
  )
  if (report.failed_count) process.exitCode = 1
}
