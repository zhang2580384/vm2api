import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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
    path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'v038-missing-ttl-policy.json'),
    JSON.stringify(evidence, null, 2),
  )
})

function callerBlocks(body) {
  return (body?.messages || []).flatMap((message) =>
    (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [])
      .filter((block) => block.type === 'text' && /FICTIONAL_V038_HISTORY_\d/.test(block.text))
      .map((block) => ({ role: message.role, ...block })),
  )
}

// This characterizes the new rewritten-third-party policy separately. The old
// implicit-5m assertions in protocol-history-cache remain unchanged and must fail
// visibly when the new policy changes that contract. System TTL is a separate gate.
for (const preset of ['zero', 'official', 'official_full', 'custom']) {
  test(`native ${preset}: new missing-TTL policy and explicit caller TTL through history edits`, {
    skip: !enabled,
    timeout: 180000,
  }, async () => {
    const chain = await startRealChain({
      kernelBin,
      cliBin,
      preset,
      routingBase: { sticky: { outbound_session: 'passthrough' } },
    })
    const rows = []
    try {
      for (const menu of ['5m', '1h']) {
        chain.setCacheTtl(menu)
        for (const ttl of [undefined, '5m', '1h']) {
          const messages = Array.from({ length: 9 }, (_, i) => ({
            role: i % 2 ? 'assistant' : 'user',
            content: [{ type: 'text', text: `FICTIONAL_V038_HISTORY_${i}` }],
          }))
          messages[2].content[0].cache_control = { type: 'ephemeral', ttl: '1h' }
          messages[8].content[0].cache_control = { type: 'ephemeral', ...(ttl ? { ttl } : {}) }
          const session = randomUUID()
          for (const edit of [false, true]) {
            if (edit) messages[6].content[0].text = 'FICTIONAL_V038_HISTORY_6_EDITED'
            const result = await chain.send({
              request: {
                headers: { 'x-session-id': session },
                body: { model: 'claude-opus-5-5', max_tokens: 256, stream: true, messages },
              },
            })
            const node = chain.logs.at(-1)?.outbound_body
            const prefix = chain.logs.at(-1)?.cache_prefix
            rows.push({ menu, ttl, edit, node, prefix, result })
            assert.equal(result.status, 200, result.response)
            assert.equal(result.count, 1)
            assert.equal(prefix?.turn, edit ? 2 : 1)
            for (const [boundary, body] of [
              ['node', node],
              ['native', result.body],
            ]) {
              const actual = callerBlocks(body)
              assert.deepEqual(
                actual.map(({ role, text }) => ({ role, text })),
                messages.map((message) => ({ role: message.role, text: message.content[0].text })),
                boundary,
              )
              assert.deepEqual(
                actual.filter((block) => block.cache_control).map((block) => block.text),
                ['FICTIONAL_V038_HISTORY_2', 'FICTIONAL_V038_HISTORY_8'],
                boundary,
              )
              assert.equal(actual[2].cache_control.ttl, '1h', boundary)
              assert.equal(actual[8].cache_control.ttl, ttl || menu, boundary)
            }
          }
        }
      }
    } finally {
      evidence.push({ preset, rows })
      await chain.close()
    }
  })
}
