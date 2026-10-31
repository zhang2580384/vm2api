import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_AGENT_PROMPT_303,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_OFFICIAL_SYSTEM,
  collectCallerSystemAppend,
  isKnownOfficialSystemText,
  stripLeakyClientText,
} from '../../src/lib/identity/crs-persona.mjs'

test('official cleanup removes standalone identities and billing without discarding adjacent business rules', () => {
  const input = [
    'x-anthropic-billing-header: cc_version=old; cc_entrypoint=claude-desktop;',
    CRS_OFFICIAL_CLI_SYSTEM,
    CRS_OFFICIAL_SYSTEM,
    'You are Claude Agent SDK running inside claude-desktop.',
    'Always respond in Chinese. Explain Claude Agent SDK usage.',
    'Preserve cc_entrypoint=sdk-cli examples.',
  ].join('\n')
  const expected =
    'Always respond in Chinese. Explain Claude Agent SDK usage.\nPreserve cc_entrypoint=sdk-cli examples.'
  assert.equal(stripLeakyClientText(input), expected)
  assert.equal(collectCallerSystemAppend({ system: input }), expected)
})

test('only complete known official prompts are replaceable', () => {
  for (const prompt of [CRS_OFFICIAL_AGENT_PROMPT, CRS_OFFICIAL_AGENT_PROMPT_303]) {
    assert.equal(isKnownOfficialSystemText(prompt), true)
    assert.equal(isKnownOfficialSystemText(`${prompt}\n\nBusiness-specific rule.`), false)
    assert.equal(collectCallerSystemAppend({ system: prompt }), '')
    assert.ok(
      collectCallerSystemAppend({ system: `${prompt}\n\nBusiness-specific rule.` }).includes('Business-specific rule.'),
    )
  }
})

test('billing alongside business instructions does not make the entire block replaceable', () => {
  const billing = 'x-anthropic-billing-header: cc_entrypoint=cli;'
  assert.equal(isKnownOfficialSystemText(billing), true)
  assert.equal(isKnownOfficialSystemText(`${billing}\nAlways return JSON.`), false)
  assert.equal(collectCallerSystemAppend({ system: `${billing}\nAlways return JSON.` }), 'Always return JSON.')
  const environment = '# Environment\nUse the business workspace.'
  for (const preserveEnvironment of [false, true]) {
    assert.equal(
      collectCallerSystemAppend({ system: `${billing}\n${environment}` }, { preserveEnvironment }),
      environment,
    )
  }
})

test('official cleanup preserves caller block order and line endings around documentation', () => {
  const first = 'Explain Claude Agent SDK.\r\n  Preserve this indentation.'
  const second = '# Doing tasks\nFollow business rules.\n\n# Tone and style\nReturn JSON.'
  const system = [
    { type: 'text', text: first },
    { type: 'text', text: second },
  ]
  const before = structuredClone(system)
  assert.equal(collectCallerSystemAppend({ system }), `${first}\n\n${second}`)
  assert.deepEqual(system, before)
})
