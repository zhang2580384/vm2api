import { describe, expect, it } from 'vitest'
import {
  calculateOutputRate,
  formatCurrency,
  formatDuration,
  formatTokenAmount,
  isNonBillingEndpoint,
} from './usage-format'

describe('formatTokenAmount', () => {
  it('follows hub token.ts thresholds', () => {
    expect(formatTokenAmount(null)).toBe('-')
    expect(formatTokenAmount(undefined)).toBe('-')
    expect(formatTokenAmount(999)).toBe('999')
    expect(formatTokenAmount(1500)).toBe('1.5K')
    expect(formatTokenAmount(12_345)).toBe('12.35K')
    expect(formatTokenAmount(2_500_000)).toBe('2.5M')
  })
})

describe('formatCurrency', () => {
  it('prefixes $ with fixed digits and treats null as 0', () => {
    expect(formatCurrency(1.5)).toBe('$1.50')
    expect(formatCurrency(0.0123456, 6)).toBe('$0.012346')
    expect(formatCurrency(1234.5)).toBe('$1,234.50')
    expect(formatCurrency(null)).toBe('$0.00')
  })
})

describe('formatDuration', () => {
  it('switches to seconds at 1000ms', () => {
    expect(formatDuration(null)).toBe('-')
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(1234)).toBe('1.23s')
    expect(formatDuration(-5)).toBe('-')
    expect(formatDuration(Number.NaN)).toBe('-')
  })
})

describe('output rate', () => {
  it('divides output tokens by the measured generation window', () => {
    expect(calculateOutputRate(100, 2000)).toBe(50)
    expect(calculateOutputRate(621, 15488)?.toFixed(1)).toBe('40.1')
  })

  it('stays unavailable without a measured positive window', () => {
    expect(calculateOutputRate(621, null)).toBeNull()
    expect(calculateOutputRate(621, 0)).toBeNull()
    expect(calculateOutputRate(621, -8)).toBeNull()
    expect(calculateOutputRate(621, Number.POSITIVE_INFINITY)).toBeNull()
    expect(calculateOutputRate(0, 15488)).toBeNull()
    expect(calculateOutputRate(Number.NaN, 15488)).toBeNull()
  })
})

describe('isNonBillingEndpoint', () => {
  it('matches count_tokens and compact with trailing slash tolerance', () => {
    expect(isNonBillingEndpoint('/v1/messages/count_tokens/')).toBe(true)
    expect(isNonBillingEndpoint('/v1/responses/compact')).toBe(true)
    expect(isNonBillingEndpoint('/v1/messages')).toBe(false)
    expect(isNonBillingEndpoint(null)).toBe(false)
  })
})
