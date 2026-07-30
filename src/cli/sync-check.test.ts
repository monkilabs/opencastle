/**
 * Tests for `opencastle sync --check`.
 *
 * The check exists so CI can fail when generated assistant config stops matching
 * its sources — someone edits `.cursor/rules/foo.mdc` directly, or upgrades the
 * package without recompiling. A stale rule file still loads fine, so nothing
 * else would notice.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildCheckReport } from './sync-check.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { writeManifest } from './manifest.js'
import type { StackConfig } from './types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: [] }

describe('drift detection', () => {
  let projectRoot: string

  /** A project compiled from current sources — the no-drift baseline. */
  async function install(): Promise<void> {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(pkgRoot, projectRoot, stack, undefined)
    await writeManifest(projectRoot, {
      version: '9.9.9',
      ide: 'vscode',
      ides: ['vscode'],
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stack,
    })
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'check-proj-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('reports not installed when there is no manifest', async () => {
    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.installed).toBe(false)
    expect(report.drift).toEqual([])
  })

  it('finds no drift right after a compile', async () => {
    await install()
    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.installed).toBe(true)
    expect(report.drift).toEqual([])
    expect(report.checked).toBeGreaterThan(0)
  })

  it('catches a generated file edited in place', async () => {
    await install()
    const target = join(projectRoot, '.github', 'agents', 'developer.agent.md')
    appendFileSync(target, '\nlocal edit that will be lost\n')

    const report = await buildCheckReport(pkgRoot, projectRoot)
    const hit = report.drift.find((d) => d.path.endsWith('developer.agent.md'))
    expect(hit, 'edited file not reported').toBeDefined()
    expect(hit!.kind).toBe('changed')
  })

  it('catches a generated file that was deleted', async () => {
    await install()
    rmSync(join(projectRoot, '.github', 'agents', 'reviewer.agent.md'))

    const report = await buildCheckReport(pkgRoot, projectRoot)
    const hit = report.drift.find((d) => d.path.endsWith('reviewer.agent.md'))
    expect(hit, 'deleted file not reported').toBeDefined()
    expect(hit!.kind).toBe('missing')
  })

  it('catches a file added by hand under a generated directory', async () => {
    await install()
    // `update` deletes each framework directory before recompiling, so this file
    // is gone after the next sync. Silence here would be the check lying.
    writeFileSync(join(projectRoot, '.github', 'agents', 'my-own.agent.md'), 'mine\n')

    const report = await buildCheckReport(pkgRoot, projectRoot)
    const hit = report.drift.find((d) => d.path.endsWith('my-own.agent.md'))
    expect(hit, 'hand-added file not reported').toBeDefined()
    expect(hit!.kind).toBe('extra')
  })

  it('checks the co-owned root file, comparing only the managed block', async () => {
    await install()
    const root = join(projectRoot, '.github', 'copilot-instructions.md')

    // The user's own prose around the block is theirs — not drift.
    writeFileSync(root, '# House rules\n\nUse pnpm.\n\n' + readFileSync(root, 'utf8'))
    let report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.drift.filter((d) => d.path.endsWith('copilot-instructions.md'))).toEqual([])

    // An edit inside the block is drift, and it is the one file most likely to
    // be hand-edited — leaving merged paths out of the walk made it unwatched.
    const text = readFileSync(root, 'utf8')
    writeFileSync(root, text.replace('# Copilot Instructions', '# Edited In Place'))
    report = await buildCheckReport(pkgRoot, projectRoot)
    const hit = report.drift.find((d) => d.path.endsWith('copilot-instructions.md'))
    expect(hit, 'edit inside the managed block not reported').toBeDefined()
    expect(hit!.kind).toBe('changed')
  })

  it('ignores files the user owns', async () => {
    await install()
    // .opencastle/ is customizable by design — editing it is the supported way to
    // change behavior, so it must never count as drift.
    const custom = join(projectRoot, '.opencastle')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'project.instructions.md'), 'my own rules\n')

    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.drift.filter((d) => d.path.startsWith('.opencastle'))).toEqual([])
  })

  it('ignores unrelated files in the project', async () => {
    await install()
    writeFileSync(join(projectRoot, 'README.md'), '# my project\n')
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export {}\n')

    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.drift).toEqual([])
  })

  it('writes nothing to the project', async () => {
    await install()
    const before = readFileSync(join(projectRoot, '.github', 'agents', 'developer.agent.md'), 'utf8')
    await buildCheckReport(pkgRoot, projectRoot)
    const after = readFileSync(join(projectRoot, '.github', 'agents', 'developer.agent.md'), 'utf8')
    expect(after).toBe(before)
  })

  it('counts every file it compared', async () => {
    await install()
    const report = await buildCheckReport(pkgRoot, projectRoot)
    // The vscode target ships agents, skills, instructions, workflows, prompts.
    expect(report.checked).toBeGreaterThan(20)
  })

  it('skips ide ids the manifest names but the tool does not know', async () => {
    await install()
    await writeManifest(projectRoot, {
      version: '9.9.9',
      ide: 'vscode',
      ides: ['vscode', 'not-a-real-ide'],
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stack,
    })
    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.ides).toEqual(['vscode'])
  })
})

/**
 * OpenCode and Codex both compile to AGENTS.md. Each adapter used to write the
 * file pointing at its own directory, so with both installed the last one to run
 * won and the check compared the project against two different expected files —
 * drift that no amount of syncing could clear.
 */
describe('two targets that share a root file', () => {
  let projectRoot: string
  const bothStack: StackConfig = { ides: ['opencode', 'codex'], techTools: [], teamTools: [] }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'check-shared-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('reports no drift when both are installed', async () => {
    for (const ide of ['opencode', 'codex'] as const) {
      const adapter = await IDE_ADAPTERS[ide]()
      await adapter.install(pkgRoot, projectRoot, bothStack, undefined)
    }
    await writeManifest(projectRoot, {
      version: '9.9.9',
      ide: 'opencode',
      ides: ['opencode', 'codex'],
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stack: bothStack,
    })

    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.drift.filter((d) => d.path === 'AGENTS.md')).toEqual([])
  })

  it('installs both trees and says which one the index names', async () => {
    for (const ide of ['opencode', 'codex'] as const) {
      const adapter = await IDE_ADAPTERS[ide]()
      await adapter.install(pkgRoot, projectRoot, bothStack, undefined)
    }
    const text = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(text).toContain('shared by more than one assistant')
    expect(text).toContain('.opencode/skills/')
    expect(text).not.toContain('.codex/skills/')
    // Both assistants still get their own files.
    expect(existsSync(join(projectRoot, '.opencode', 'skills'))).toBe(true)
    expect(existsSync(join(projectRoot, '.codex', 'skills'))).toBe(true)
  })
})

/**
 * The report says "deleted on the next sync" and prints "Fix: opencastle sync".
 * That is a claim about what the sweeper does, and it was false at three
 * different depths — a foreign extension at the rules root, and anything inside
 * a subdirectory the user made. CI could never go green, and `needsSync` was
 * permanently true so every `sync` did the work twice.
 */
describe('every reported extra is one that sync actually removes', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'check-converge-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  const cases: Array<[string, string[]]> = [
    ['vscode', ['.github/agents/mine.agent.md', '.github/agents/notes.txt', '.github/agents/sub/deep.md']],
    ['cursor', ['.cursor/rules/team-conventions.mdc', '.cursor/rules/NOTES.md', '.cursor/rules/team/mine.mdc']],
    ['windsurf', ['.windsurf/rules/mine.md', '.windsurf/rules/NOTES.txt', '.windsurf/rules/team/mine.md']],
    ['claude-code', ['.claude/agents/mine.md', '.claude/skills/team/SKILL.md']],
    ['opencode', ['.opencode/agents/mine.md']],
    ['codex', ['.codex/agents/mine.md']],
    ['antigravity', ['.agents/agents/mine.md']],
  ]

  for (const [ide, foreign] of cases) {
    it(`converges for ${ide}`, async () => {
      const adapter = await IDE_ADAPTERS[ide]()
      const ideStack = { ides: [ide], techTools: [], teamTools: [] } as unknown as StackConfig
      await adapter.install(pkgRoot, projectRoot, ideStack, undefined)
      await writeManifest(projectRoot, {
        version: '9.9.9',
        ide,
        ides: [ide],
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stack: ideStack,
      })

      for (const rel of foreign) {
        mkdirSync(resolve(projectRoot, rel, '..'), { recursive: true })
        writeFileSync(join(projectRoot, rel), 'mine\n')
      }

      const before = await buildCheckReport(pkgRoot, projectRoot)
      const reportedExtra = before.drift.filter((d) => d.kind === 'extra').map((d) => d.path)
      expect(reportedExtra.length, `${ide} reported no extras at all`).toBeGreaterThan(0)

      // Do what the report tells the user to do.
      await adapter.update(pkgRoot, projectRoot, ideStack)

      for (const p of reportedExtra) {
        expect(
          existsSync(join(projectRoot, p)),
          `${ide}: reported "${p}" as deleted on the next sync, but sync left it`,
        ).toBe(false)
      }

      const after = await buildCheckReport(pkgRoot, projectRoot)
      // Every kind, not only `extra`. Filtering to the one kind the fixture
      // seeded is why `sync` could stop refreshing content on four of the seven
      // targets with this suite green: the drift it left behind was all
      // `changed`, and nothing here looked at that.
      expect(after.drift, `${ide} still reports drift after its own remedy`).toEqual([])
    })

    it(`restores edited content for ${ide}`, async () => {
      const adapter = await IDE_ADAPTERS[ide]()
      const ideStack = { ides: [ide], techTools: [], teamTools: [] } as unknown as StackConfig
      await adapter.install(pkgRoot, projectRoot, ideStack, undefined)
      await writeManifest(projectRoot, {
        version: '9.9.9',
        ide,
        ides: [ide],
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stack: ideStack,
      })

      // Overwrite every generated file this target owns. `sync` compiles
      // sources into targets; if it will not replace a file whose bytes differ
      // from its source, it is not compiling anything.
      const dirs = adapter
        .getManagedPaths()
        .framework.filter((rel) => rel.endsWith('/'))
      const tampered: string[] = []
      const walk = (abs: string, rel: string): void => {
        if (!existsSync(abs)) return
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          const childAbs = join(abs, entry.name)
          const childRel = `${rel}${entry.name}`
          if (entry.isDirectory()) walk(childAbs, `${childRel}/`)
          else {
            writeFileSync(childAbs, 'STALE RELEASE CONTENT\n')
            tampered.push(childRel)
          }
        }
      }
      for (const dir of dirs) walk(join(projectRoot, dir), dir)
      expect(tampered.length, `${ide}: nothing to tamper with`).toBeGreaterThan(0)

      const before = await buildCheckReport(pkgRoot, projectRoot)
      expect(
        before.drift.filter((d) => d.kind === 'changed').length,
        `${ide}: the checker did not notice ${tampered.length} rewritten files`,
      ).toBeGreaterThan(0)

      await adapter.update(pkgRoot, projectRoot, ideStack)

      for (const rel of tampered) {
        expect(existsSync(join(projectRoot, rel)), `${ide}: sync deleted ${rel}`).toBe(true)
        expect(
          readFileSync(join(projectRoot, rel), 'utf8'),
          `${ide}: sync left stale content in ${rel}`,
        ).not.toBe('STALE RELEASE CONTENT\n')
      }

      const after = await buildCheckReport(pkgRoot, projectRoot)
      expect(after.drift, `${ide}: drift its own remedy cannot clear`).toEqual([])
    })
  }
})

/**
 * Git for Windows converts committed files to CRLF on checkout while the
 * compiler always writes LF. Byte comparison therefore called every generated
 * file drifted, on every run, with no way to make it pass — new exposure, since
 * until the config was committed git never touched it.
 */
describe('line endings are git\'s business, not the checker\'s', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'check-crlf-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('reports no drift on a CRLF checkout', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(pkgRoot, projectRoot, stack, undefined)
    await writeManifest(projectRoot, {
      version: '9.9.9',
      ide: 'vscode',
      ides: ['vscode'],
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stack,
    })

    for (const rel of ['.github/copilot-instructions.md', '.github/agents/developer.agent.md']) {
      const p = join(projectRoot, rel)
      writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'))
    }

    const report = await buildCheckReport(pkgRoot, projectRoot)
    expect(report.drift).toEqual([])
  })
})

/**
 * The checker had zero fence fixtures while the writer had a table of them, and
 * the two disagreed: the writer maintained the real block while the checker
 * compared a quoted example, so a project reported drift no sync could clear.
 * Install-then-check must be clean for every shape the writer is tested with.
 */
describe('install then check is clean, whatever the root file looks like', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'check-fence-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  const MARKER = '<!-- >>> OpenCastle managed — regenerated by `opencastle sync`, edits here are lost >>> -->'

  const prose: Array<[string, string]> = [
    ['no fences', '# House rules\n\nShip fast.\n'],
    ['an unclosed fence', '# House rules\n\n```sh\nmake ship\n\n(that is all)\n'],
    ['a closed fence', '# House rules\n\n```sh\nmake ship\n```\n'],
    ['the marker quoted in a fence', `# A\n\n\`\`\`md\n${MARKER}\nbody\n\`\`\`\n`],
    ['CRLF', '# A\r\n\r\nWindows wrote this.\r\n'],
  ]

  for (const [name, content] of prose) {
    it(`reports no drift for a root file with ${name}`, async () => {
      const adapter = await IDE_ADAPTERS['vscode']()
      mkdirSync(join(projectRoot, '.github'), { recursive: true })
      writeFileSync(join(projectRoot, '.github', 'copilot-instructions.md'), content)

      await adapter.install(pkgRoot, projectRoot, stack, undefined)
      await writeManifest(projectRoot, {
        version: '9.9.9',
        ide: 'vscode',
        ides: ['vscode'],
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stack,
      })

      const report = await buildCheckReport(pkgRoot, projectRoot)
      expect(
        report.drift.filter((d) => d.path.endsWith('copilot-instructions.md')),
        `drift reported for ${name}`,
      ).toEqual([])

      // And a second compile must not change anything the checker can see.
      await adapter.update(pkgRoot, projectRoot, stack)
      const after = await buildCheckReport(pkgRoot, projectRoot)
      expect(after.drift.filter((d) => d.path.endsWith('copilot-instructions.md'))).toEqual([])
    })
  }
})
