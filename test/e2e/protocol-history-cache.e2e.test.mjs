import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { OFFICIAL_CLAUDE_CLI_UA } from '../../src/lib/identity/vm-identity.mjs'

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
    path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'v037-history-cache.json'),
    JSON.stringify(evidence, null, 2),
  )
})
const control = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })
const history = () =>
  Array.from({ length: 9 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `FICTIONAL_HISTORY_${i}` }],
  }))
function callerBlocks(body) {
  return (body?.messages || []).flatMap((message) =>
    (message.content || [])
      .filter((block) => block.type === 'text' && /FICTIONAL_HISTORY_\d/.test(block.text))
      .map((block) => ({ role: message.role, ...block })),
  )
}
function anchors(body) {
  return callerBlocks(body)
    .filter((block) => block.cache_control)
    .map((block) => block.text)
}

for (const preset of ['zero', 'official', 'official_full', 'custom']) {
  test(`native ${preset}: history edit TTL and optimization follow caller block identity`, {
    skip: !enabled,
    timeout: 180000,
  }, async () => {
    const chain = await startRealChain({ kernelBin, cliBin, preset, cacheTtl: '1h' })
    const rows = []
    try {
      for (const ttl of [undefined, '5m']) {
        const messages = history()
        messages[2].content[0].cache_control = control('1h')
        messages[8].content[0].cache_control = control(ttl)
        const session = randomUUID()
        for (const edit of [false, true]) {
          if (edit) messages[6].content[0].text = 'FICTIONAL_HISTORY_6_EDITED'
          const result = await chain.send({
            request: {
              headers: { 'x-session-id': session },
              body: { model: 'claude-opus-5-5', max_tokens: 256, stream: true, messages },
            },
          })
          const node = chain.logs.at(-1)?.outbound_body
          rows.push({ kind: 'caller', ttl, edit, node, result })
          assert.equal(result.status, 200, result.response)
          assert.equal(result.count, 1)
          for (const [boundary, body] of [
            ['node', node],
            ['native', result.body],
          ]) {
            const actual = callerBlocks(body)
            assert.deepEqual(
              actual.map(({ role, text }) => ({ role, text })),
              messages.map((message) => ({
                role: message.role,
                text: message.content[0].text,
              })),
              boundary,
            )
            assert.deepEqual(anchors(body), ['FICTIONAL_HISTORY_2', 'FICTIONAL_HISTORY_8'], boundary)
            assert.equal(actual[2].cache_control.ttl, '1h', boundary)
            assert.equal(actual[8].cache_control.ttl || '5m', ttl || '5m', boundary)
          }
        }
      }
      const messages = history()
      const session = randomUUID()
      for (const edit of [false, true]) {
        if (edit) messages[3].content[0].text = 'FICTIONAL_HISTORY_3_EDITED'
        const result = await chain.send({
          request: {
            headers: { 'x-session-id': session },
            body: { model: 'claude-opus-5-5', max_tokens: 256, stream: true, messages },
          },
        })
        const node = chain.logs.at(-1)?.outbound_body
        rows.push({ kind: 'generated', edit, node, result })
        assert.equal(result.status, 200, result.response)
        for (const body of [node, result.body]) {
          assert.deepEqual(
            anchors(body),
            edit ? ['FICTIONAL_HISTORY_2', 'FICTIONAL_HISTORY_8'] : ['FICTIONAL_HISTORY_6', 'FICTIONAL_HISTORY_8'],
          )
          assert.ok(
            callerBlocks(body)
              .filter((block) => block.cache_control)
              .every((block) => block.cache_control.ttl === '1h'),
          )
        }
      }
    } finally {
      evidence.push({ preset, rows })
      await chain.close()
    }
  })
}

for (const [menu, caller, expected] of [
  ['1h', undefined, '1h'],
  ['5m', undefined, '5m'],
  ['1h', '5m', '5m'],
  ['5m', '1h', '1h'],
]) {
  test(`native rewritten official menu=${menu} caller=${caller || 'implicit'} retains tail TTL ${expected}`, {
    skip: !enabled,
    timeout: 60000,
  }, async () => {
    const chain = await startRealChain({ kernelBin, cliBin, preset: 'official_full', cacheTtl: menu })
    let result
    try {
      result = await chain.send({
        request: {
          headers: { 'user-agent': OFFICIAL_CLAUDE_CLI_UA, 'anthropic-beta': 'claude-code-20250219' },
          body: {
            model: 'claude-haiku-5-5',
            max_tokens: 256,
            stream: true,
            system: "You are Claude Code, Anthropic's official CLI for Claude.",
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'FICTIONAL_OFFICIAL_TAIL', cache_control: control(caller) }],
              },
            ],
          },
        },
      })
      assert.equal(result.status, 200, result.response)
      const tail = result.body.messages
        .flatMap((message) => message.content || [])
        .find((block) => block.text === 'FICTIONAL_OFFICIAL_TAIL')
      assert.ok(tail)
      assert.equal(tail.cache_control.ttl, expected)
    } finally {
      evidence.push({ menu, caller, expected, node: chain.logs.at(-1)?.outbound_body, result })
      await chain.close()
    }
  })
}

for (const inline of [false, true]) {
  test(`native inline tool_definition=${inline} controls the request beta`, {
    skip: !enabled,
    timeout: 60000,
  }, async () => {
    const chain = await startRealChain({ kernelBin, cliBin, preset: 'zero' })
    let result
    try {
      const messages = [{ role: 'user', content: 'FICTIONAL_INLINE_USER' }]
      if (inline)
        messages.push(
          {
            role: 'system',
            content: [
              {
                type: 'tool_addition',
                tool: {
                  type: 'tool_definition',
                  name: 'fixture_inline',
                  description: 'Fictional offline tool',
                  input_schema: { type: 'object' },
                },
              },
            ],
          },
          { role: 'user', content: 'FICTIONAL_INLINE_CONTINUE' },
        )
      result = await chain.send({
        request: {
          body: {
            model: 'claude-haiku-5-5',
            max_tokens: 256,
            stream: true,
            messages,
          },
        },
      })
      assert.equal(result.status, 200, result.response)
      assert.equal(result.count, 1)
      const betas = String(result.headers['anthropic-beta'] || '').split(',')
      assert.equal(betas.includes('inline-tools-2026-09-15'), inline)
      const additions = (result.body.messages || [])
        .flatMap((message) => message.content || [])
        .filter((block) => block.type === 'tool_addition')
      assert.equal(additions.length, inline ? 1 : 0)
      if (inline) assert.equal(additions[0].tool.type, 'tool_definition')
    } finally {
      evidence.push({ inline, node: chain.logs.at(-1)?.outbound_body, result })
      await chain.close()
    }
  })
}
