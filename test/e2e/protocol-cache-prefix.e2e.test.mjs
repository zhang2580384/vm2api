import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

const kernelBin = process.env.KIN_303_KERNEL
const cliBin = process.env.KIN_303_CLI
const enabled = Boolean(kernelBin && cliBin)
const evidence = []
if (enabled) openDatabase({ dbPath: ':memory:' })

test.after(() => {
  if (enabled) closeDatabase()
  if (!process.env.KIN_PROTOCOL_EVIDENCE_DIR) return
  fs.mkdirSync(process.env.KIN_PROTOCOL_EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'pr854-native.json'),
    JSON.stringify(evidence, null, 2),
  )
})

// The cache-prefix tracker explicitly ignores marker movement. Retain all
// roles, text, ordering, and other fields; only remove cache_control here.
function withoutCache(value) {
  if (Array.isArray(value)) return value.map(withoutCache)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, child]) => [key, withoutCache(child)]),
  )
}

for (const entry of [
  { preset: 'official', environment: true, stable: true },
  { preset: 'official_full', environment: true, stable: true },
  { preset: 'official_full', environment: false, stable: true },
  { preset: 'zero', environment: true, stable: false },
]) {
  test(`native ${entry.preset} env=${entry.environment}: multi-turn Environment position and caller reminders`, {
    skip: !enabled,
    timeout: 120000,
  }, async () => {
    const chain = await startRealChain({
      kernelBin,
      cliBin,
      preset: entry.preset,
      timezone: 'Pacific/Honolulu',
      routingBase: {
        compatibility: {
          persona_env_presets: { [entry.preset]: entry.environment },
          persona_timezone_presets: { [entry.preset]: entry.environment },
          persona_env_instructions_presets: { [entry.preset]: entry.environment },
        },
      },
    })
    const rows = []
    const differences = []
    let previous
    const session = randomUUID()
    const history = []
    try {
      for (let turn = 0; turn < 3; turn++) {
        history.push(
          { role: 'user', content: [{ type: 'text', text: `FICTIONAL_PREFIX_USER_${turn}` }] },
          { role: 'system', content: [{ type: 'text', text: `FICTIONAL_PREFIX_CALLER_REMINDER_${turn}` }] },
        )
        const body = {
          model: 'claude-haiku-5-5',
          max_tokens: 256,
          stream: true,
          system: 'FICTIONAL_PREFIX_CALLER_RULES',
          metadata: { user_id: JSON.stringify({ device_id: 'fixture-device', session_id: session }) },
          messages: structuredClone(history),
        }
        const result = await chain.send({ request: { path: '/v1/messages', body } })
        const nodeBody = chain.logs.at(-1)?.outbound_body
        const row = { turn, entry, result, node_body: nodeBody }
        rows.push(row)
        assert.equal(result.status, 200, result.response)
        assert.equal(result.count, 1)
        const current = { node: withoutCache(nodeBody?.messages), native: withoutCache(result.body?.messages) }
        for (const [boundary, messages] of Object.entries(current)) {
          assert.ok(Array.isArray(messages), `${boundary} must contain a real transcript`)
          const serialized = JSON.stringify(messages)
          for (let seen = 0; seen <= turn; seen++) {
            assert.equal(serialized.split(`FICTIONAL_PREFIX_USER_${seen}`).length - 1, 1)
            assert.equal(serialized.split(`FICTIONAL_PREFIX_CALLER_REMINDER_${seen}`).length - 1, 1)
          }
          if (
            entry.stable &&
            previous &&
            JSON.stringify(messages.slice(0, previous[boundary].length)) !== JSON.stringify(previous[boundary])
          ) {
            const index = previous[boundary].findIndex(
              (message, at) => JSON.stringify(message) !== JSON.stringify(messages[at]),
            )
            differences.push({ turn, boundary, index, before: previous[boundary][index], after: messages[index] })
          }
        }
        previous = current
        history.push({ role: 'assistant', content: [{ type: 'text', text: `FICTIONAL_PREFIX_ASSISTANT_${turn}` }] })
      }
      assert.deepEqual(
        differences,
        [],
        'Previous transcript must remain an unchanged cache prefix after marker removal',
      )
    } finally {
      evidence.push({ entry, rows, differences })
      await chain.close()
    }
  })
}
