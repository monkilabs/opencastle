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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
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

/**
 * Three commands, one input, one judgement.
 *
 * The fixture above is a *hand-written* root file, which only ever exercises the
 * strip path. What a real 0.35.2 install has is a file the tool generated in
 * full — and on that input `sync` backed it up while `init` and `remove --all`
 * deleted it without one, the second of them one line after printing "your own
 * writing stays". Anything appended to a legacy root file must survive, or be
 * recoverable, under all three.
 */
describe('a genuinely pre-marker root file, with the user text appended', () => {
  const LEGACY_ROOT =
    '# Project Instructions\n\n' +
    'All conventions, architecture, and project context are embedded below.\n\n' +
    '## Our team additions\n\nNEVER_TOUCH_PAYMENTS\n'

  let dir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-generated-'))
    mkdirSync(join(dir, '.opencastle'), { recursive: true })
    writeFileSync(join(dir, '.opencastle', 'manifest.json'), JSON.stringify(legacyManifest(), null, 2))
    writeFileSync(join(dir, 'CLAUDE.md'), LEGACY_ROOT)
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  })

  afterEach(() => {
    cwdSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  /** The appended text is either still in the file, or in a backup beside it. */
  function stillRecoverable(): boolean {
    const file = join(dir, 'CLAUDE.md')
    const backup = `${file}.opencastle-backup`
    const inFile = existsSync(file) && readFileSync(file, 'utf8').includes('NEVER_TOUCH_PAYMENTS')
    const inBackup = existsSync(backup) && readFileSync(backup, 'utf8').includes('NEVER_TOUCH_PAYMENTS')
    return inFile || inBackup
  }

  it('survives writeManagedBlock — the path `sync` takes', async () => {
    const { writeManagedBlock } = await import('./managed-block.js')
    await writeManagedBlock(join(dir, 'CLAUDE.md'), 'fresh')
    expect(stillRecoverable(), 'lost by sync').toBe(true)
  })

  it('survives stripManagedBlockFromFile — the path `init` and `remove` take', async () => {
    const { stripManagedBlockFromFile } = await import('./managed-block.js')
    expect(await stripManagedBlockFromFile(join(dir, 'CLAUDE.md'))).toBe('deleted')
    expect(stillRecoverable(), 'lost by init/remove').toBe(true)
  })

  it('survives remove --all end to end', async () => {
    await remove({ pkgRoot, args: ['--all', '--yes'] })
    expect(stillRecoverable(), 'lost by remove --all').toBe(true)
  })

  it('is predicted as deleted, so the preview does not promise otherwise', async () => {
    const { predictStrip } = await import('./managed-block.js')
    const prediction = predictStrip(LEGACY_ROOT)
    expect(prediction.outcome).toBe('deleted')
    expect(prediction.legacyGenerated).toBe(true)
  })
})

/**
 * `.opencastle/` is the directory the drift checker tells people is theirs, and
 * for two rounds `sync` was rewriting it. The first fix ran `bootstrapCustomizations`
 * against the real project — bootstrap was written to run once, and its rename
 * and prune steps are unconditional, so a user's `supabase-config.md` was
 * overwritten by a template on every sync.
 *
 * A sentinel in every file is the assertion that generalises: whatever `sync`
 * does in there, it must not touch what it did not write.
 */
describe('sync never edits what the user wrote in .opencastle/', () => {
  const stacks: Array<[string, Record<string, unknown>]> = [
    ['no stack', { name: 'p', version: '1.0.0' }],
    ['a database', { name: 'p', version: '1.0.0', dependencies: { '@supabase/supabase-js': '^2' } }],
    ['a cms', { name: 'p', version: '1.0.0', dependencies: { '@sanity/client': '^6' } }],
    ['a deployment target', { name: 'p', version: '1.0.0', devDependencies: { vercel: '^32' } }],
  ]

  for (const [name, pkg] of stacks) {
    it(`preserves every hand edit with ${name}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc-preserve-'))
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
      try {
        writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
        const init = (await import('./init.js')).default
        await init({ pkgRoot, args: ['--yes'] })

        // Sentinel every file, and remember the exact bytes.
        const before = new Map<string, string>()
        const walk = (d: string): string[] =>
          readdirSync(d, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
          )
        for (const f of walk(join(dir, '.opencastle'))) {
          if (!f.endsWith('.md')) continue
          const text = `${readFileSync(f, 'utf8')}\n<!-- SENTINEL -->\n`
          writeFileSync(f, text)
          before.set(f, text)
        }
        expect(before.size).toBeGreaterThan(0)

        const update = (await import('./update.js')).default
        await update({ pkgRoot, args: ['--yes', '--force'] })
        await update({ pkgRoot, args: ['--yes', '--force'] })

        for (const [f, text] of before) {
          expect(existsSync(f), `sync deleted ${f.slice(dir.length + 1)}`).toBe(true)
          expect(readFileSync(f, 'utf8'), `sync rewrote ${f.slice(dir.length + 1)}`).toBe(text)
        }
      } finally {
        cwd.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('leaves the same file set init produced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-same-'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
      const init = (await import('./init.js')).default
      await init({ pkgRoot, args: ['--yes'] })

      const list = (): string[] => {
        const walk = (d: string): string[] =>
          readdirSync(d, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name).slice(dir.length + 1)],
          )
        return walk(join(dir, '.opencastle')).sort()
      }
      const afterInit = list()

      const update = (await import('./update.js')).default
      await update({ pkgRoot, args: ['--yes', '--force'] })

      // No template `init` pruned may come back.
      expect(list()).toEqual(afterInit)
    } finally {
      cwd.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
