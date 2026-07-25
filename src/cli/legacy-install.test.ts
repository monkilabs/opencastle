/**
 * The upgrade path, driven from a manifest shaped exactly as a released version
 * wrote it.
 *
 * Every test covering the co-owned root file built its manifest in the new
 * shape, so the whole suite passed while `init`, `remove --all`, and the
 * `.gitignore` block were all still broken for every install that existed. A
 * panel reproduced it three times independently. The fixture below is the one
 * that would have caught it: root file under `framework`, no `merged` key, and
 * the old path-listing gitignore block.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./prompt.js', async () => {
  const actual = await vi.importActual<typeof import('./prompt.js')>('./prompt.js')
  return { ...actual, confirm: vi.fn(async () => true), select: vi.fn(async () => 'all'), closePrompts: vi.fn() }
})

import remove from './remove.js'
import { resolveManagedPaths, ROOT_INSTRUCTION_FILES } from './managed-paths.js'
import { updateGitignore } from './gitignore.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')

/** A manifest exactly as v0.35.2 wrote it: root file in `framework`, no `merged`. */
function legacyManifest(): Record<string, unknown> {
  return {
    version: '0.35.2',
    ide: 'claude-code',
    ides: ['claude-code'],
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stack: { ides: ['claude-code'], techTools: [], teamTools: [] },
    managedPaths: {
      framework: ['CLAUDE.md', '.claude/agents/', '.claude/skills/', '.claude/commands/'],
      customizable: ['.opencastle/', '.mcp.json'],
    },
  }
}

const LEGACY_GITIGNORE = `node_modules

# >>> OpenCastle managed (do not edit) >>>
CLAUDE.md
.claude/agents/
.claude/skills/
.claude/commands/
!.opencastle/
# <<< OpenCastle managed <<<
`

describe('a manifest written before root files were co-owned', () => {
  let dir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-install-'))
    mkdirSync(join(dir, '.opencastle'), { recursive: true })
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.opencastle', 'manifest.json'), JSON.stringify(legacyManifest(), null, 2))
    writeFileSync(join(dir, 'CLAUDE.md'), '# My Handwritten Rules\n\nNEVER_TOUCH_PAYMENTS\n')
    writeFileSync(join(dir, '.claude', 'agents', 'copywriter.agent.md'), 'a retired agent\n')
    writeFileSync(join(dir, '.gitignore'), LEGACY_GITIGNORE)
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  })

  afterEach(() => {
    cwdSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is re-sorted so the root file is never treated as generated', async () => {
    const managed = await resolveManagedPaths(legacyManifest() as never)
    expect(managed.merged).toContain('CLAUDE.md')
    expect(managed.framework).not.toContain('CLAUDE.md')
    // The stored directories are kept — files from a target the user has since
    // dropped still need cleaning up.
    expect(managed.framework).toContain('.claude/agents/')
  })

  it('records no path twice, even when two targets share one', async () => {
    const managed = await resolveManagedPaths({
      ...legacyManifest(),
      ides: ['opencode', 'codex'],
    } as never)
    for (const category of [managed.framework, managed.customizable, managed.merged]) {
      expect(new Set(category).size, `duplicate in ${JSON.stringify(category)}`).toBe(category.length)
    }
    expect(managed.merged).toContain('AGENTS.md')
  })

  it('keeps the root file, and its content, through remove --all', async () => {
    await remove({ pkgRoot, args: ['--all', '--yes'] })

    expect(existsSync(join(dir, 'CLAUDE.md')), 'root file deleted').toBe(true)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('NEVER_TOUCH_PAYMENTS')
    // Wholly generated paths still go.
    expect(existsSync(join(dir, '.claude', 'agents'))).toBe(false)
  })

  it('stops ignoring the generated config once the block is rewritten', async () => {
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('CLAUDE.md')

    await updateGitignore(dir)

    const after = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(after).not.toContain('CLAUDE.md')
    expect(after).not.toContain('.claude/agents/')
    // The user's own rules are untouched.
    expect(after).toContain('node_modules')
    // And exactly one block.
    expect((after.match(/>>> OpenCastle managed/g) ?? []).length).toBe(1)
  })
})

describe('the root-file list stays in step with the adapters', () => {
  it('names every root file any adapter declares as merged', async () => {
    const { IDE_ADAPTERS } = await import('./adapters/index.js')
    for (const [ide, load] of Object.entries(IDE_ADAPTERS)) {
      for (const p of (await load()).getManagedPaths().merged ?? []) {
        expect(
          ROOT_INSTRUCTION_FILES as readonly string[],
          `${ide} merges ${p}, which the migration list does not know`,
        ).toContain(p)
      }
    }
  })
})

/**
 * Adoption is the one place the tool replaces a file it did not write in this
 * run. A previous release generated it, so replacing it is right — but there is
 * no marker to say where anything appended since begins.
 */
describe('replacing a pre-marker root file leaves a way back', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adopt-backup-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the previous contents beside it', async () => {
    const { writeManagedBlock } = await import('./managed-block.js')
    const file = join(dir, 'CLAUDE.md')
    const before =
      '# Project Instructions\n\nAll conventions, architecture, and project context are embedded below.\n\n## Our team additions\n\nDeploy only on Tuesdays.\n'
    writeFileSync(file, before)

    const result = await writeManagedBlock(file, 'fresh')
    expect(result.action).toBe('adopted')

    const backup = `${file}.opencastle-backup`
    expect(existsSync(backup), 'no backup written').toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe(before)
    expect(readFileSync(backup, 'utf8')).toContain('Deploy only on Tuesdays')
  })

  it('is reported by the adapter so a command can tell the user', async () => {
    const { IDE_ADAPTERS } = await import('./adapters/index.js')
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      '# Project Instructions\n\nAll conventions, architecture, and project context are embedded below.\n',
    )
    const adapter = await IDE_ADAPTERS['claude-code']()
    const results = await adapter.install(pkgRoot, dir, { ides: ['claude-code'], techTools: [], teamTools: [] }, undefined)
    expect(results.adopted ?? []).toContain(join(dir, 'CLAUDE.md'))
  })
})
