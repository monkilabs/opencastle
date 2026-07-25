/**
 * The one place capability tiers are defined.
 *
 * Model names used to be pinned in agent frontmatter, a duplicate table in the
 * customizations registry, skill examples, an engine lookup, and the website —
 * five lists that drifted independently. The repository's own tracker recorded
 * the result: a task titled "Replace GPT-5.4 with GPT-5.4", a rename that had
 * already lost track of what it was renaming.
 *
 * Agents now declare a tier, which says what kind of model the work wants
 * without naming one. Concrete model selection belongs to the assistant the user
 * is running: it knows which models the account can reach, what they cost today,
 * and which have been retired. A pinned name can only be wrong later.
 */

export type Tier = 'premium' | 'standard' | 'economy'

export interface TierInfo {
  id: Tier
  label: string
  /** What the tier is for, shown in generated docs. */
  purpose: string
}

export const TIERS: Record<Tier, TierInfo> = {
  premium: {
    id: 'premium',
    label: 'Premium',
    purpose: 'Orchestration, architecture, security review — the hardest reasoning',
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    purpose: 'Feature work, schemas, UI, tests — the bulk of the work',
  },
  economy: {
    id: 'economy',
    label: 'Economy',
    purpose: 'Review passes, docs, copy — high volume, low ambiguity',
  },
}

export const TIER_IDS = Object.keys(TIERS) as Tier[]

export function isTier(value: string): value is Tier {
  return value in TIERS
}

/**
 * Tier per agent. Agents absent from this map are Standard, which is the right
 * default for implementation work.
 */
const AGENT_TIERS: Record<string, Tier> = {
  'team-lead': 'premium',
  architect: 'premium',
  'security-expert': 'premium',
  reviewer: 'economy',
  'documentation-writer': 'economy',
  copywriter: 'economy',
  'seo-specialist': 'economy',
  'session-guard': 'economy',
}

export function tierForAgent(agent: string): Tier {
  return AGENT_TIERS[agent.toLowerCase()] ?? 'standard'
}
