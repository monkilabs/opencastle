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
  // README.md documents the directory for contributors; it is not a template,
  // and no adapter installs it.
  workflows: countDirEntries(
    join(orchestrator, 'agent-workflows'),
    (n) => n.endsWith('.md') && n !== 'README.md',
  ),
}

/** Commands the dispatcher actually exposes in help. */
function visibleCommands(): string[] {
  const start = cliSource.indexOf('const VISIBLE = {')
  const body = cliSource.slice(start, cliSource.indexOf('}', start))
  return [...body.matchAll(/^\s{2}(?:'([^']+)'|([a-zA-Z_][\w-]*)):/gm)].map((m) => m[1] ?? m[2])
}

/** Commands the dispatcher exposes but does not advertise. */
function hiddenCommands(): string[] {
  const start = cliSource.indexOf('const HIDDEN = {')
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

/**
 * The content in src/orchestrator/ is not documentation about the tool — it is
 * the tool's output, compiled into every user's project and read by their agent.
 * A removed command named here becomes an agent confidently running `opencastle
 * run --status` and getting exit 1. Nothing scanned these files, so the suite
 * passed while five of them instructed commands that no longer existed.
 */
describe('shipped content instructs only commands that exist', () => {
  const orchestratorRoot = join(repoRoot, 'src', 'orchestrator')

  function contentFiles(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) contentFiles(p, out)
      else if (entry.name.endsWith('.md')) out.push(p)
    }
    return out
  }

  const files = contentFiles(orchestratorRoot).map((p) => ({
    rel: p.slice(repoRoot.length + 1),
    text: readFileSync(p, 'utf8'),
  }))

  it('has content to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('names no removed command', () => {
    const offenders: string[] = []
    for (const cmd of replacedCommands()) {
      const usage = new RegExp(`(?:npx )?opencastle ${cmd}(?![a-z-])`, 'g')
      for (const file of files) {
        for (const hit of file.text.matchAll(usage)) offenders.push(`${file.rel}: ${hit[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('names no command that does not exist at all', () => {
    // Checking only the removed list catches names that used to work and misses
    // names that never did. `opencastle context-map` shipped to every user's
    // project this way, and exits 1. A positive list is the only shape that
    // catches an invention.
    const real = new Set([...visibleCommands(), ...hiddenCommands()])
    // Subcommands of `convoy`, which the dispatcher never sees directly.
    const subcommands = new Set(['resume', 'retry', 'dashboard', 'run', 'plan'])
    const offenders: string[] = []
    for (const file of files) {
      for (const hit of file.text.matchAll(/opencastle ([a-z][a-z-]{2,})/g)) {
        const word = hit[1]
        if (real.has(word) || subcommands.has(word) || replacedCommands().includes(word)) continue
        offenders.push(`${file.rel}: opencastle ${word}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('names no model', () => {
    const pattern = /\b(claude[- ](?:opus|sonnet|haiku)[- ]?[\d.]+|gpt-[\d.]+|gemini[- ][\d.]+)/i
    const offenders = files
      .map((f) => ({ rel: f.rel, hit: f.text.match(pattern)?.[0] }))
      .filter((x) => x.hit)
      .map((x) => `${x.rel}: ${x.hit}`)
    expect(offenders).toEqual([])
  })
})

/**
 * The CLI's own output is the closest thing to documentation most people read.
 * It shipped hints naming `opencastle start` and `opencastle plan`, both removed,
 * one of them the banner printed at the top of every planner run.
 */
describe('the CLI never tells you to run a removed command', () => {
  const cliDirPath = join(repoRoot, 'src', 'cli')

  const sources = readdirSync(cliDirPath)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
    .map((n) => ({ rel: `src/cli/${n}`, text: readFileSync(join(cliDirPath, n), 'utf8') }))

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('prints no removed command', () => {
    const offenders: string[] = []
    for (const cmd of replacedCommands()) {
      // `opencastle convoy run` is fine; a bare `opencastle run` is not. The
      // lookbehind spares prose like "the opencastle package root".
      const usage = new RegExp(`(?<!the )opencastle ${cmd}(?![a-z-])`, 'g')
      for (const src of sources) {
        for (const hit of src.text.matchAll(usage)) offenders.push(`${src.rel}: ${hit[0]}`)
      }
    }
    expect(offenders).toEqual([])
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

  it('lists no removed command in an embedded help block', () => {
    // The CLI reference page embedded a verbatim copy of the old help output.
    // Those are bare command names in a listing, not `opencastle <cmd>` calls,
    // so the invocation check above walked straight past them.
    const offenders: string[] = []
    for (const cmd of replacedCommands()) {
      const listing = new RegExp(`^\\s{2,}${cmd}\\s{2,}\\S`, 'm')
      for (const page of pages) {
        if (listing.test(page.text)) offenders.push(`${page.rel}: ${cmd}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('names no removed command in prose, not just in invocations', () => {
    // The CLI reference page described "every opencastle command — init, update,
    // eject, destroy, run, plan, dashboard, and doctor", five of which exit 1.
    // The invocation check walks past a comma-separated list of bare names.
    const offenders: string[] = []
    for (const page of pages) {
      for (const m of page.text.matchAll(/every opencastle command[^.]*\./g)) {
        for (const cmd of replacedCommands()) {
          if (new RegExp(`\\b${cmd}\\b`).test(m[0])) offenders.push(`${page.rel}: ${cmd}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('states plugin and command counts that match the tree', () => {
    const commands = visibleCommands().length
    const badges = pages.flatMap((p) => [...p.text.matchAll(/badge: '(\d+) (commands|plugins)'/g)].map((m) => ({ rel: p.rel, n: Number(m[1]), kind: m[2] })))
    for (const b of badges) {
      const expected = b.kind === 'commands' ? commands : actual.plugins
      expect(b.n, `${b.rel} claims ${b.n} ${b.kind}, tree has ${expected}`).toBe(expected)
    }
    const prose = pages.flatMap((p) => [...p.text.matchAll(/ships with (\d+)\+? plugins/g)].map((m) => ({ rel: p.rel, n: Number(m[1]) })))
    // The word-count claim drifted by 30,000 words when the content pass landed,
    // because the guard only knew about commands and plugins.
    const actualWords = readdirSync(orchestrator, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .reduce((n, e) => n + readFileSync(join(e.parentPath ?? orchestrator, e.name), 'utf8').split(/\s+/).filter(Boolean).length, 0)
    for (const page of pages) {
      for (const m of page.text.matchAll(/(\d+)K\+? words/g)) {
        const claimed = Number(m[1]) * 1000
        expect(
          Math.abs(claimed - actualWords) / actualWords,
          `${page.rel} claims ${m[0]}, tree has ~${Math.round(actualWords / 1000)}K`,
        ).toBeLessThan(0.1)
      }
    }
    for (const c of prose) {
      expect(c.n, `${c.rel} claims ${c.n} plugins, tree has ${actual.plugins}`).toBe(actual.plugins)
    }
  })

  it('names no retired agent', () => {
    const retired = [
      'Copywriter', 'SEO Specialist', 'Documentation Writer', 'API Designer',
      'Release Manager', 'Data Expert', 'Database Engineer', 'Session Guard',
    ]
    const offenders: string[] = []
    for (const name of retired) {
      for (const page of pages) {
        if (page.text.includes(name)) offenders.push(`${page.rel}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('states the licence the LICENSE file actually grants', () => {
    // The footer said BSL 1.1 and the hero said "Free for Non-Commercial Use",
    // while LICENSE, package.json, and npm all say MIT — the site was telling
    // people they could not use commercially when the licence permits it.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { license: string }
    expect(pkg.license).toBe('MIT')
    const offenders = pages
      .filter((p) => /BSL|Non-Commercial/i.test(p.text))
      .map((p) => p.rel)
    expect(offenders).toEqual([])
  })

  it('marks the convoy engine experimental where it is presented', () => {
    const landing = pages.find((p) => p.rel.endsWith('pages/index.astro'))
    expect(landing).toBeDefined()
    const idx = landing!.text.indexOf('Convoy Engine')
    expect(idx).toBeGreaterThan(-1)
    expect(landing!.text.slice(idx, idx + 200)).toMatch(/Experimental/i)
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

describe('quickstart stays runnable', () => {
  const quickstartPath = join(repoRoot, 'docs', 'quickstart.md')
  const quickstart = existsSync(quickstartPath) ? readFileSync(quickstartPath, 'utf8') : ''

  it('exists and is linked from the README', () => {
    expect(quickstart.length).toBeGreaterThan(0)
    expect(readme).toContain('docs/quickstart.md')
  })

  it('shows only commands the CLI exposes', () => {
    const visible = visibleCommands()
    const shown = [...quickstart.matchAll(/^(?:npx )?opencastle ([a-z-]+)/gm)].map((m) => m[1])
    for (const cmd of shown) {
      expect(visible, `quickstart shows "${cmd}", which the CLI does not expose`).toContain(cmd)
    }
  })

  it('shows no removed command', () => {
    for (const cmd of replacedCommands()) {
      expect(quickstart).not.toMatch(new RegExp(`^\\s*(?:npx )?opencastle ${cmd}\\b`, 'm'))
    }
  })

  it('quotes the managed-block marker exactly as the code writes it', async () => {
    const { BLOCK_START } = await import('./managed-block.js')
    // The doc shows the marker so readers recognise it in their own files.
    const shown = quickstart.match(/<!-- >>> OpenCastle managed[^>]*>>> -->/)
    expect(shown, 'quickstart does not show the marker').toBeTruthy()
    expect(BLOCK_START).toContain('OpenCastle managed')
    expect(shown![0]).toBe(BLOCK_START)
  })
})
