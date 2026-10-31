import { describe, expect, it } from 'vitest'
import { seedDraftOf, seedSaveBody, seedSaveState } from './seed-settings'

describe('seed edit intent and publication acknowledgment', () => {
  it('does not undo an external opt-out from a stale unlocked theme draft', () => {
    const baseline = seedDraftOf({
      seed_policy: { telemetry_disabled: false },
      settings_json: { theme: 'dark' },
    })
    const body = seedSaveBody({ ...baseline, theme: 'light' }, baseline)
    expect(body).not.toHaveProperty('telemetry_disabled')
    expect(body).not.toHaveProperty('do_not_track')
  })

  it('does not treat saved or published policy as native acknowledgment', () => {
    expect(
      seedSaveState({ saved: true, published: false, applied: false })
    ).toBe('saved')
    expect(
      seedSaveState({ saved: true, published: true, applied: false })
    ).toBe('published')
    expect(seedSaveState({ saved: true, published: true, applied: true })).toBe(
      'applied'
    )
    expect(seedSaveState({ saved: true, service: { supported: false } })).toBe(
      'unsupported'
    )
    expect(seedSaveState({})).toBe('unknown')
  })
})
