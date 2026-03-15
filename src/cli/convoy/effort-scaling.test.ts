import { describe, it, expect } from 'vitest'
import { getEffortProfile, EFFORT_TABLE } from './effort-scaling.js'

describe('getEffortProfile', () => {
  it('returns complexity-1 profile for score 1', () => {
    const p = getEffortProfile(1)
    expect(p.complexity).toBe(1)
    expect(p.tier).toBe('economy')
    expect(p.timeout).toBe('5m')
    expect(p.max_retries).toBe(1)
    expect(p.review).toBe('auto')
    expect(p.expected_tokens).toBe(5000)
  })

  it('returns complexity-2 profile for score 2', () => {
    const p = getEffortProfile(2)
    expect(p.complexity).toBe(2)
    expect(p.tier).toBe('economy')
    expect(p.timeout).toBe('10m')
    expect(p.max_retries).toBe(1)
    expect(p.review).toBe('auto')
    expect(p.expected_tokens).toBe(15000)
  })

  it('returns complexity-3 profile for score 3', () => {
    const p = getEffortProfile(3)
    expect(p.complexity).toBe(3)
    expect(p.tier).toBe('standard')
    expect(p.timeout).toBe('15m')
    expect(p.max_retries).toBe(2)
    expect(p.review).toBe('fast')
    expect(p.expected_tokens).toBe(30000)
  })

  it('returns complexity-5 profile for score 5', () => {
    const p = getEffortProfile(5)
    expect(p.complexity).toBe(5)
    expect(p.tier).toBe('standard')
    expect(p.timeout).toBe('20m')
    expect(p.max_retries).toBe(2)
    expect(p.review).toBe('fast')
    expect(p.expected_tokens).toBe(60000)
  })

  it('returns complexity-8 profile for score 8', () => {
    const p = getEffortProfile(8)
    expect(p.complexity).toBe(8)
    expect(p.tier).toBe('standard')
    expect(p.timeout).toBe('30m')
    expect(p.max_retries).toBe(2)
    expect(p.review).toBe('fast')
    expect(p.expected_tokens).toBe(120000)
  })

  it('returns complexity-13 profile for score 13', () => {
    const p = getEffortProfile(13)
    expect(p.complexity).toBe(13)
    expect(p.tier).toBe('premium')
    expect(p.timeout).toBe('45m')
    expect(p.max_retries).toBe(3)
    expect(p.review).toBe('panel')
    expect(p.expected_tokens).toBe(250000)
  })

  it('rounds up score 4 to complexity-5 profile', () => {
    const p = getEffortProfile(4)
    expect(p.complexity).toBe(5)
  })

  it('rounds up score 6 to complexity-8 profile', () => {
    const p = getEffortProfile(6)
    expect(p.complexity).toBe(8)
  })

  it('rounds up score 7 to complexity-8 profile', () => {
    const p = getEffortProfile(7)
    expect(p.complexity).toBe(8)
  })

  it('rounds up score 9 to complexity-13 profile', () => {
    const p = getEffortProfile(9)
    expect(p.complexity).toBe(13)
  })

  it('rounds up score 10 to complexity-13 profile', () => {
    const p = getEffortProfile(10)
    expect(p.complexity).toBe(13)
  })

  it('rounds up score 12 to complexity-13 profile', () => {
    const p = getEffortProfile(12)
    expect(p.complexity).toBe(13)
  })

  it('clamps score 0 to complexity-1 profile', () => {
    const p = getEffortProfile(0)
    expect(p.complexity).toBe(1)
  })

  it('clamps negative score -5 to complexity-1 profile', () => {
    const p = getEffortProfile(-5)
    expect(p.complexity).toBe(1)
  })

  it('clamps large negative score -9999 to complexity-1 profile', () => {
    const p = getEffortProfile(-9999)
    expect(p.complexity).toBe(1)
  })

  it('clamps score 14 to complexity-13 profile', () => {
    const p = getEffortProfile(14)
    expect(p.complexity).toBe(13)
  })

  it('clamps score 100 to complexity-13 profile', () => {
    const p = getEffortProfile(100)
    expect(p.complexity).toBe(13)
  })

  it('clamps very large score 9999 to complexity-13 profile', () => {
    const p = getEffortProfile(9999)
    expect(p.complexity).toBe(13)
  })

  it('returns the same object reference from EFFORT_TABLE for exact matches', () => {
    for (const entry of EFFORT_TABLE) {
      expect(getEffortProfile(entry.complexity)).toBe(entry)
    }
  })

  it('EFFORT_TABLE has 6 entries', () => {
    expect(EFFORT_TABLE).toHaveLength(6)
  })

  it('EFFORT_TABLE entries are ordered by ascending complexity', () => {
    for (let i = 1; i < EFFORT_TABLE.length; i++) {
      expect(EFFORT_TABLE[i].complexity).toBeGreaterThan(EFFORT_TABLE[i - 1].complexity)
    }
  })
})
