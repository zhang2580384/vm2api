import { runFleetUpdateWithDatabase as runFleetUpdate } from '../src/lib/vm/fleet-cli.mjs'

const root = process.argv[2] || '/opt/kin-gateway'
const concurrency = Number(process.argv[3] || 4)
const report = await runFleetUpdate(root, {
  action: 'roll',
  concurrency,
  readyTimeoutMs: 20000,
})
const failed = (report.items || [])
  .filter((row) => !row.ok)
  .map((row) => ({ id: row.id, code: row.code || null, error: row.error || null }))
console.log(
  JSON.stringify({
    action: report.action,
    concurrency: report.concurrency,
    total: report.total,
    ok_count: report.ok_count,
    failed_count: report.failed_count,
    failed,
  }),
)
if (report.failed_count) process.exit(1)
