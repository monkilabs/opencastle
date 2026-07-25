/**
 * Tests for `opencastle sync --check`.
 *
 * The check exists so CI can fail when generated assistant config stops matching
 * its sources — someone edits `.cursor/rules/foo.mdc` directly, or upgrades the
 * package without recompiling. A stale rule file still loads fine, so nothing
 * else would notice.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
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
