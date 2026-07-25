import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
        framework: ['.github/instructions/general.instructions.md', '.github/copilot-instructions.md'],
        customizable: [],
      },
    })
    await mkdir(join(tmpDir, '.github', 'instructions'), { recursive: true })
    await writeFile(join(tmpDir, '.github', 'instructions', 'general.instructions.md'), 'content')
    await writeFile(join(tmpDir, '.github', 'copilot-instructions.md'), 'content')

    await remove({ pkgRoot: tmpDir, args: ['--all'] })

    expect(existsSync(join(tmpDir, '.github', 'instructions', 'general.instructions.md'))).toBe(false)
    expect(existsSync(join(tmpDir, '.github', 'copilot-instructions.md'))).toBe(false)
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
