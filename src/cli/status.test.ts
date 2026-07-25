/**
 * Tests for the no-argument status command.
 *
 * Its job is to remove flags by reading state the tool can already see, so the
 * cases below are about what it infers: not-installed vs installed, missing
 * targets, assistant config it is not compiling, and which command it names next.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildStatusReport } from './status.js'
import { writeManifest } from './manifest.js'
import type { Manifest } from './types.js'

/** A pkgRoot with a framework source tree, used for the drift comparison. */
function makePkgRoot(): string {
  const pkgRoot = mkdtempSync(join(tmpdir(), 'status-pkg-'))
  const src = join(pkgRoot, 'src', 'orchestrator', 'instructions')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'general.instructions.md'), '# General\n')
  return pkgRoot
}

async function installManifest(projectRoot: string, over: Partial<Manifest> = {}): Promise<void> {
  await writeManifest(projectRoot, {
    version: '9.9.9',
    ide: 'vscode',
    ides: ['vscode'],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  })
}

describe('status report', () => {
  let pkgRoot: string
  let projectRoot: string

  beforeEach(() => {
    pkgRoot = makePkgRoot()
    projectRoot = mkdtempSync(join(tmpdir(), 'status-proj-'))
  })

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('reports not installed on a bare project and points at init', async () => {
    const report = await buildStatusReport(pkgRoot, projectRoot)
    expect(report.installed).toBe(false)
    expect(report.nextCommand).toBe('opencastle init')
    expect(report.unmanaged).toEqual([])
  })

  it('names the assistants it found when not installed', async () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# Project\n')
    mkdirSync(join(projectRoot, '.cursor'), { recursive: true })
    writeFileSync(join(projectRoot, '.cursorrules'), 'rules\n')

    const report = await buildStatusReport(pkgRoot, projectRoot)
    expect(report.installed).toBe(false)
    expect(report.unmanaged).toContain('Claude Code')
    expect(report.unmanaged).toContain('Cursor')
    // The reason should make the lift explicit — that is the adoption pitch.
    expect(report.nextReason).toMatch(/compile it for every other assistant/)
  })

  it('flags missing generated files and suggests sync', async () => {
    await installManifest(projectRoot)
    const report = await buildStatusReport(pkgRoot, projectRoot)

    expect(report.installed).toBe(true)
    expect(report.version).toBe('9.9.9')
    expect(report.ides).toEqual(['vscode'])
    expect(report.targets[0].present).toBe(false)
    expect(report.targets[0].missing.length).toBeGreaterThan(0)
    expect(report.nextCommand).toBe('opencastle sync')
    expect(report.nextReason).toMatch(/missing generated files/)
  })

  it('is clean when every managed path exists and is newer than source', async () => {
    await installManifest(projectRoot)

    // Create every path the vscode adapter manages, stamped in the future so it
    // cannot read as stale.
    const { getManagedPaths } = await import('./adapters/vscode.js')
    const future = new Date(Date.now() + 60_000)
    for (const p of getManagedPaths().framework) {
      const abs = resolve(projectRoot, p)
      if (p.endsWith('/')) {
        mkdirSync(abs, { recursive: true })
        writeFileSync(join(abs, 'placeholder.md'), 'x\n')
        utimesSync(join(abs, 'placeholder.md'), future, future)
      } else {
        mkdirSync(resolve(abs, '..'), { recursive: true })
        writeFileSync(abs, 'x\n')
        utimesSync(abs, future, future)
      }
    }

    const report = await buildStatusReport(pkgRoot, projectRoot)
    expect(report.targets[0].present).toBe(true)
    expect(report.stale).toBe(false)
    expect(report.nextCommand).toBeUndefined()
  })

  it('detects drift when generated files predate the framework sources', async () => {
    await installManifest(projectRoot)

    const { getManagedPaths } = await import('./adapters/vscode.js')
    const past = new Date(Date.now() - 86_400_000)
    for (const p of getManagedPaths().framework) {
      const abs = resolve(projectRoot, p)
      if (p.endsWith('/')) {
        mkdirSync(abs, { recursive: true })
        writeFileSync(join(abs, 'placeholder.md'), 'x\n')
        utimesSync(join(abs, 'placeholder.md'), past, past)
      } else {
        mkdirSync(resolve(abs, '..'), { recursive: true })
        writeFileSync(abs, 'x\n')
        utimesSync(abs, past, past)
      }
    }

    const report = await buildStatusReport(pkgRoot, projectRoot)
    expect(report.stale).toBe(true)
    expect(report.nextCommand).toBe('opencastle sync')
    expect(report.nextReason).toMatch(/no longer match their sources/)
  })

  it('lists assistant config it is not compiling for', async () => {
    await installManifest(projectRoot)
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# Project\n')

    const report = await buildStatusReport(pkgRoot, projectRoot)
    // vscode is managed; Claude Code is present but not a configured target.
    expect(report.unmanaged).toContain('Claude Code')
  })

  it('does not list an assistant that is already a configured target', async () => {
    await installManifest(projectRoot, { ide: 'claude-code', ides: ['claude-code'] })
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# Project\n')

    const report = await buildStatusReport(pkgRoot, projectRoot)
    expect(report.unmanaged).not.toContain('Claude Code')
  })

  it('ignores unknown ide ids in the manifest rather than throwing', async () => {
    await installManifest(projectRoot, { ide: 'vscode', ides: ['vscode', 'not-a-real-ide'] })
    const report = await buildStatusReport(pkgRoot, projectRoot)
    expect(report.ides).toEqual(['vscode'])
  })
})

/**
 * The bare command is the front door, and it used to answer a different question
 * from `sync --check`: path existence plus mtimes, versus an actual compile. On a
 * project with a hand-edited generated file it printed "up to date" while the
 * check reported four differing files — reassurance issued immediately before
 * `sync` deleted one of them.
 */
describe('status and sync --check give the same answer', () => {
  const pkgRoot = resolve(import.meta.dirname, '..', '..')
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'status-agree-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  async function installVscode(): Promise<void> {
    const { IDE_ADAPTERS } = await import('./adapters/index.js')
    const { writeManifest } = await import('./manifest.js')
    const stack = { ides: ['vscode'] as const, techTools: [], teamTools: [] }
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(pkgRoot, projectRoot, stack as never, undefined)
    await writeManifest(projectRoot, {
      version: '9.9.9',
      ide: 'vscode',
      ides: ['vscode'],
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stack: stack as never,
    })
  }

  it('agrees that a freshly compiled project is clean', async () => {
    await installVscode()
    const { buildCheckReport } = await import('./sync-check.js')
    const status = await buildStatusReport(pkgRoot, projectRoot)
    const check = await buildCheckReport(pkgRoot, projectRoot)

    expect(check.drift).toEqual([])
    expect(status.stale).toBe(false)
  })

  it('agrees that a hand-edited generated file is drift', async () => {
    await installVscode()
    appendFileSync(join(projectRoot, '.github', 'agents', 'developer.agent.md'), '\nedited\n')

    const { buildCheckReport } = await import('./sync-check.js')
    const status = await buildStatusReport(pkgRoot, projectRoot)
    const check = await buildCheckReport(pkgRoot, projectRoot)

    expect(check.drift.length).toBeGreaterThan(0)
    expect(status.stale, 'status called a drifted project up to date').toBe(true)
  })

  it('agrees that a hand-added file under a generated directory is drift', async () => {
    await installVscode()
    writeFileSync(join(projectRoot, '.github', 'agents', 'mine.agent.md'), 'my own\n')

    const { buildCheckReport } = await import('./sync-check.js')
    const status = await buildStatusReport(pkgRoot, projectRoot)
    const check = await buildCheckReport(pkgRoot, projectRoot)

    expect(check.drift.some((d) => d.kind === 'extra')).toBe(true)
    expect(status.stale, 'status reassured the user before sync deletes the file').toBe(true)
  })
})
