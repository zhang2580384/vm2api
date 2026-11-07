import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

openDatabase({ dbPath: ':memory:' })
const rows = []
test.after(() => {
  closeDatabase()
  if (process.env.KIN_PROTOCOL_EVIDENCE_DIR)
    fs.writeFileSync(process.env.KIN_PROTOCOL_EVIDENCE_DIR + '/cache-budget-native.json', JSON.stringify(rows, null, 2))
})
function markers(body) {
  return [
    ...(body.system || [])
      .filter((b) => b.cache_control)
      .map((b) => ({ section: 'system', text: b.text, cache_control: b.cache_control })),
    ...(body.tools || [])
      .filter((b) => b.cache_control)
      .map((b) => ({ section: 'tools', name: b.name, cache_control: b.cache_control })),
    ...(body.messages || []).flatMap((m, index) =>
      (Array.isArray(m.content) ? m.content : [])
        .filter((b) => b.cache_control)
        .map((b) => ({ section: 'messages', index, text: b.text, cache_control: b.cache_control })),
    ),
  ]
}
function callers(body) {
  return (body.messages || []).flatMap((m) =>
    (typeof m.content === 'string' ? [{ text: m.content }] : m.content || [])
      .filter((b) => /^FICTIONAL_PR917_/.test(b.text || ''))
      .map((b) => ({ role: m.role, ...b })),
  )
}
for (const preset of ['official', 'official_full']) {
  for (const ttl of ['5m', '1h']) {
    for (const stream of [false, true]) {
      for (const anchors of [
        [0, 1, 2, 3],
        [0, 1, 4],
      ]) {
        test(`${preset} ${ttl} stream=${stream} anchors=${anchors.join(',')}: final native marker budget`, {
          timeout: 45000,
        }, async () => {
          const chain = await startRealChain({
            kernelBin: process.env.KIN_303_KERNEL,
            cliBin: process.env.KIN_303_CLI,
            preset,
            cacheTtl: ttl,
          })
          try {
            const messages = Array.from({ length: 5 }, (_, i) => ({
              role: i % 2 ? 'assistant' : 'user',
              content: [
                {
                  type: 'text',
                  text: `FICTIONAL_PR917_${i}`,
                  ...(anchors.includes(i) ? { cache_control: { type: 'ephemeral', ttl } } : {}),
                },
              ],
            }))
            const result = await chain.send({
              request: { body: { model: 'claude-opus-5-5', max_tokens: 128, stream, messages } },
            })
            const node = chain.logs.at(-1)?.outbound_body
            const row = {
              preset,
              ttl,
              stream,
              anchors,
              result,
              node,
              nodeMarkers: markers(node),
              nativeMarkers: markers(result.body),
            }
            rows.push(row)
            assert.equal(result.status, 200, result.response)
            assert.equal(result.count, 1)
            assert.ok(row.nativeMarkers.length <= 4, JSON.stringify(row.nativeMarkers))
            assert.ok(row.nativeMarkers.some((m) => m.section === 'system'))
            assert.deepEqual(
              callers(result.body).map(({ role, text }) => ({ role, text })),
              messages.map((m) => ({ role: m.role, text: m.content[0].text })),
            )
            const retained = callers(result.body).filter((b) => b.cache_control)
            assert.deepEqual(
              retained.map((b) => b.text),
              anchors.slice(-2).map((i) => `FICTIONAL_PR917_${i}`),
            )
            assert.ok(retained.every((b) => b.cache_control.ttl === ttl))
          } finally {
            await chain.close()
          }
        })
      }
    }
  }
}
