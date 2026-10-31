import { describe, expect, it } from 'vitest'
import {
  claudeSettingKeys,
  editableSeedEnv,
  partitionSeedEnvKeys,
  seedDraftOf,
  seedSaveBody,
  settingsRows,
} from './seed-settings'

const snapshot = {
  seed_policy: {
    telemetry_disabled: true,
    reject_client_metadata_identity: false,
  },
  settings_json: {
    env: { TZ: 'Asia/Tokyo', LANG: 'ja_JP.UTF-8', CUSTOM: 'before' },
    theme: 'light',
  },
  claude_setting: 'A=1',
}

describe('actual seed file observations', () => {
  it('does not present missing file values or invented env defaults as observations', () => {
    expect(settingsRows(null, 'FROM_POLICY=1')).toEqual([])
    const rows = settingsRows(snapshot.settings_json, snapshot.claude_setting)
    expect(rows.find((row) => row.key === 'CUSTOM')?.value).toBe('before')
    expect(
      rows.some((row) => row.key === 'CLAUDE_CODE_ATTRIBUTION_HEADER')
    ).toBe(false)
  })

  it('keeps missing observed claude.setting distinct from saved policy', () => {
    expect(
      seedDraftOf({ seed_policy: { claude_setting: 'POLICY=1' } })
        .claude_setting
    ).toBe('')
    expect(claudeSettingKeys('# comment\nA=1\nNOT A KEY')).toEqual(
      new Set(['A'])
    )
  })

  it('preserves an explicit false identity rejection flag', () => {
    expect(seedDraftOf(snapshot).reject_client_metadata_identity).toBe(false)
  })
})

describe('explicit seed edits', () => {
  it('omits unchanged telemetry policy when editing another setting', () => {
    const baseline = seedDraftOf({
      ...snapshot,
      seed_policy: { telemetry_disabled: false },
    })
    const draft = { ...baseline, theme: 'dark' }
    expect(seedSaveBody(draft, baseline)).toEqual({ theme: 'dark' })
  })

  it('sends only an intentional telemetry flip with consistent privacy mirrors', () => {
    const baseline = seedDraftOf(snapshot)
    expect(
      seedSaveBody({ ...baseline, telemetry_disabled: false }, baseline)
    ).toEqual({
      telemetry_disabled: false,
      disable_nonessential_traffic: true,
      do_not_track: false,
    })
  })

  it('keeps contract env keys out of a user env update', () => {
    const baseline = seedDraftOf(snapshot)
    const draft = {
      ...baseline,
      env: { ...baseline.env, CUSTOM: 'after', TZ: 'UTC', DO_NOT_TRACK: '0' },
    }
    expect(seedSaveBody(draft, baseline)).toEqual({
      extra_env: { CUSTOM: 'after' },
    })
    expect(editableSeedEnv(draft.env)).toEqual({ CUSTOM: 'after' })
    expect(partitionSeedEnvKeys(draft.env).readonly).toEqual([
      'DO_NOT_TRACK',
      'LANG',
      'TZ',
    ])
  })

  it('saves an explicit timezone change without resending untouched locale or policy', () => {
    const baseline = seedDraftOf(snapshot, {
      timezone_source: 'manual',
      timezone: 'Asia/Tokyo',
      locale: 'ja_JP.UTF-8',
    })
    expect(
      seedSaveBody({ ...baseline, timezoneFixed: 'Europe/Berlin' }, baseline)
    ).toEqual({ timezone: 'Europe/Berlin' })
    expect(
      seedSaveBody({ ...baseline, timezoneFollow: true }, baseline)
    ).toEqual({ timezone_follow_proxy: true })
  })

  it('keeps a no-edit publication free from stale form values', () => {
    const baseline = seedDraftOf(snapshot)
    expect(seedSaveBody(baseline, baseline)).toEqual({})
  })
})
