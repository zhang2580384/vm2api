import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  applyModelRequestRules,
  getModelEntry,
  getModelParams,
  loadModelPolicy,
  saveModelPolicy,
  seedDefaultPolicy,
} from '../../src/lib/protocol/model-policy.mjs'
import { ensureUnofficialEffortHigh, loggedReasoningEffort } from '../../src/lib/protocol/thinking.mjs'

test('haiku 5.5 is in the panel seed and keeps forced tool choice', () => {
  const seed = seedDefaultPolicy()
  const row = seed.models['claude-haiku-5-5']
  assert.equal(row.params.max_tokens_default, 100000)
  assert.equal(row.params.max_tokens_cap, 100000)
  assert.equal(row.params.default_effort, 'medium')
  assert.equal(row.capabilities.context_window, 100000)
  assert.equal(row.capabilities.supports_effort, true)
  assert.equal(row.betas.pass_context_1m, false)
  assert.equal(seed.aliases.haiku, 'claude-haiku-4-5-20251001')

  const enabled = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    thinking: { type: 'enabled', budget_tokens: 2048, display: 'omitted' },
    tool_choice: { type: 'tool', name: 'lookup' },
  })
  assert.deepEqual(enabled.thinking, { type: 'adaptive', display: 'omitted' })
  assert.deepEqual(enabled.tool_choice, { type: 'tool', name: 'lookup' })

  const kept = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(kept.thinking, { type: 'disabled' })

  const blocked = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    output_config: { effort: 'max' },
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(blocked.thinking, { type: 'adaptive' })
})

test('loading old Haiku 5.5 seed migrates only the old 1M defaults to 100K', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    const repo = new SettingsRepo()
    repo.set('model_policy', {
      source: 'panel',
      models: {
        'claude-haiku-5-5': {
          display_name: 'Haiku 5.5',
          capabilities: { context_window: 1000000, supports_effort: true },
          params: {
            max_tokens_default: 128000,
            max_tokens_cap: 128000,
            default_effort: 'medium',
          },
        },
      },
    })
    loadModelPolicy({ force: true })
    const stored = repo.get('model_policy')
    const row = stored.models['claude-haiku-5-5']
    assert.equal(row.capabilities.context_window, 100000)
    assert.equal(row.params.max_tokens_default, 100000)
    assert.equal(row.params.max_tokens_cap, 100000)
    assert.equal(row.params.default_effort, 'medium')
  } finally {
    closeDatabase()
  }
})

test('a panel effort edit is what Node reads back', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    const seed = seedDefaultPolicy()
    seed.models['claude-haiku-5-5'].params.default_effort = 'high'
    seed.models['claude-haiku-4-5'].params.default_effort = 'medium'
    saveModelPolicy(seed)
    loadModelPolicy({ force: true })
    assert.equal(getModelParams('claude-haiku-5-5').default_effort, 'high')
    assert.equal(getModelParams('claude-haiku-4-5').default_effort, undefined)
    assert.equal(getModelEntry('claude-haiku-4-5').capabilities.supports_effort, false)
    seed.models['claude-haiku-5-5'].params.default_effort = 'off'
    saveModelPolicy(seed)
    loadModelPolicy({ force: true })
    const body = ensureUnofficialEffortHigh({
      model: 'claude-haiku-5-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'pong' }],
    })
    assert.equal(body.output_config, undefined)
  } finally {
    closeDatabase()
  }
})

test('logged effort uses the caller value, then the panel or catalog default', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    saveModelPolicy(seedDefaultPolicy())
    loadModelPolicy({ force: true })
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5', output_config: { effort: 'max' } }), 'max')
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5' }), 'high')
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5-5' }), 'medium')
    assert.equal(loggedReasoningEffort({ model: 'claude-opus-4-7' }), 'xhigh')
    assert.equal(loggedReasoningEffort({ model: 'claude-haiku-4-5' }), null)
    const seed = seedDefaultPolicy()
    seed.models['claude-sonnet-5'].params.default_effort = 'low'
    saveModelPolicy(seed)
    loadModelPolicy({ force: true })
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5' }), 'low')
    seed.models['claude-sonnet-5'].params.default_effort = 'off'
    saveModelPolicy(seed)
    loadModelPolicy({ force: true })
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5' }), null)
  } finally {
    closeDatabase()
  }
})
