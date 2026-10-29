import fs from 'node:fs'
import path from 'node:path'
import { closeDatabase, getDbPath, isDbOpen, openDatabase, resolveDbPath } from '../db/database.mjs'
import { runFleetUpdate } from './fleet-update.mjs'

/** Standalone maintenance must load the same settings database as the panel. */
export async function runFleetUpdateWithDatabase(projectRoot, options = {}) {
  const dataDir = path.join(projectRoot, 'data')
  const dbPath = resolveDbPath({ dataDir })
  const ownsDatabase = !isDbOpen()
  if (!ownsDatabase && path.resolve(getDbPath()) !== path.resolve(dbPath))
    throw new Error('fleet maintenance database does not match the project')
  if (ownsDatabase && !fs.existsSync(dbPath)) throw new Error('fleet maintenance requires an existing project database')
  if (ownsDatabase) openDatabase({ dataDir, dbPath })
  try {
    return await runFleetUpdate(projectRoot, options)
  } finally {
    if (ownsDatabase) closeDatabase()
  }
}
