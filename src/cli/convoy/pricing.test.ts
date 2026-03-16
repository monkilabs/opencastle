import { describe, it, expect } from 'vitest'
import { calculateCost, hasPricing } from './pricing.js'

describe('calculateCost', () => {
  it('returns correct cost for claude-sonnet-4-6', () => {
    const cost = calculateCost('claude-sonnet-4-6', 1000, 500)
    expect(cost).toBeCloseTo(1000 * 3 / 1_000_000 + 500 * 15 / 1_000_000, 10)
    expect(cost).toBeCloseTo(0.0105, 10)
  })

  it('returns correct cost for gpt-4o', () => {
    const cost = calculateCost('gpt-4o', 10000, 5000)
    expect(cost).toBeCloseTo(10000 * 2.5 / 1_000_000 + 5000 * 10 / 1_000_000, 10)
    expect(cost).toBeCloseTo(0.075, 10)
  })

  it('prefix match: claude-sonnet-4-6-20260301 = 0.0105', () => {
    expect(calculateCost('claude-sonnet-4-6-20260301', 1000, 500)).toBeCloseTo(0.0105, 10)
  })

  it('adapter fallback: claude returns a number', () => {
    expect(calculateCost('claude', 1000, 500)).not.toBeNull()
  })

  it('adapter fallback: copilot returns a number', () => {
    expect(calculateCost('copilot', 1000, 500)).not.toBeNull()
  })

  it('returns null for null model', () => {
    expect(calculateCost(null, 1000, 500)).toBeNull()
  })

  it('returns null for unknown model', () => {
    expect(calculateCost('unknown-model-xyz', 1000, 500)).toBeNull()
  })

  it('returns null when both tokens are 0', () => {
    expect(calculateCost('claude-sonnet-4-6', 0, 0)).toBeNull()
  })

  it('returns null when both tokens are null', () => {
    expect(calculateCost('claude-sonnet-4-6', null, null)).toBeNull()
  })

  it('works with only prompt tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', 1000, null)
    expect(cost).toBeCloseTo(1000 * 3 / 1_000_000, 10)
    expect(cost).toBeCloseTo(0.003, 10)
  })

  it('works with only completion tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', null, 1000)
    expect(cost).toBeCloseTo(1000 * 15 / 1_000_000, 10)
    expect(cost).toBeCloseTo(0.015, 10)
  })
})

describe('hasPricing', () => {
  it('returns true for claude-sonnet-4-6', () => {
    expect(hasPricing('claude-sonnet-4-6')).toBe(true)
  })

  it('returns true for gpt-4o', () => {
    expect(hasPricing('gpt-4o')).toBe(true)
  })

  it('returns true for prefix matches', () => {
    expect(hasPricing('claude-sonnet-4-6-20260301')).toBe(true)
  })

  it('returns false for unknown model', () => {
    expect(hasPricing('unknown-model')).toBe(false)
  })

  it('returns false for null', () => {
    expect(hasPricing(null)).toBe(false)
  })
})
