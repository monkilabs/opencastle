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

/**
 * A tier is one fact about an agent, and it is written down in four places: the
 * agent's own frontmatter, the map in tiers.ts, the registry table that ships to
 * users, and the dashboard's colouring. That is exactly the shape of duplication
 * this module was created to end, so the copies are checked against the source.
 */
const agentNames = new Map<string, string>()

describe('every copy of the tier table agrees with the agents', () => {
  const agentsDir = resolve(import.meta.dirname, '..', 'orchestrator', 'agents')

  /** agent id → declared tier, read from the frontmatter that ships. */
  const declared = new Map<string, string>()
  for (const file of readdirSync(agentsDir).filter((n) => n.endsWith('.agent.md'))) {
    const text = readFileSync(join(agentsDir, file), 'utf8')
    const tier = /^tier:\s*(\w+)/m.exec(text)?.[1]
    const name = /^name:\s*['"](.+?)['"]/m.exec(text)?.[1]
    if (tier && name) declared.set(file.replace('.agent.md', ''), tier)
    if (name) agentNames.set(file.replace('.agent.md', ''), name)
  }

  it('every agent declares a tier the registry knows', () => {
    expect(declared.size).toBeGreaterThan(0)
    for (const [agent, tier] of declared) {
      expect(isTier(tier), `${agent} declares unknown tier "${tier}"`).toBe(true)
    }
  })

  it('tierForAgent returns what the agent file declares', () => {
    for (const [agent, tier] of declared) {
      expect(tierForAgent(agent), `tiers.ts disagrees with ${agent}.agent.md`).toBe(tier)
    }
  })

  it('the registry table that ships names the same tier', () => {
    const registry = readFileSync(
      resolve(import.meta.dirname, '..', 'orchestrator', 'customizations', 'agents', 'agent-registry.md'),
      'utf8',
    )
    // Rows look like: | **Architect** | Premium | ... |
    const rows = new Map<string, string>()
    for (const line of registry.split('\n')) {
      const cells = line.split('|').map((s) => s.trim())
      if (cells.length < 4) continue
      const label = cells[1].replace(/\*\*/g, '')
      if (!label || !isTier(cells[2].toLowerCase())) continue
      rows.set(label, cells[2].toLowerCase())
    }

    // "Team Lead (OpenCastle)" is listed as "Team Lead".
    const base = (label: string): string => label.replace(/\s*\(.*\)$/, '')
    const shipped = new Set([...agentNames.values()].map(base))

    for (const [agent, tier] of declared) {
      const label = base(agentNames.get(agent)!)
      expect(rows.get(label), `agent-registry.md row for ${label}`).toBe(tier)
    }
    // And no row for an agent that no longer ships.
    for (const label of rows.keys()) {
      expect(shipped, `agent-registry.md lists retired ${label}`).toContain(label)
    }
  })

  it('the dashboard colours the same agents as economy', () => {
    const dashboard = readFileSync(
      resolve(import.meta.dirname, '..', 'dashboard', 'src', 'pages', 'index.astro'),
      'utf8',
    )
    const listed = /var ECONOMY_AGENTS = \[(.*?)\]/s.exec(dashboard)?.[1] ?? ''
    const inDashboard = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    const economy = [...declared].filter(([, t]) => t === 'economy').map(([a]) => a).sort()
    expect(inDashboard).toEqual(economy)
  })
})

/**
 * Before this the module was dead weight: a registry nothing in the product read,
 * which is how the dashboard's copy of it kept four agents that had been retired.
 * The compiled agent index is its consumer.
 */
describe('the compiled output carries the tier', () => {
  /**
   * Parameterised over every adapter, because the first version of this test
   * exercised one single-file target and passed while Cursor and Windsurf
   * dropped the tier on the floor — their frontmatter was rebuilt from
   * description/applyTo/alwaysApply and never carried it.
   */
  it('every target names the tier somewhere in its output', async () => {
    const { IDE_ADAPTERS } = await import('./adapters/index.js')
    const { mkdtempSync, rmSync, readdirSync, statSync, readFileSync: read } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    function allText(dir: string): string {
      let out = ''
      for (const entry of readdirSync(dir)) {
        if (entry === '.git' || entry === 'node_modules') continue
        const p = join(dir, entry)
        out += statSync(p).isDirectory() ? allText(p) : read(p, 'utf8')
      }
      return out
    }

    for (const [ide, load] of Object.entries(IDE_ADAPTERS)) {
      const dir = mkdtempSync(join(tmpdir(), `tier-${ide}-`))
      try {
        const adapter = await load()
        await adapter.install(repoRoot, dir, { ides: [ide], techTools: [], teamTools: [] } as never, undefined)
        const text = allText(dir)

        // Two shapes, both specific enough to fail when the tier is dropped:
        // rules targets carry it in each agent's frontmatter, single-file
        // targets render it beside the agent's name in the index. A loose
        // /premium/i would have passed vacuously — the word appears in skill
        // prose, which is how this went unnoticed the first time.
        const inFrontmatter = /^tier: premium$/m.test(text)
        const inIndex = text.includes('*(Premium)*')
        expect(inFrontmatter || inIndex, `${ide} output does not associate any agent with its tier`).toBe(true)

        const economy = /^tier: economy$/m.test(text) || text.includes('*(Economy)*')
        expect(economy, `${ide} output never names the economy tier`).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('the single-file targets explain what the tiers mean', async () => {
    const { IDE_ADAPTERS } = await import('./adapters/index.js')
    const { mkdtempSync, rmSync, readFileSync: read } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'tier-index-'))
    try {
      const adapter = await IDE_ADAPTERS['claude-code']()
      await adapter.install(repoRoot, dir, { ides: ['claude-code'], techTools: [], teamTools: [] }, undefined)
      const text = read(join(dir, 'CLAUDE.md'), 'utf8')

      expect(text).toContain('*(Premium)*')
      expect(text).toContain('*(Economy)*')
      for (const id of TIER_IDS) {
        expect(text, `no legend entry for ${id}`).toContain(TIERS[id].purpose)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
