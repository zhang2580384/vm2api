import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  previewSystemBlocks,
} from './persona-template'

describe('zero caller system preview', () => {
  const caller = 'Keep the caller instructions.'

  it('shows caller system for the billing-only zero template', () => {
    const blocks = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.zero,
      { caller_system: caller },
      { preserveCallerSystem: true }
    )
    expect(blocks).toEqual([
      {
        id: 'caller_system',
        text: caller,
        hide: false,
        ttl: '',
        scope: '',
        placeholder: false,
      },
    ])
  })

  it('does not duplicate caller text explicitly placed by a custom template', () => {
    const blocks = previewSystemBlocks(
      [
        ...DEFAULT_PERSONA_TEMPLATES.zero,
        { id: 'instructions', type: 'text', text: 'Rules: {{caller_system}}' },
      ],
      { caller_system: caller },
      { preserveCallerSystem: true }
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(`Rules: ${caller}`)
  })

  it('adds no placeholder when the caller example is hidden or absent', () => {
    for (const caller_system of ['', ' \n ']) {
      expect(
        previewSystemBlocks(
          DEFAULT_PERSONA_TEMPLATES.zero,
          { caller_system },
          { preserveCallerSystem: true }
        )
      ).toEqual([])
    }
  })

  it('does not change preview behavior without the zero option', () => {
    expect(
      previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
        caller_system: caller,
      })
    ).toEqual([])
  })
})
