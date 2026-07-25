/**
 * Guard against model names creeping back into the framework content.
 *
 * Model names were previously pinned in agent frontmatter, a duplicate table in
 * the customizations registry, skill examples, an engine lookup, and the
 * dashboard's client JS. Five lists, drifting apart — the repository's own
 * tracker held a task called "Replace GPT-5.4 with GPT-5.4". Agents declare a
 * tier now, and the assistant picks the model.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { TIERS, TIER_IDS, isTier, tierForAgent } from './tiers.js'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const agentsDir = join(repoRoot, 'src', 'orchestrator', 'agents')

/** Anything that looks like a versioned model name. */
const MODEL_NAME_PATTERN =
  /\b(claude[- ](?:opus|sonnet|haiku|fable|mythos)[- ]?[\d.]+|gpt-[\d.]+|gemini[- ][\d.]+|o[34](?:-mini)?\b)/i

function agentFiles(): string[] {
  return readdirSync(agentsDir).filter((f) => f.endsWith('.agent.md'))
}

function frontmatterOf(file: string): string {
  const content = readFileSync(join(agentsDir, file), 'utf8')
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  expect(match, `${file} has no frontmatter`).toBeTruthy()
  return match![1]
}

describe('tier registry', () => {
  it('defines exactly the three tiers', () => {
    expect(TIER_IDS).toEqual(['premium', 'standard', 'economy'])
  })

  it('gives every tier a label and a purpose', () => {
    for (const id of TIER_IDS) {
      expect(TIERS[id].label.length).toBeGreaterThan(0)
      expect(TIERS[id].purpose.length).toBeGreaterThan(0)
    }
  })

  it('recognises valid tiers and rejects anything else', () => {
    expect(isTier('premium')).toBe(true)
    expect(isTier('economy')).toBe(true)
    expect(isTier('quality')).toBe(false)
    expect(isTier('fast')).toBe(false)
    expect(isTier('claude-opus-4-6')).toBe(false)
  })

  it('defaults unknown agents to standard', () => {
    expect(tierForAgent('some-new-agent')).toBe('standard')
    expect(tierForAgent('developer')).toBe('standard')
  })

  it('puts orchestration and security work in premium', () => {
    expect(tierForAgent('team-lead')).toBe('premium')
    expect(tierForAgent('architect')).toBe('premium')
    expect(tierForAgent('security-expert')).toBe('premium')
  })

  it('is case-insensitive on agent names', () => {
    expect(tierForAgent('Team-Lead')).toBe('premium')
    expect(tierForAgent('REVIEWER')).toBe('economy')
  })
})

describe('agent frontmatter', () => {
  it('declares a tier on every agent', () => {
    for (const file of agentFiles()) {
      expect(frontmatterOf(file), `${file} is missing a tier`).toMatch(/^tier: /m)
    }
  })

  it('uses only tiers from the registry', () => {
    for (const file of agentFiles()) {
      const tier = frontmatterOf(file).match(/^tier: (.+)$/m)?.[1].trim()
      expect(tier, `${file} has no tier value`).toBeDefined()
      expect(isTier(tier!), `${file} declares unknown tier "${tier}"`).toBe(true)
    }
  })

  it('never pins a model', () => {
    for (const file of agentFiles()) {
      expect(frontmatterOf(file), `${file} pins a model`).not.toMatch(/^model: /m)
    }
  })

  it('matches the tier the registry assigns to that agent', () => {
    for (const file of agentFiles()) {
      const agent = file.replace(/\.agent\.md$/, '')
      const declared = frontmatterOf(file).match(/^tier: (.+)$/m)![1].trim()
      expect(declared, `${file} disagrees with tiers.ts`).toBe(tierForAgent(agent))
    }
  })
})

describe('framework content is free of model names', () => {
  /** Files that legitimately name models, with the reason. */
  const ALLOWED = new Set([
    // Lookup tables keyed on what an assistant reports at runtime, not defaults.
    'src/cli/convoy/pricing.ts',
    'src/cli/convoy/compaction.ts',
    // Explains why the pinning was removed.
    'src/cli/tiers.ts',
    'src/cli/tiers.test.ts',
    // Fixture data simulating reported values.
    'src/dashboard/scripts/integration-test.ts',
  ])

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p, out)
      else if (/\.(md|ts|astro)$/.test(entry.name)) out.push(p)
    }
    return out
  }

  it('names no model in agents, skills, prompts, or customizations', () => {
    const offenders: string[] = []
    for (const abs of walk(join(repoRoot, 'src', 'orchestrator'))) {
      const rel = abs.slice(repoRoot.length + 1)
      if (ALLOWED.has(rel)) continue
      const hit = readFileSync(abs, 'utf8').match(MODEL_NAME_PATTERN)
      if (hit) offenders.push(`${rel}: ${hit[0]}`)
    }
    expect(offenders).toEqual([])
  })

  it('names no model in shipped CLI code outside the allowed lookup tables', () => {
    const offenders: string[] = []
    for (const abs of walk(join(repoRoot, 'src', 'cli'))) {
      const rel = abs.slice(repoRoot.length + 1)
      if (ALLOWED.has(rel)) continue
      // Tests feed adapters and pricing sample values that a real assistant
      // would report, so model strings belong in fixtures.
      if (rel.endsWith('.test.ts')) continue
      const hit = readFileSync(abs, 'utf8').match(MODEL_NAME_PATTERN)
      if (hit) offenders.push(`${rel}: ${hit[0]}`)
    }
    expect(offenders).toEqual([])
  })
})
