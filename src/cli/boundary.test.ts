/**
 * Keep the compiler independent of the experimental convoy engine.
 *
 * The plan for the engine is extract-and-freeze: it stays available, but nothing
 * in the product may come to depend on it, so it can be moved to its own package
 * — or dropped — without touching the part people actually use. That property is
 * easy to state and easy to lose to one convenient import, so it is asserted here.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const cliDir = resolve(import.meta.dirname)

/** Files that make up the compiler — the surface `opencastle` exposes. */
const PRODUCT_MODULES = [
  'init.ts',
  'sync.ts',
  'sync-check.ts',
  'status.ts',
  'add.ts',
  'remove.ts',
  'doctor.ts',
  'update.ts',
  'copy.ts',
  'detect.ts',
  'mcp.ts',
  'stack-config.ts',
  'manifest.ts',
  'gitignore.ts',
  'bootstrap.ts',
  'prompt.ts',
  'tiers.ts',
  'managed-block.ts',
  'types.ts',
]

/** Engine entry points nothing in the product should reach for. */
const ENGINE_PATHS = [/from '\.\/convoy\//, /from '\.\.\/convoy\//, /from '\.\/run\//, /from '\.\.\/run\//]

function importsEngine(source: string): string | null {
  for (const pattern of ENGINE_PATHS) {
    const hit = source.match(pattern)
    if (hit) return hit[0]
  }
  return null
}

describe('the compiler does not depend on the convoy engine', () => {
  it.each(PRODUCT_MODULES)('%s imports no engine module', (file) => {
    const path = join(cliDir, file)
    if (!existsSync(path)) return // module removed; nothing to assert
    const hit = importsEngine(readFileSync(path, 'utf8'))
    expect(hit, `${file} imports the engine via "${hit}"`).toBeNull()
  })

  it('adapters import no engine module', () => {
    const adaptersDir = join(cliDir, 'adapters')
    const offenders: string[] = []
    for (const file of readdirSync(adaptersDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const hit = importsEngine(readFileSync(join(adaptersDir, file), 'utf8'))
      if (hit) offenders.push(`${file}: ${hit}`)
    }
    expect(offenders).toEqual([])
  })

  it('only convoy commands reach the engine', () => {
    // These are the engine's own CLI surface, so they may import it.
    const allowed = new Set(['convoy-cmd.ts', 'run.ts', 'plan.ts', 'pipeline.ts', 'watch.ts', 'dashboard.ts'])
    const unexpected: string[] = []
    for (const file of readdirSync(cliDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      if (allowed.has(file)) continue
      const hit = importsEngine(readFileSync(join(cliDir, file), 'utf8'))
      if (hit) unexpected.push(`${file}: ${hit}`)
    }
    expect(unexpected).toEqual([])
  })
})

describe('the engine is presented as experimental', () => {
  it('is labelled in the CLI help', () => {
    const cli = readFileSync(resolve(cliDir, '..', '..', 'bin', 'cli.mjs'), 'utf8')
    const help = cli.slice(cli.indexOf('const HELP = `'), cli.indexOf('`\n\n/**'))
    expect(help).toMatch(/Experimental/)
    expect(help).toMatch(/convoy/)
  })

  it('is labelled in its own command help', () => {
    const source = readFileSync(join(cliDir, 'convoy-cmd.ts'), 'utf8')
    expect(source).toMatch(/experimental/i)
  })

  it('is labelled in the README', () => {
    const readme = readFileSync(resolve(cliDir, '..', '..', 'README.md'), 'utf8')
    const heading = readme.indexOf('## Convoy Engine')
    expect(heading).toBeGreaterThan(-1)
    expect(readme.slice(heading, heading + 400)).toMatch(/experimental/i)
  })
})

describe('the release does not depend on the engine schema', () => {
  it('builds without generating demo data', () => {
    const pkg = JSON.parse(readFileSync(resolve(cliDir, '..', '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    // The demo generator writes through the convoy store, so a schema change
    // there must not be able to break publishing.
    expect(pkg.scripts.build).not.toMatch(/generate-demo-db/)
    expect(pkg.scripts.prepublishOnly).toBe('npm run build')
  })

  it('keeps the demo generator out of the publish workflow', () => {
    const workflow = readFileSync(
      resolve(cliDir, '..', '..', '.github', 'workflows', 'publish.yml'),
      'utf8',
    )
    expect(workflow).not.toMatch(/npm run dashboard:generate-demo-db/)
  })
})

/**
 * The invariant behind the co-owned root file.
 *
 * `framework` means "wholly generated, safe to delete and regenerate", and three
 * code paths act on exactly that promise. When the root instruction file became a
 * merge target it stayed in `framework`, so `init` re-run and `remove --all`
 * deleted files that held the user's own writing, and `.gitignore` kept that
 * writing out of git so there was no copy to restore. Every root file belongs in
 * `merged`, and nothing may quietly move one back.
 */
describe('root instruction files are co-owned, never framework', () => {
  const ROOT_FILES = [
    'CLAUDE.md',
    'AGENTS.md',
    'GEMINI.md',
    '.cursorrules',
    '.windsurfrules',
    '.github/copilot-instructions.md',
  ]

  it('every adapter declares its root file as merged', async () => {
    const { IDE_ADAPTERS } = await import('./adapters/index.js')
    for (const [ide, load] of Object.entries(IDE_ADAPTERS)) {
      const managed = (await load()).getManagedPaths()
      const roots = [...(managed.merged ?? [])]
      expect(roots.length, `${ide} declares no merged root file`).toBeGreaterThan(0)
      for (const root of roots) {
        expect(ROOT_FILES, `${ide} merges an unexpected path: ${root}`).toContain(root)
      }
      for (const p of managed.framework) {
        expect(ROOT_FILES, `${ide} still lists ${p} as framework`).not.toContain(p)
      }
    }
  })

  it('the gitignore block never hides generated config from git', async () => {
    const source = readFileSync(join(cliDir, 'gitignore.ts'), 'utf8')
    for (const root of ROOT_FILES) {
      expect(source, `gitignore.ts mentions ${root}`).not.toContain(root)
    }
    // Nor the generated directories.
    for (const dir of ['.claude/', '.cursor/rules', '.github/agents', '.opencode/', '.codex/']) {
      expect(source, `gitignore.ts mentions ${dir}`).not.toContain(dir)
    }
  })
})
