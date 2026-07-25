/**
 * Keep the README and ARCHITECTURE.md honest.
 *
 * These files drifted badly before: the website advertised "51 skills" and a
 * generation-old model lineup, the README documented 19 commands including one
 * that printed "not yet implemented", and counts were asserted in four places
 * that were never checked against the tree. Anything a reader could verify by
 * running the tool should be verified here instead.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
const architecture = readFileSync(join(repoRoot, 'ARCHITECTURE.md'), 'utf8')
const cliSource = readFileSync(join(repoRoot, 'bin', 'cli.mjs'), 'utf8')

const orchestrator = join(repoRoot, 'src', 'orchestrator')

function countDirEntries(dir: string, filter: (_name: string) => boolean): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(filter).length
}

const actual = {
  agents: countDirEntries(join(orchestrator, 'agents'), (n) => n.endsWith('.agent.md')),
  skills: countDirEntries(join(orchestrator, 'skills'), () => true),
  plugins: countDirEntries(join(orchestrator, 'plugins'), (n) => !n.endsWith('.ts')),
  workflows: countDirEntries(join(orchestrator, 'agent-workflows'), (n) => n.endsWith('.md')),
}

/** Commands the dispatcher actually exposes in help. */
function visibleCommands(): string[] {
  const start = cliSource.indexOf('const VISIBLE = {')
  const body = cliSource.slice(start, cliSource.indexOf('}', start))
  return [...body.matchAll(/^\s{2}(?:'([^']+)'|([a-zA-Z_][\w-]*)):/gm)].map((m) => m[1] ?? m[2])
}

/** Commands the dispatcher reports as removed. */
function replacedCommands(): string[] {
  const start = cliSource.indexOf('const REPLACED = {')
  const body = cliSource.slice(start, cliSource.indexOf('\n}', start))
  return [...body.matchAll(/^\s{2}(?:'([^']+)'|([a-zA-Z_][\w-]*)):/gm)].map((m) => m[1] ?? m[2])
}

describe('README counts match the tree', () => {
  it('states the real number of agents', () => {
    expect(readme).toContain(`${actual.agents} role definitions`)
  })

  it('states the real number of skills and plugins', () => {
    expect(readme).toContain(`${actual.skills} domain skills`)
    expect(readme).toContain(`${actual.plugins} tool integrations`)
  })

  it('states the real number of workflow templates', () => {
    expect(readme).toContain(`${actual.workflows} templates`)
  })

  it('does not repeat the stale skill-count claim', () => {
    // The old copy said "51 skills" and "50+ skills"; neither was ever right.
    expect(readme).not.toMatch(/\b51 skills\b/)
    expect(readme).not.toMatch(/\b50\+ skills\b/)
  })
})

describe('docs describe the current CLI', () => {
  it('shows only commands that exist', () => {
    const visible = visibleCommands()
    const shown = [...readme.matchAll(/^opencastle ([a-z-]+)/gm)].map((m) => m[1])
    for (const cmd of shown) {
      expect(visible, `README shows "${cmd}", which the CLI does not expose`).toContain(cmd)
    }
  })

  it('never shows a removed command as usable', () => {
    for (const cmd of replacedCommands()) {
      // A bare "npx opencastle <removed>" or "opencastle <removed>" line.
      const usage = new RegExp(`^\\s*(?:npx )?opencastle ${cmd}\\b`, 'm')
      expect(readme, `README still shows removed command "${cmd}"`).not.toMatch(usage)
      expect(architecture, `ARCHITECTURE still shows removed command "${cmd}"`).not.toMatch(usage)
    }
  })

  it('documents every visible command in ARCHITECTURE', () => {
    for (const cmd of visibleCommands()) {
      expect(architecture, `ARCHITECTURE omits "${cmd}"`).toContain(`\`${cmd}`)
    }
  })
})

describe('docs name no models', () => {
  const pattern = /\b(claude[- ](?:opus|sonnet|haiku)[- ]?[\d.]+|gpt-[\d.]+|gemini[- ][\d.]+)/i

  it('README names no model', () => {
    expect(readme.match(pattern)?.[0]).toBeUndefined()
  })

  it('ARCHITECTURE names no model', () => {
    expect(architecture.match(pattern)?.[0]).toBeUndefined()
  })

  it('both explain tiers instead', () => {
    expect(readme).toMatch(/tier/i)
    expect(architecture).toMatch(/Capability Tiers/)
  })
})

describe('website matches the shipped CLI', () => {
  const websiteDir = join(repoRoot, 'website', 'src')

  function websiteFiles(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) websiteFiles(p, out)
      else if (entry.name.endsWith('.astro')) out.push(p)
    }
    return out
  }

  const pages = websiteFiles(websiteDir).map((p) => ({
    rel: p.slice(repoRoot.length + 1),
    text: readFileSync(p, 'utf8'),
  }))

  it('has pages to check', () => {
    expect(pages.length).toBeGreaterThan(0)
  })

  it('shows no removed command as usable', () => {
    const offenders: string[] = []
    for (const cmd of replacedCommands()) {
      // Match an invocation, not prose that happens to contain the word.
      const usage = new RegExp(`(?:npx )?opencastle ${cmd}(?![a-z-])`)
      for (const page of pages) {
        const hit = page.text.match(usage)
        if (hit) offenders.push(`${page.rel}: ${hit[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('names no model', () => {
    const pattern = /\b(claude[- ](?:opus|sonnet|haiku)[- ]?[\d.]+|gpt-[\d.]+|gemini[- ][\d.]+)/i
    const offenders = pages
      .map((p) => ({ rel: p.rel, hit: p.text.match(pattern)?.[0] }))
      .filter((x) => x.hit)
      .map((x) => `${x.rel}: ${x.hit}`)
    expect(offenders).toEqual([])
  })

  it('does not repeat the stale skill-count claims', () => {
    const offenders = pages
      .filter((p) => /\b51 skills\b|\b50\+ skills\b/.test(p.text))
      .map((p) => p.rel)
    expect(offenders).toEqual([])
  })
})

describe('the pitch leads with the compiler', () => {
  it('says what the tool does before listing what is inside', () => {
    const compiles = readme.search(/compiles one source/i)
    const inside = readme.indexOf('## What gets compiled')
    expect(compiles).toBeGreaterThan(-1)
    expect(compiles).toBeLessThan(inside)
  })

  it('marks the convoy engine experimental wherever it is introduced', () => {
    const heading = readme.indexOf('## Convoy Engine')
    expect(heading).toBeGreaterThan(-1)
    expect(readme.slice(heading, heading + 400)).toMatch(/experimental/i)
  })
})
