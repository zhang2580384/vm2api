import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { seedPersonaDrafts } from '@/features/settings/persona-drafts'
import {
  migrateLegacyOfficialTemplate,
  parsePersonaTemplateLines,
  selectedPreviewBlocks,
} from './persona-template'

// Load the actual backend catalog to detect drift in the browser's compatibility copy.
const backend = await import(
  pathToFileURL(path.resolve('../src/lib/identity/persona-template.mjs')).href
)
const legacy = backend.DEFAULT_PERSONA_TEMPLATES.official.filter(
  (block: { id: string }) => block.id !== 'caller_system'
)

describe('saved official default compatibility', () => {
  it('matches backend migration and exposes the restored caller block in the editor', () => {
    const before = structuredClone(legacy)
    const expected = backend.migrateLegacyOfficialTemplate('official', legacy)
    expect(migrateLegacyOfficialTemplate('official', legacy)).toEqual(expected)
    const drafts = seedPersonaDrafts({
      persona_templates: { official: legacy },
    })
    expect(parsePersonaTemplateLines(drafts.official).blocks).toEqual(expected)
    expect(legacy).toEqual(before)
    expect(migrateLegacyOfficialTemplate('official', expected)).toEqual(
      expected
    )
  })

  it('keeps an explicit caller-system opt-out after migration', () => {
    const blocks = migrateLegacyOfficialTemplate('official', legacy)
    expect(
      selectedPreviewBlocks(
        blocks,
        { persona_block_presets: { official: { caller_system: false } } },
        'official'
      ).some((block) => block.id === 'caller_system')
    ).toBe(false)
  })

  it('leaves edited templates and other presets unchanged', () => {
    const edited = legacy.map((block: { id: string; text: string }) =>
      block.id === 'harness' ? { ...block, text: 'Edited harness' } : block
    )
    expect(migrateLegacyOfficialTemplate('official', edited)).toEqual(edited)
    expect(backend.migrateLegacyOfficialTemplate('official', edited)).toEqual(
      edited
    )
    expect(migrateLegacyOfficialTemplate('zero', legacy)).toEqual(legacy)
  })
})
