import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile as readFileText, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

vi.mock('./prompt.js', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue('all'),
  closePrompts: vi.fn(),
  c: {
    green: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    magenta: (s: string) => s,
  },
}))

import remove from './remove.js'
import { confirm, select } from './prompt.js'
import { writeManagedBlock } from './managed-block.js'
import type { Manifest } from './types.js'

const START_MARKER = '# >>> OpenCastle managed (do not edit) >>>'
const END_MARKER = '# <<< OpenCastle managed <<<'

async function writeManifestFile(dir: string, manifest: Partial<Manifest> = {}): Promise<void> {
  await mkdir(join(dir, '.opencastle'), { recursive: true })
  const full: Manifest = {
    version: '1.0.0',
    ide: 'vscode',
    ides: ['vscode'],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedPaths: { framework: [], customizable: [] },
    ...manifest,
  }
  await writeFile(join(dir, '.opencastle', 'manifest.json'), JSON.stringify(full, null, 2))
}

async function writeGitignoreWithBlock(dir: string, userEntries = 'node_modules\n'): Promise<void> {
  const block = [userEntries, '', START_MARKER, '.github/', '!.github/customizations/', END_MARKER, ''].join('\n')
  await writeFile(join(dir, '.gitignore'), block)
}

// ── Tests ──────────────────────────────────────────────────────

describe('remove --all', () => {
  let tmpDir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-remove-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    vi.mocked(confirm).mockResolvedValue(true)
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    exitSpy.mockRestore()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('removes all managed framework files', async () => {
    await writeManifestFile(tmpDir, {
      managedPaths: {
        framework: ['.github/instructions/general.instructions.md'],
        customizable: [],
      },
    })
    await mkdir(join(tmpDir, '.github', 'instructions'), { recursive: true })
    await writeFile(join(tmpDir, '.github', 'instructions', 'general.instructions.md'), 'content')

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(join(tmpDir, '.github', 'instructions', 'general.instructions.md'))).toBe(false)
  })

  it('strips a root file the manifest wrongly filed under framework', async () => {
    // This test used to assert the opposite. Every release before this one wrote
    // `.github/copilot-instructions.md` into `framework`, so asserting it is
    // deleted locked in the exact loss the merged category was added to prevent.
    await writeManifestFile(tmpDir, {
      ide: 'vscode',
      ides: ['vscode'],
      managedPaths: {
        framework: ['.github/copilot-instructions.md'],
        customizable: [],
      },
    })
    const copilot = join(tmpDir, '.github', 'copilot-instructions.md')
    await mkdir(join(tmpDir, '.github'), { recursive: true })
    await writeFile(copilot, '# Our own instructions\n\nKEEP_THIS_LINE\n')

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(copilot)).toBe(true)
    expect(await readFileText(copilot, 'utf8')).toContain('KEEP_THIS_LINE')
  })

  it("strips the block from a co-owned root file but keeps the user's writing", async () => {
    // The tool created the merge; it may only undo its own half. Deleting the file
    // outright destroyed prose the user wrote before OpenCastle ever ran.
    await writeManifestFile(tmpDir, {
      managedPaths: { framework: [], customizable: [], merged: ['CLAUDE.md'] },
    })
    const claudeMd = join(tmpDir, 'CLAUDE.md')
    await writeFile(claudeMd, '# House rules\n\nNEVER_TOUCH_PAYMENTS\n')
    await writeManagedBlock(claudeMd, 'compiled instructions')

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(claudeMd)).toBe(true)
    const text = await readFileText(claudeMd, 'utf8')
    expect(text).toContain('NEVER_TOUCH_PAYMENTS')
    expect(text).not.toContain('compiled instructions')
  })

  it('deletes a co-owned root file that holds nothing but our block', async () => {
    await writeManifestFile(tmpDir, {
      managedPaths: { framework: [], customizable: [], merged: ['CLAUDE.md'] },
    })
    const claudeMd = join(tmpDir, 'CLAUDE.md')
    await writeManagedBlock(claudeMd, 'compiled instructions')

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(claudeMd)).toBe(false)
  })

  it('removes .opencastle/ directory', async () => {
    await writeManifestFile(tmpDir)
    expect(existsSync(join(tmpDir, '.opencastle'))).toBe(true)

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(join(tmpDir, '.opencastle'))).toBe(false)
  })

  it('removes legacy .opencastle.json manifest', async () => {
    await writeManifestFile(tmpDir)
    const legacyPath = join(tmpDir, '.opencastle.json')
    await writeFile(legacyPath, JSON.stringify({ version: '0.1.0', ide: 'vscode', installedAt: '', updatedAt: '' }))

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(legacyPath)).toBe(false)
  })

  it('cleans the gitignore block but keeps user entries', async () => {
    await writeManifestFile(tmpDir)
    await writeGitignoreWithBlock(tmpDir, 'node_modules\ndist\n')

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    const gitignorePath = join(tmpDir, '.gitignore')
    expect(existsSync(gitignorePath)).toBe(true)
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(gitignorePath, 'utf8')
    expect(content).not.toContain(START_MARKER)
    expect(content).not.toContain(END_MARKER)
    expect(content).toContain('node_modules')
    expect(content).toContain('dist')
  })

  it('dry-run makes no changes', async () => {
    await writeManifestFile(tmpDir, {
      managedPaths: { framework: ['some-file.md'], customizable: [] },
    })
    await writeFile(join(tmpDir, 'some-file.md'), 'content')
    await writeGitignoreWithBlock(tmpDir)

    await remove({ pkgRoot: tmpDir, args: ['--all', '--dry-run'] })

    expect(existsSync(join(tmpDir, 'some-file.md'))).toBe(true)
    expect(existsSync(join(tmpDir, '.opencastle'))).toBe(true)
    const { readFile } = await import('node:fs/promises')
    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8')
    expect(gitignore).toContain(START_MARKER)
  })

  it('exits with error when no manifest found', async () => {
    await expect(remove({ pkgRoot: tmpDir, args: ['--all'] })).rejects.toThrow('process.exit called')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ── keep-files mode (the former `eject`) ─────────────────────────────────────

describe('remove --keep-files', () => {
  let tmpDir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-remove-keep-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    vi.clearAllMocks()
    vi.mocked(confirm).mockResolvedValue(true)
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    exitSpy.mockRestore()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('drops the manifest but leaves generated files in place', async () => {
    await writeManifestFile(tmpDir, {
      managedPaths: { framework: ['keep-me.md'], customizable: [] },
    })
    await writeFile(join(tmpDir, 'keep-me.md'), 'content')

    await remove({ pkgRoot: tmpDir, args: ['--keep-files'] })

    expect(existsSync(join(tmpDir, 'keep-me.md'))).toBe(true)
    expect(existsSync(join(tmpDir, '.opencastle', 'manifest.json'))).toBe(false)
  })

  it('leaves the gitignore block alone', async () => {
    await writeManifestFile(tmpDir)
    await writeGitignoreWithBlock(tmpDir)

    await remove({ pkgRoot: tmpDir, args: ['--keep-files'] })

    const { readFile } = await import('node:fs/promises')
    const gitignore = await readFile(join(tmpDir, '.gitignore'), 'utf8')
    // The files remain managed-looking, so their ignore rules should survive.
    expect(gitignore).toContain(START_MARKER)
  })

  it('dry-run keeps the manifest', async () => {
    await writeManifestFile(tmpDir)
    await remove({ pkgRoot: tmpDir, args: ['--keep-files', '--dry-run'] })
    expect(existsSync(join(tmpDir, '.opencastle', 'manifest.json'))).toBe(true)
  })
})

// ── mode selection ───────────────────────────────────────────────────────────

describe('remove mode selection', () => {
  let tmpDir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-remove-mode-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    vi.clearAllMocks()
    vi.mocked(confirm).mockResolvedValue(true)
    vi.mocked(select).mockResolvedValue('keep-files')
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    exitSpy.mockRestore()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('asks which mode to use when neither flag is given', async () => {
    await writeManifestFile(tmpDir, {
      managedPaths: { framework: ['keep-me.md'], customizable: [] },
    })
    await writeFile(join(tmpDir, 'keep-me.md'), 'content')

    await remove({ pkgRoot: tmpDir, args: [] })

    expect(select).toHaveBeenCalled()
    // Answered 'keep-files', so the generated file must survive.
    expect(existsSync(join(tmpDir, 'keep-me.md'))).toBe(true)
  })

  it('does not ask when a mode flag is supplied', async () => {
    await writeManifestFile(tmpDir)
    await remove({ pkgRoot: tmpDir, args: ['--keep-files'] })
    expect(select).not.toHaveBeenCalled()
  })

  it('skips the confirmation prompt with --yes', async () => {
    await writeManifestFile(tmpDir)
    await remove({ pkgRoot: tmpDir, args: ['--keep-files', '--yes'] })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('aborts without touching anything when the user declines', async () => {
    await writeManifestFile(tmpDir, {
      managedPaths: { framework: ['keep-me.md'], customizable: [] },
    })
    await writeFile(join(tmpDir, 'keep-me.md'), 'content')
    vi.mocked(confirm).mockResolvedValue(false)

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(join(tmpDir, 'keep-me.md'))).toBe(true)
    expect(existsSync(join(tmpDir, '.opencastle', 'manifest.json'))).toBe(true)
  })
})

/**
 * The preview is the only thing standing between the user and an irreversible
 * command, so it has to describe what will actually happen. It used to print
 * "Will permanently delete" above a list that included files the command only
 * strips a section out of — a description of the behaviour from before those
 * files became co-owned.
 */
describe('the removal preview distinguishes deleted from edited', () => {
  let dir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oc-preview-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.mocked(confirm).mockResolvedValue(true)
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists a co-owned root file under edited, not deleted', async () => {
    await writeManifestFile(dir, {
      ide: 'claude-code',
      ides: ['claude-code'],
      managedPaths: { framework: ['.claude/agents/'], customizable: [], merged: ['CLAUDE.md'] },
    })
    await writeFile(join(dir, 'CLAUDE.md'), '# Mine\n')

    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
    try {
      await remove({ pkgRoot: dir, args: ['--all', '--dry-run'] })
    } finally {
      logSpy.mockRestore()
    }

    const text = lines.join('\n')
    const deletedAt = text.indexOf('Deleted')
    const editedAt = text.indexOf('Edited, not deleted')
    const claudeAt = text.indexOf('CLAUDE.md')

    expect(editedAt, 'no "edited" section').toBeGreaterThan(-1)
    expect(claudeAt, 'CLAUDE.md listed under deleted').toBeGreaterThan(editedAt)
    expect(text).not.toContain('Will permanently delete')
    expect(text.slice(deletedAt, editedAt)).toContain('.claude/agents/')
  })
})

/**
 * The preview is a promise. This runs it twice — once as `--dry-run` to capture
 * what was promised, once for real — and holds the second to the first. Three
 * separate preview bugs got through review because each was checked by reading
 * the code rather than by comparing the two.
 */
describe('the preview matches what removal actually does', () => {
  let dir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oc-promise-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.mocked(confirm).mockResolvedValue(true)
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  async function capture(args: string[]): Promise<string> {
    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
    try {
      await remove({ pkgRoot: dir, args })
    } finally {
      logSpy.mockRestore()
    }
    // Strip ANSI so the assertions read the text, not the colouring.
    return lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '')
  }

  /** Paths listed under a heading, in order, until the next heading. */
  function section(text: string, heading: string): string[] {
    const start = text.indexOf(heading)
    if (start === -1) return []
    const rest = text.slice(start + heading.length)
    const end = rest.search(/\n\s{2}[A-Z]/)
    return [...(end === -1 ? rest : rest.slice(0, end)).matchAll(/^\s*[-~]\s+(\S+)/gm)].map((m) => m[1])
  }

  it('keeps every file it lists as edited, and deletes every file it lists as deleted', async () => {
    await writeManifestFile(dir, {
      ide: 'claude-code',
      ides: ['claude-code'],
      managedPaths: {
        framework: ['.claude/agents/'],
        customizable: [],
        merged: ['CLAUDE.md'],
      },
    })
    await mkdir(join(dir, '.claude', 'agents'), { recursive: true })
    await writeFile(join(dir, '.claude', 'agents', 'a.md'), 'generated\n')
    // A root file with the user's own writing: must be kept.
    await writeFile(join(dir, 'CLAUDE.md'), '# Mine\n\nKEEP_THIS\n')
    await writeGitignoreWithBlock(dir)

    const promised = await capture(['--all', '--dry-run'])
    const willDelete = section(promised, 'Deleted')
    const willEdit = section(promised, 'Edited, not deleted')

    expect(willEdit, 'CLAUDE.md not promised as kept').toContain('CLAUDE.md')
    expect(willDelete.length).toBeGreaterThan(0)

    await capture(['--all', '--yes'])

    for (const p of willEdit) {
      if (p === '.gitignore') continue
      expect(existsSync(join(dir, p)), `promised to keep ${p}, but it is gone`).toBe(true)
    }
    for (const p of willDelete) {
      expect(existsSync(join(dir, p)), `promised to delete ${p}, but it is still there`).toBe(false)
    }
    expect(await readFileText(join(dir, 'CLAUDE.md'), 'utf8')).toContain('KEEP_THIS')
  })

  it('lists a root file holding only our block as deleted, not edited', async () => {
    await writeManifestFile(dir, {
      ide: 'claude-code',
      ides: ['claude-code'],
      managedPaths: { framework: [], customizable: [], merged: ['CLAUDE.md'] },
    })
    await writeManagedBlock(join(dir, 'CLAUDE.md'), 'compiled')

    const promised = await capture(['--all', '--dry-run'])
    expect(section(promised, 'Deleted')).toContain('CLAUDE.md')
    expect(section(promised, 'Edited, not deleted')).not.toContain('CLAUDE.md')

    await capture(['--all', '--yes'])
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
  })

  it('names each path exactly once', async () => {
    await writeManifestFile(dir, {
      ide: 'claude-code',
      ides: ['claude-code'],
      managedPaths: { framework: [], customizable: ['.opencastle/'], merged: [] },
    })

    const promised = await capture(['--all', '--dry-run'])
    const listed = [...promised.matchAll(/^\s*[-~]\s+(\S+)/gm)].map((m) => m[1])
    expect(new Set(listed).size, `duplicate in ${JSON.stringify(listed)}`).toBe(listed.length)
  })

  it('does not mention .gitignore when the project has none', async () => {
    await writeManifestFile(dir, {
      ide: 'claude-code',
      ides: ['claude-code'],
      managedPaths: { framework: [], customizable: [], merged: [] },
    })
    const promised = await capture(['--all', '--dry-run'])
    expect(promised).not.toContain('.gitignore')
  })
})
