import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startRealChain } from './helpers/real-chain.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { isOfficialClaudeCodeTraffic, isProxiedOfficialClaudeCode } from '../../src/lib/identity/crs-persona.mjs'

const kernelBin = process.env.KIN_303_KERNEL
const cliBin = process.env.KIN_303_CLI
const enabled = Boolean(kernelBin && cliBin)
if (enabled) openDatabase({ dbPath: ':memory:' })
test.after(() => {
  if (enabled) closeDatabase()
})

const selected = 'FICTIONAL_SELECTED_CUSTOM_TEMPLATE'
const caller = 'FICTIONAL_CALLER_SYSTEM_TEXT'
const evidence = []
test.after(() => {
  if (!process.env.KIN_PROTOCOL_EVIDENCE_DIR) return
  fs.mkdirSync(process.env.KIN_PROTOCOL_EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'persona-switch-native.json'),
    JSON.stringify(evidence, null, 2),
  )
})

for (const family of ['direct', 'relayed']) {
  for (const setting of [undefined, false, true]) {
    test(`native ${family} official family: passthrough ${String(setting)} obeys the selected template`, {
      skip: !enabled,
      timeout: 60000,
    }, async () => {
      const chain = await startRealChain({
        kernelBin,
        cliBin,
        preset: 'custom',
        routingBase: {
          compatibility: {
            detect_proxied_official_cc: true,
            ...(setting === undefined ? {} : { official_cc_passthrough: setting }),
            persona_env_presets: { custom: false },
            persona_templates: {
              custom: [
                { type: 'text', text: selected },
                { id: 'caller_system', type: 'text', text: '{{caller_system}}', drop_if_empty: true },
              ],
            },
          },
        },
      })
      try {
        const session = randomUUID()
        const body = {
          model: 'claude-haiku-5-5',
          stream: true,
          max_tokens: 256,
          metadata: { user_id: JSON.stringify({ device_id: 'd'.repeat(64), session_id: session }) },
          system: [
            { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=cli;' },
            { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
            { type: 'text', text: caller },
          ],
          messages: [{ role: 'user', content: 'FICTIONAL_USER_REQUEST' }],
        }
        const headers = family === 'direct' ? { 'user-agent': 'claude-cli/2.1.303 (external, cli)' } : {}
        assert.equal(
          family === 'direct' ? isOfficialClaudeCodeTraffic(headers, body) : isProxiedOfficialClaudeCode(body, headers),
          true,
          'The fixture must reach the intended official-family branch',
        )
        const result = await chain.send({ request: { path: '/v1/messages', headers, body } })
        evidence.push({ family, setting: setting ?? 'absent', result, node_body: chain.logs.at(-1)?.outbound_body })
        assert.equal(result.status, 200, result.response)
        assert.equal(result.count, 1)
        const final = JSON.stringify(result.body)
        const node = JSON.stringify(chain.logs.at(-1)?.outbound_body)
        for (const serialized of [node, final]) {
          assert.equal(serialized.includes(selected), setting !== true)
          assert.equal(serialized.split(caller).length - 1, 1, 'Caller text must survive exactly once')
          assert.equal(serialized.split('FICTIONAL_USER_REQUEST').length - 1, 1)
        }
      } finally {
        await chain.close()
      }
    })
  }
}

for (const family of ['direct', 'relayed']) {
  test(`native ${family}: a literal-only custom template deliberately replaces the caller system`, {
    skip: !enabled,
    timeout: 60000,
  }, async () => {
    const chain = await startRealChain({
      kernelBin,
      cliBin,
      preset: 'custom',
      routingBase: {
        compatibility: {
          detect_proxied_official_cc: true,
          official_cc_passthrough: false,
          persona_templates: { custom: [{ type: 'text', text: selected }] },
        },
      },
    })
    try {
      const result = await chain.send({
        request: {
          path: '/v1/messages',
          headers: family === 'direct' ? { 'user-agent': 'claude-cli/2.1.303 (external, cli)' } : {},
          body: {
            model: 'claude-haiku-5-5',
            stream: true,
            max_tokens: 256,
            metadata: { user_id: JSON.stringify({ device_id: 'd'.repeat(64), session_id: randomUUID() }) },
            system: [
              { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=cli;' },
              { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
              { type: 'text', text: caller },
            ],
            messages: [{ role: 'user', content: 'FICTIONAL_USER_REQUEST' }],
          },
        },
      })
      evidence.push({ family, template: 'literal-only', result, node_body: chain.logs.at(-1)?.outbound_body })
      assert.equal(result.status, 200, result.response)
      assert.equal(result.count, 1)
      for (const serialized of [JSON.stringify(chain.logs.at(-1)?.outbound_body), JSON.stringify(result.body)]) {
        assert.equal(serialized.includes(selected), true)
        assert.equal(serialized.includes(caller), false, 'No caller placeholder was configured')
        assert.equal(serialized.split('FICTIONAL_USER_REQUEST').length - 1, 1)
      }
    } finally {
      await chain.close()
    }
  })
}

for (const preset of ['zero', 'official', 'official_full']) {
  test(`native ${preset}: environment opt-out preserves caller environment and transcript`, {
    skip: !enabled,
    timeout: 90000,
  }, async () => {
    const chain = await startRealChain({
      kernelBin,
      cliBin,
      preset,
      timezone: 'Asia/Tokyo',
      routingBase: { compatibility: { persona_env_presets: { [preset]: false } } },
    })
    try {
      for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
        const callerEnvironment =
          '# Environment\n - Timezone: Pacific/Auckland\n - Caller-only fact: FICTIONAL_ENV_FACT'
        const result = await chain.send({
          request: {
            path: '/v1/messages',
            body: {
              model,
              max_tokens: 256,
              stream: true,
              system: callerEnvironment,
              messages: [
                { role: 'user', content: 'FICTIONAL_FIRST_USER' },
                { role: 'assistant', content: 'FICTIONAL_ASSISTANT_HISTORY' },
                { role: 'user', content: 'FICTIONAL_FINAL_USER' },
              ],
            },
          },
        })
        evidence.push({ preset, model, result, node_body: chain.logs.at(-1)?.outbound_body })
        assert.equal(result.status, 200, result.response)
        const final = JSON.stringify(result.body)
        assert.equal(final.includes('Asia/Tokyo'), false, 'Disabled generated timezone must stay absent')
        assert.equal(final.includes(JSON.stringify(callerEnvironment).slice(1, -1)), true)
        for (const text of [
          'FICTIONAL_ENV_FACT',
          'FICTIONAL_FIRST_USER',
          'FICTIONAL_ASSISTANT_HISTORY',
          'FICTIONAL_FINAL_USER',
        ]) {
          assert.equal(final.split(text).length - 1, 1, `${text} must survive exactly once`)
        }
      }
    } finally {
      await chain.close()
    }
  })
}
