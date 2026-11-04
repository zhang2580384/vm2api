import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'

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
    path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'thinking-prune-native.json'),
    JSON.stringify(evidence, null, 2),
  )
})

const ordinary = () => ({
  model: 'claude-sonnet-5-5',
  max_tokens: 256,
  stream: true,
  messages: [{ role: 'user', content: 'FICTIONAL_BETWEEN_TOOLS_PROMPT' }],
})
const officialHeaders = {
  'user-agent': 'claude-cli/2.1.303 (external, cli)',
  'anthropic-beta': 'claude-code-20250219',
}
async function send(chain, rows, body, headers = {}, requestPath = '/v1/messages') {
  const result = await chain.send({ request: { path: requestPath, headers, body } })
  rows.push({ body, headers, path: requestPath, result, log: chain.logs.at(-1) })
  return result
}
async function fixture(label, routingBase, fn) {
  const rows = []
  const chain = await startRealChain({ kernelBin, cliBin, preset: 'official_full', routingBase })
  try {
    await fn(chain, rows)
  } finally {
    evidence.push({ label, rows })
    await chain.close()
  }
}

for (const display of ['summarized', 'passthrough']) {
  test(
    `native between_tools: ordinary Sonnet55 preserves type and effort with ${display}`,
    {
      skip: !enabled,
      timeout: 120000,
    },
    () =>
      fixture(`ordinary-${display}`, { compatibility: { thinking_display: display } }, async (chain, rows) => {
        for (const effort of ['low', 'high']) {
          const result = await send(chain, rows, {
            ...ordinary(),
            thinking: { type: 'between_tools' },
            output_config: { effort },
          })
          assert.equal(result.status, 200, result.response)
          assert.equal(result.count, 1)
          for (const [boundary, body] of [
            ['node', chain.logs.at(-1)?.outbound_body],
            ['native', result.body],
          ]) {
            assert.deepEqual(body.thinking, { type: 'between_tools' }, boundary)
            assert.equal(body.output_config.effort, effort, boundary)
            assert.equal(body.max_tokens, 256, boundary)
          }
        }
      }),
  )

  test(
    `native between_tools: official auto classifier preserves type and budget with ${display}`,
    {
      skip: !enabled,
      timeout: 120000,
    },
    () =>
      fixture(`classifier-${display}`, { compatibility: { thinking_display: display } }, async (chain, rows) => {
        const input = {
          ...classifierFixture({ model: 'claude-sonnet-5-5' }),
          thinking: { type: 'between_tools' },
          output_config: { effort: 'high' },
          metadata: { user_id: { device_id: 'fictional-device', session_id: 'fictional-session' } },
        }
        const result = await send(chain, rows, input, officialHeaders)
        assert.equal(result.status, 200, result.response)
        assert.equal(result.count, 1)
        for (const [boundary, body] of [
          ['node', chain.logs.at(-1)?.outbound_body],
          ['native', result.body],
        ]) {
          assert.deepEqual(body.thinking, { type: 'between_tools' }, boundary)
          assert.equal(body.max_tokens, 64, boundary)
          assert.equal(body.output_config.effort, 'high', boundary)
          assert.deepEqual(body.stop_sequences, input.stop_sequences, boundary)
        }
      }),
  )
}

for (const classifier of [false, true]) {
  test(
    `native between_tools: ${classifier ? 'classifier' : 'ordinary'} rejects invalid contracts before native`,
    {
      skip: !enabled,
      timeout: 120000,
    },
    () =>
      fixture(`invalid-${classifier}`, null, async (chain, rows) => {
        for (const invalid of [
          { model: 'claude-opus-5-5' },
          { output_config: { effort: 'max' } },
          { thinking: { type: 'between_tools', budget_tokens: 1024 } },
          { thinking: { type: 'between_tools', display: 'omitted' } },
        ]) {
          const input = {
            ...(classifier ? classifierFixture({ model: 'claude-sonnet-5-5' }) : ordinary()),
            thinking: { type: 'between_tools' },
            ...invalid,
          }
          if (classifier)
            input.metadata = { user_id: { device_id: 'fictional-device', session_id: 'fictional-session' } }
          const result = await send(chain, rows, input, classifier ? officialHeaders : {})
          assert.equal(result.status, 400, result.response)
          assert.equal(result.count, 0)
          assert.equal(
            JSON.parse(result.response).error.code,
            classifier ? 'classifier_model_incompatible' : 'thinking_incompatible',
          )
        }
      }),
  )
}

test(
  'native thinking display: routing and kernel config hot-switch summarized and passthrough',
  {
    skip: !enabled,
    timeout: 120000,
  },
  () =>
    fixture('thinking-display', { compatibility: { thinking_display: 'passthrough' } }, async (chain, rows) => {
      for (const mode of ['passthrough', 'summarized', 'passthrough']) {
        chain.setThinkingDisplay(mode)
        const result = await send(chain, rows, { ...ordinary(), thinking: { type: 'adaptive', display: 'omitted' } })
        assert.equal(result.status, 200, result.response)
        assert.equal(result.count, 1)
        for (const [boundary, body] of [
          ['node', chain.logs.at(-1)?.outbound_body],
          ['native', result.body],
        ])
          assert.equal(body.thinking.display, mode === 'summarized' ? 'summarized' : 'omitted', boundary)
      }
    }),
)

const ORIGINAL = 'FICTIONAL_FILE_OUTPUT\n' + '0123456789abcdef'.repeat(900)
const PRUNED = ORIGINAL.slice(0, 4096) + '\n\n[... tool result middle pruned ...]\n\n' + ORIGINAL.slice(-1024)
function toolBody(protocol, content, tail = false) {
  const messages =
    protocol === 'chat'
      ? [
          { role: 'user', content: 'FICTIONAL_READ_FILE' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'read-1', content },
        ]
      : [
          { role: 'user', content: 'FICTIONAL_READ_FILE' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content }] },
        ]
  if (tail)
    messages.push(
      { role: 'assistant', content: 'FICTIONAL_READ_DONE' },
      { role: 'user', content: 'FICTIONAL_CONTINUE' },
    )
  return {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: true,
    messages,
    tools:
      protocol === 'chat'
        ? [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]
        : [{ name: 'read', input_schema: { type: 'object' } }],
  }
}
function toolText(body) {
  const content = body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === 'tool_result' && b.tool_use_id === 'read-1')?.content
  return typeof content === 'string' ? content : content?.map((b) => b.text || '').join('')
}
const dshHeaders = {
  'user-agent': 'deepseek-harness/fictional',
  'x-api-key': 'fictional-key-a',
  'x-client-request-id': 'session-00000000-0000-4000-8000-000000000001',
}
for (const protocol of ['messages', 'chat']) {
  test(
    `native DSH ${protocol}: verified original restored only for matching key, session and history`,
    {
      skip: !enabled,
      timeout: 180000,
    },
    () =>
      fixture(
        `prune-${protocol}`,
        {
          sticky: { outbound_session: 'passthrough' },
          compatibility: { preserve_pruned_tool_results: true },
        },
        async (chain, rows) => {
          const endpoint = protocol === 'chat' ? '/v1/chat/completions' : '/v1/messages'
          const seed = await send(chain, rows, toolBody(protocol, ORIGINAL), dshHeaders, endpoint)
          assert.equal(seed.status, 200, seed.response)
          assert.equal(seed.count, 1)
          assert.equal(toolText(seed.body), ORIGINAL)
          assert.equal(chain.logs.at(-1).final_state, 'verified')
          assert.equal(chain.logs.at(-1).attempt_count, 1)
          const restored = await send(chain, rows, toolBody(protocol, PRUNED, true), dshHeaders, endpoint)
          assert.equal(restored.status, 200, restored.response)
          assert.equal(restored.count, 1)
          assert.equal(chain.logs.at(-1).hop_meta.tool_result_prune.restored, 1)
          for (const body of [chain.logs.at(-1).outbound_body, restored.body]) assert.equal(toolText(body), ORIGINAL)
          for (const headers of [
            { ...dshHeaders, 'x-api-key': 'fictional-key-b' },
            { ...dshHeaders, 'x-client-request-id': 'session-00000000-0000-4000-8000-000000000002' },
          ]) {
            const result = await send(chain, rows, toolBody(protocol, PRUNED, true), headers, endpoint)
            assert.equal(result.status, 200, result.response)
            assert.equal(result.count, 1)
            assert.equal(toolText(result.body), PRUNED)
            assert.equal(chain.logs.at(-1).hop_meta.tool_result_prune.restored, 0)
          }
          const edited = toolBody(protocol, PRUNED, true)
          edited.messages[0].content = 'FICTIONAL_EDITED_HISTORY'
          const result = await send(chain, rows, edited, dshHeaders, endpoint)
          assert.equal(result.status, 200, result.response)
          assert.equal(result.count, 1)
          assert.equal(toolText(result.body), PRUNED)
          assert.equal(chain.logs.at(-1).hop_meta.tool_result_prune.restored, 0)
        },
      ),
  )
}

test(
  'native DSH: feature stays off by default',
  {
    skip: !enabled,
    timeout: 120000,
  },
  () =>
    fixture('prune-default-off', null, async (chain, rows) => {
      for (const [content, tail] of [
        [ORIGINAL, false],
        [PRUNED, true],
      ]) {
        const result = await send(chain, rows, toolBody('messages', content, tail), dshHeaders)
        assert.equal(result.status, 200, result.response)
        assert.equal(result.count, 1)
        assert.equal(toolText(result.body), content)
        assert.equal(chain.logs.at(-1).hop_meta?.tool_result_prune, undefined)
      }
    }),
)
