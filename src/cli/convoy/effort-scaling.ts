export interface EffortProfile {
  complexity: number
  tier: 'economy' | 'standard' | 'utility' | 'premium'
  max_agents: number
  timeout: string
  max_retries: number
  review: 'none' | 'auto' | 'fast' | 'panel'
  expected_tokens: number
  description: string
}

export const EFFORT_TABLE: EffortProfile[] = [
  {
    complexity: 1,
    tier: 'economy',
    max_agents: 1,
    timeout: '5m',
    max_retries: 1,
    review: 'auto',
    expected_tokens: 5_000,
    description: 'Trivial — single file edit, copy change, config tweak',
  },
  {
    complexity: 2,
    tier: 'economy',
    max_agents: 1,
    timeout: '10m',
    max_retries: 1,
    review: 'auto',
    expected_tokens: 15_000,
    description: 'Simple — small bug fix, add a test, update docs',
  },
  {
    complexity: 3,
    tier: 'standard',
    max_agents: 1,
    timeout: '15m',
    max_retries: 2,
    review: 'fast',
    expected_tokens: 30_000,
    description: 'Moderate — new component, API endpoint, or utility',
  },
  {
    complexity: 5,
    tier: 'standard',
    max_agents: 2,
    timeout: '20m',
    max_retries: 2,
    review: 'fast',
    expected_tokens: 60_000,
    description: 'Significant — multi-file feature, integration work',
  },
  {
    complexity: 8,
    tier: 'standard',
    max_agents: 3,
    timeout: '30m',
    max_retries: 2,
    review: 'fast',
    expected_tokens: 120_000,
    description: 'Complex — cross-cutting feature, schema change + UI + tests',
  },
  {
    complexity: 13,
    tier: 'premium',
    max_agents: 5,
    timeout: '45m',
    max_retries: 3,
    review: 'panel',
    expected_tokens: 250_000,
    description: 'Epic — architecture change, security overhaul, major refactor',
  },
]

/**
 * Returns the EffortProfile for a given complexity score.
 * - Exact match: returns that profile
 * - Between defined values: rounds up to the next profile
 * - Below 1: returns the complexity-1 profile
 * - Above 13: returns the complexity-13 profile
 */
export function getEffortProfile(complexity: number): EffortProfile {
  if (complexity <= EFFORT_TABLE[0].complexity) return EFFORT_TABLE[0]
  const last = EFFORT_TABLE[EFFORT_TABLE.length - 1]
  if (complexity >= last.complexity) return last
  for (const profile of EFFORT_TABLE) {
    if (complexity <= profile.complexity) return profile
  }
  return last
}
