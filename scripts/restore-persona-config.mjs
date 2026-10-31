import path from 'node:path'
import { restorePersonaConfigFile } from '../src/lib/admin/persona-config-migration.mjs'

const [file, id] = process.argv.slice(2)
if (!file || !id) {
  console.error(
    'Stop the gateway first. Usage: node scripts/restore-persona-config.mjs <routing.json> <snapshot-sha256>',
  )
  process.exit(2)
}
console.log(JSON.stringify(restorePersonaConfigFile(path.resolve(file), id)))
