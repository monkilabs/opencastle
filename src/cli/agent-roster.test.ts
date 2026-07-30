/**
 * Keep the agent roster consistent everywhere it is named.
 *
 * Merging 19 agents to 13 touched agent files, output contracts, the skill
 * matrix, the registry table, plugin tool maps, workflows, prompts, the website,
 * and the docs. Nine places, and a rename that misses one leaves a workflow
 * delegating to an agent that no longer exists — which fails at runtime, in a
 * convoy, hours in. Cheaper to assert it here.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_CONTRACTS } from './convoy/contracts.js'
import { isTier, tierForAgent } from './tiers.js'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const orchestrator = join(repoRoot, 'src', 'orchestrator')
const agentsDir = join(orchestrator, 'agents')

/** Agent slugs, from the files that define them. */
const SLUGS = readdirSync(agentsDir)
  .filter((f) => f.endsWith('.agent.md'))
  .map((f) => f.replace(/\.agent\.md$/, ''))
  .sort()

/** Display names, from each agent's frontmatter. */
const NAMES = SLUGS.map((slug) => {
  const text = readFileSync(join(agentsDir, `${slug}.agent.md`), 'utf8')
  const name = text.match(/^name:\s*['"]?(.+?)['"]?\s*$/m)?.[1]
  expect(name, `${slug} has no name in frontmatter`).toBeTruthy()
  return name!
})

/** Agents that were merged away, and where their work went. */
const RETIRED: Record<string, string> = {
  copywriter: 'writer',
  'seo-specialist': 'writer',
  'documentation-writer': 'writer',
  'api-designer': 'developer',
  'release-manager': 'devops-expert',
  'data-expert': 'data-engineer',
  'database-engineer': 'data-engineer',
  'session-guard': 'reviewer',
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p)
  }
  return out
}

describe('roster', () => {
  it('is the 13 agents the merge settled on', () => {
    expect(SLUGS).toEqual([
      'architect',
      'content-engineer',
      'data-engineer',
      'developer',
      'devops-expert',
      'performance-expert',
      'researcher',
      'reviewer',
      'security-expert',
      'team-lead',
      'testing-expert',
      'ui-ux-expert',
      'writer',
    ])
  })

  it('gives every agent a valid tier', () => {
    for (const slug of SLUGS) {
      expect(isTier(tierForAgent(slug)), `${slug} has no valid tier`).toBe(true)
    }
  })

  it('has no file for a retired agent', () => {
    for (const retired of Object.keys(RETIRED)) {
      expect(existsSync(join(agentsDir, `${retired}.agent.md`)), `${retired} still has a file`).toBe(false)
    }
  })
})

describe('no retired agent is still referenced', () => {
  const sources = [
    ...walk(orchestrator, ['.md', '.json', '.ts']),
    ...walk(join(repoRoot, 'website', 'src'), ['.astro']),
    join(repoRoot, 'README.md'),
    join(repoRoot, 'ARCHITECTURE.md'),
  ].filter((p) => existsSync(p) && !p.includes('.test.'))

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(Object.entries(RETIRED))('%s is gone (its work moved to %s)', (retired) => {
    const offenders: string[] = []
    for (const abs of sources) {
      const text = readFileSync(abs, 'utf8')
      if (new RegExp(`\\b${retired}\\b`).test(text)) {
        offenders.push(abs.slice(repoRoot.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('references resolve to real agents', () => {
  it('every output contract belongs to a current agent', () => {
    for (const key of Object.keys(AGENT_CONTRACTS)) {
      expect(SLUGS, `contract "${key}" has no agent`).toContain(key)
    }
  })

  it('every skill-matrix entry names a current agent', () => {
    const matrix = JSON.parse(
      readFileSync(join(orchestrator, 'customizations', 'agents', 'skill-matrix.json'), 'utf8'),
    ) as { agents: Record<string, unknown> }
    for (const label of Object.keys(matrix.agents)) {
      expect(NAMES, `skill matrix names "${label}", which is not an agent`).toContain(label)
    }
  })

  it('every plugin tool map names a current agent', () => {
    const offenders: string[] = []
    for (const abs of walk(join(orchestrator, 'plugins'), ['.ts'])) {
      const text = readFileSync(abs, 'utf8')
      const block = text.match(/agentToolMap:\s*\{([\s\S]*?)\n\s{2}\}/)?.[1]
      if (!block) continue
      for (const m of block.matchAll(/'([a-z][a-z-]*)':\s*\[/g)) {
        if (!SLUGS.includes(m[1])) offenders.push(`${abs.slice(repoRoot.length + 1)}: ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every workflow and prompt delegates to a current agent', () => {
    const offenders: string[] = []
    for (const abs of [
      ...walk(join(orchestrator, 'agent-workflows'), ['.md']),
      ...walk(join(orchestrator, 'prompts'), ['.md']),
    ]) {
      const text = readFileSync(abs, 'utf8')
      for (const m of text.matchAll(/^\s*agent:\s*'?([a-z][a-z-]*)'?/gm)) {
        if (!SLUGS.includes(m[1])) offenders.push(`${abs.slice(repoRoot.length + 1)}: ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * The dashboard's seed data ships in the package and is served verbatim by
 * `convoy dashboard --seed`. It named eight agents that had been retired for a
 * release and pinned concrete model ids that the rest of the project forbids
 * everywhere else — invisible to every guard, because nothing scanned it.
 */
describe('the dashboard seed data matches the shipped roster', () => {
  const seedDir = resolve(import.meta.dirname, '..', 'dashboard', 'seed-data')

  function seedRecords(): Array<Record<string, unknown>> {
    if (!existsSync(seedDir)) return []
    return readdirSync(seedDir)
      .filter((n) => n.endsWith('.ndjson'))
      .flatMap((n) =>
        readFileSync(join(seedDir, n), 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      )
  }

  const AGENT_FIELDS = ['agent', 'from_agent', 'to_agent', 'reviewer']

  it('has records to check', () => {
    expect(seedRecords().length).toBeGreaterThan(0)
  })

  it('names only agents that ship', () => {
    const shipped = new Set(
      readdirSync(agentsDir)
        .filter((n) => n.endsWith('.agent.md'))
        .map((n) => /^name:\s*['"](.+?)['"]/m.exec(readFileSync(join(agentsDir, n), 'utf8'))?.[1])
        .filter((n): n is string => Boolean(n)),
    )
    const offenders = new Set<string>()
    for (const rec of seedRecords()) {
      for (const f of AGENT_FIELDS) {
        const v = rec[f]
        if (typeof v === 'string' && !shipped.has(v)) offenders.add(`${f}=${v}`)
      }
    }
    expect([...offenders]).toEqual([])
  })

  it('pins no model name', () => {
    const pattern = /\b(claude[- ](?:opus|sonnet|haiku)[- ]?[\d.]+|gpt-[\d.]+|gemini[- ][\d.]+)/i
    const offenders = new Set<string>()
    for (const rec of seedRecords()) {
      const model = rec.model
      if (typeof model === 'string' && pattern.test(model)) offenders.add(model)
    }
    expect([...offenders]).toEqual([])
  })
})
