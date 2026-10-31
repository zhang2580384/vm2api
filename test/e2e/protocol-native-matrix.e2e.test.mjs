import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { OFFICIAL_AUTO_MODE_REMINDER } from '../../src/lib/protocol/auto-mode-reminder.mjs'

const kernelBin = process.env.KIN_303_KERNEL
const cliBin = process.env.KIN_303_CLI
const enabled = Boolean(kernelBin && cliBin)
if (enabled) openDatabase({ dbPath: ':memory:' })
test.after(() => {
  if (enabled) closeDatabase()
})

function markers(value, out = []) {
  if (!value || typeof value !== 'object') return out
  if (value.cache_control) out.push(value.cache_control)
  for (const [name, child] of Object.entries(value)) if (name !== 'cache_control') markers(child, out)
  return out
}

const ttlCases = [
  { menu: '5m', caller: undefined, header: undefined, expected: '5m' },
  { menu: '1h', caller: undefined, header: undefined, expected: '1h' },
  { menu: '1h', caller: '5m', header: undefined, expected: '5m' },
  { menu: '5m', caller: '1h', header: undefined, expected: '1h' },
  { menu: '1h', caller: '1h', header: '5m', expected: '5m' },
]

for (const preset of ['zero', 'official', 'official_full']) {
  test(`native ${preset}: repeated turns preserve history and header/caller/menu TTL precedence`, {
    skip: !enabled,
    timeout: 180000,
  }, async () => {
    const chain = await startRealChain({ kernelBin, cliBin, preset })
    const differences = []
    const evidence = []
    try {
      for (const entry of ttlCases) {
        chain.setCacheTtl(entry.menu)
        const history = [{ role: 'user', content: [{ type: 'text', text: 'FICTIONAL_FIRST_TURN' }] }]
        const staticText = 'FICTIONAL_CALLER_STATIC_SYSTEM'
        const session = randomUUID()
        let previousHarness
        for (let turn = 0; turn < 3; turn++) {
          const body = {
            model: 'claude-haiku-5-5',
            max_tokens: 256,
            stream: true,
            metadata: {
              user_id: JSON.stringify({
                device_id: 'fictional-device',
                account_uuid: 'fictional-account',
                session_id: session,
              }),
            },
            system: [
              {
                type: 'text',
                text: staticText,
                cache_control: {
                  type: 'ephemeral',
                  ...(entry.caller ? { ttl: entry.caller } : {}),
                },
              },
            ],
            messages: structuredClone(history),
          }
          const response = await chain.send({
            request: {
              path: '/v1/messages',
              headers: entry.header ? { 'x-kin-cache-ttl': entry.header } : {},
              body,
            },
          })
          assert.equal(response.status, 200, response.response)
          assert.equal(response.count, 1)
          const wire = JSON.stringify(response.body)
          assert.equal(wire.split(staticText).length - 1, 1)
          assert.equal(wire.split('FICTIONAL_FIRST_TURN').length - 1, 1)
          if (turn) assert.ok(wire.includes(`FICTIONAL_NEXT_${turn}`))
          const controls = markers(response.body)
          assert.ok(controls.length >= 1 && controls.length <= 4)
          const row = { preset, entry, turn, controls, node_body: chain.logs.at(-1)?.outbound_body }
          evidence.push(row)
          if (!controls.every((control) => control.type === 'ephemeral' && control.ttl === entry.expected)) {
            differences.push({ entry, turn, controls })
          }
          const harness = response.body.system
            .slice(1)
            .filter((block) => !String(block.text).includes(staticText))
            .map((block) => block.text)
          if (previousHarness !== undefined) assert.deepEqual(harness, previousHarness)
          previousHarness = harness
          assert.match(response.headers['user-agent'], /^claude-cli\//)
          assert.match(response.body.system[0].text, /^x-anthropic-billing-header:/)
          history.push(
            { role: 'assistant', content: 'FICTIONAL_PREVIOUS_RESPONSE' },
            { role: 'user', content: `FICTIONAL_NEXT_${turn + 1}` },
          )
        }
      }
      assert.deepEqual(differences, [], 'Final native TTL differs from the requested cache policy')
    } finally {
      if (process.env.KIN_PROTOCOL_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.KIN_PROTOCOL_EVIDENCE_DIR, { recursive: true })
        fs.writeFileSync(
          path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, `${preset}-native-cache.json`),
          JSON.stringify(evidence, null, 2),
        )
      }
      await chain.close()
    }
  })
}

test('native reasoning and forced-tool contracts retain caller effort, strictness, and early rejection', {
  skip: !enabled,
  timeout: 90000,
}, async () => {
  const chain = await startRealChain({ kernelBin, cliBin, preset: 'official_full' })
  try {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
      for (const effort of ['low', 'high']) {
        const response = await chain.send({
          request: {
            path: '/v1/messages',
            body: {
              model,
              max_tokens: 256,
              stream: true,
              messages: [{ role: 'user', content: 'FICTIONAL_EFFORT' }],
              output_config: { effort },
              tools: [{ name: 'fixture_tool', input_schema: { type: 'object', properties: {} }, strict: false }],
              ...(model.includes('haiku')
                ? { thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'fixture_tool' } }
                : {}),
            },
          },
        })
        assert.equal(response.status, 200, response.response)
        assert.equal(response.body.output_config.effort, effort)
        assert.equal(response.body.tools[0].strict, false)
        if (model.includes('haiku')) assert.deepEqual(response.body.tool_choice, { type: 'tool', name: 'fixture_tool' })
      }
    }
    const rejected = await chain.send({
      request: {
        path: '/v1/messages',
        body: {
          model: 'claude-sonnet-5-5',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'FICTIONAL_REJECTION' }],
          tools: [{ name: 'fixture_tool', input_schema: { type: 'object', properties: {} } }],
          tool_choice: { type: 'tool', name: 'fixture_tool' },
        },
      },
    })
    assert.equal(rejected.status, 400, rejected.response)
    assert.equal(rejected.count, 0)
    assert.match(rejected.response, /tool_choice_incompatible/)
  } finally {
    await chain.close()
  }
})

test('native CLI retains one exact official auto-mode reminder and removes obsolete echoes', {
  skip: !enabled,
  timeout: 60000,
}, async () => {
  const chain = await startRealChain({ kernelBin, cliBin, preset: 'zero' })
  try {
    const old = '<system-reminder>\nAuto mode still active (reported by harness).\n</system-reminder>'
    const response = await chain.send({
      request: {
        path: '/v1/messages',
        body: {
          model: 'claude-haiku-5-5',
          max_tokens: 256,
          stream: true,
          messages: [{ role: 'user', content: `${old}\n${old}\nFICTIONAL_CONTINUE` }],
        },
      },
    })
    assert.equal(response.status, 200, response.response)
    const wire = JSON.stringify(response.body)
    const exact = JSON.stringify(OFFICIAL_AUTO_MODE_REMINDER).slice(1, -1)
    assert.equal(wire.split(exact).length - 1, 1)
    assert.equal(wire.includes('reported by harness'), false)
    assert.equal(wire.includes('Auto mode is active. The user chose continuous, autonomous execution.'), false)
    assert.equal(wire.includes('FICTIONAL_CONTINUE'), true)
  } finally {
    await chain.close()
  }
})
