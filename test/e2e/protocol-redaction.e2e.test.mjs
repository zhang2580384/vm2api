import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ensureRedaction, publishRedactionForTests } from '../../src/lib/redaction/runtime.mjs'

const enabled = Boolean(process.env.KIN_303_KERNEL && process.env.KIN_303_CLI && process.env.KIN_REDACT_BIN)
const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
const evidence = []
if (enabled) openDatabase({ dbPath: ':memory:' })
test.after(() => {
  if (enabled) closeDatabase()
  if (!process.env.KIN_PROTOCOL_EVIDENCE_DIR) return
  fs.mkdirSync(process.env.KIN_PROTOCOL_EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'redaction-native.json'),
    JSON.stringify(evidence, null, 2),
  )
})

function echoSse(body) {
  const raw = JSON.stringify(body)
  const tag = raw.match(/\{\{R_API_KEY_[a-z2-7]{26}\}\}/)?.[0] || secret
  const pieces = [tag.slice(0, 12), tag.slice(12)]
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fictional_redact',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...pieces.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function visibleText(response, stream, chat) {
  if (!stream) {
    const body = JSON.parse(response)
    return chat ? body.choices[0].message.content : body.content.map((block) => block.text || '').join('')
  }
  return response
    .split('\n')
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .flatMap((line) => {
      const event = JSON.parse(line.slice(5))
      return chat ? [event.choices?.[0]?.delta?.content || ''] : [event.delta?.text || '']
    })
    .join('')
}

for (const chat of [false, true]) {
  for (const stream of [false, true]) {
    test(`native redaction ${chat ? 'Chat' : 'Messages'} stream=${stream}: masks outbound and restores split tags`, {
      skip: !enabled,
      timeout: 45000,
    }, async () => {
      const chain = await startRealChain({
        kernelBin: process.env.KIN_303_KERNEL,
        cliBin: process.env.KIN_303_CLI,
        preset: 'official',
        routingBase: { redaction: policy },
        upstreamSse: echoSse,
      })
      let helper = null
      try {
        const result = await chain.send({
          request: {
            path: chat ? '/v1/chat/completions' : '/v1/messages',
            headers: { 'x-claude-code-session-id': 'fictional-redaction-session' },
            body: {
              model: 'claude-sonnet-5',
              max_tokens: 128,
              stream,
              messages: [{ role: 'user', content: `FICTIONAL redaction ${secret}` }],
            },
          },
        })
        helper = (await ensureRedaction({ redaction: policy })).child
        evidence.push({ chat, stream, result })
        assert.equal(result.status, 200, result.response)
        assert.equal(result.count, 1)
        assert.equal(result.raw.includes(secret), false)
        assert.match(result.raw, /\{\{R_API_KEY_[a-z2-7]{26}\}\}/)
        assert.match(result.raw, /FICTIONAL redaction/)
        assert.equal(visibleText(result.response, stream, chat), secret)
      } finally {
        helper?.kill()
        publishRedactionForTests(null)
        await chain.close()
      }
    })
  }
}

test('native redaction default-off retains fictional caller text and does not need the helper', {
  skip: !enabled,
  timeout: 45000,
}, async () => {
  const chain = await startRealChain({
    kernelBin: process.env.KIN_303_KERNEL,
    cliBin: process.env.KIN_303_CLI,
    preset: 'official',
    upstreamSse: echoSse,
  })
  try {
    const result = await chain.send({
      request: {
        body: {
          model: 'claude-sonnet-5',
          max_tokens: 128,
          stream: false,
          messages: [{ role: 'user', content: `FICTIONAL ${secret}` }],
        },
      },
    })
    evidence.push({ off: true, result })
    assert.equal(result.status, 200, result.response)
    assert.equal(result.count, 1)
    assert.ok(result.raw.includes(secret))
    assert.equal(visibleText(result.response, false, false), secret)
  } finally {
    publishRedactionForTests(null)
    await chain.close()
  }
})
