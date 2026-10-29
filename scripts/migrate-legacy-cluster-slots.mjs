#!/usr/bin/env node

/**
 * Migrate legacy cluster slot containers to the persistent Go-service mount.
 * This never rebuilds a VM: the old container is renamed and retained as a
 * stopped rollback copy, while the replacement reuses its image and settings.
 */
import { runFleetUpdateWithDatabase as runFleetUpdate } from '../src/lib/vm/fleet-cli.mjs'

const root = process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api'
const concurrency = Number(process.argv[3] || process.env.KIN_FLEET_CONCURRENCY || 4)
const ids = process.argv
  .slice(4)
  .flatMap((value) => String(value).split(','))
  .map((value) => value.trim())
  .filter(Boolean)

const report = await runFleetUpdate(root, {
  action: 'telemetry',
  concurrency,
  ids: ids.length ? ids : null,
})
console.log(JSON.stringify(report))
if (report.failed_count) process.exitCode = 1
