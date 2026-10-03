/**
 * Compiled commands live under `oc:` — `/oc:bug-fix` — and OpenCastle owns that
 * namespace and nothing beside it. A command someone writes by hand keeps its
 * name, is never overwritten, never swept, and never reported as drift; what a
 * release before the namespace left outside it is cleaned up once.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDE_ADAPTERS } from './adapters/index.js'
import { resolveSources, materialize } from './layers.js'
import { buildCheckReport } from './sync-check.js'
import { writeManifest, createManifest } from './manifest.js'
import { recordLockFor } from './lock.js'
import { resolveManagedPaths, ownerOf, removeOwnedFiles } from './managed-paths.js'
import { carriesOurBanner, commandName, legacyClaudeCommands, withCommandName } from './command-namespace.js'
import type { Manifest, StackConfig } from './types.js'

vi.mock('./prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompt.js')>()
  return { ...actual, confirm: vi.fn().mockResolvedValue(true), select: vi.fn().mockResolvedValue('all'), closePrompts: vi.fn() }
})

import remove from './remove.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')

const BANNER = '<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->'
/** What a release before the namespace compiled to `.claude/commands/bug-fix.md`. */
const LEGACY_COMMAND = `${BANNER}\n\n# Fix Bug\n\nYou are the Team Lead.\n`
/** A command a person wrote. */
const OWN_COMMAND = '# Deploy\n\nRun our deploy script and report back.\n'

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

function manifestFor(ides: StackConfig['ides'], version = '1.0.0', extra: Partial<Manifest> = {}): Manifest {
  return {
    version,
    ide: ides[0],
    ides,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stack: { ides, techTools: [], teamTools: [] },
    ...extra,
  }
}

describe('the command name', () => {
  it('is the source name under oc:', () => {
    expect(commandName('bug-fix')).toBe('oc:bug-fix')
  })

  it('goes into the frontmatter first, keeping every other field', () => {
    const out = withCommandName("---\ndescription: 'Fix it'\nagent: 'Team Lead (OpenCastle)'\n---\n\nBody\n", 'bug-fix')
    expect(out).toBe("---\nname: 'oc:bug-fix'\ndescription: 'Fix it'\nagent: 'Team Lead (OpenCastle)'\n---\n\nBody\n")
  })

  it('replaces a name the source declared, so both assistants agree on it', () => {
    const out = withCommandName("---\nname: ship\ndescription: 'Ship'\n---\nBody", 'release')
    expect(out).toContain("name: 'oc:release'")
    expect(out).not.toContain('name: ship')
  })

  it('drops a block-scalar name whole, so the YAML still parses', () => {
    const out = withCommandName("---\nname: >\n  ship it\n  now\ndescription: 'Ship'\n---\nBody", 'release')
    expect(out).toBe("---\nname: 'oc:release'\ndescription: 'Ship'\n---\nBody")
  })

  it('keeps CRLF endings in a prompt checked out on Windows', () => {
    const out = withCommandName("---\r\ndescription: 'x'\r\n---\r\n\r\nBody\r\n", 'x')
    expect(out).toBe("---\r\nname: 'oc:x'\r\ndescription: 'x'\r\n---\r\n\r\nBody\r\n")
  })

  it('adds frontmatter to a prompt that has none', () => {
    expect(withCommandName('Just a body\n', 'plain')).toBe("---\nname: 'oc:plain'\n---\n\nJust a body\n")
  })
})

describe('our banner', () => {
  it('counts inside an HTML comment near the top', () => {
    expect(carriesOurBanner(LEGACY_COMMAND)).toBe(true)
    expect(carriesOurBanner(`﻿${LEGACY_COMMAND}`)).toBe(true)
  })

  it('does not count in a sentence a person wrote', () => {
    expect(carriesOurBanner('# Notes\n\nThis file is managed by OpenCastle, mostly.\n')).toBe(false)
    expect(carriesOurBanner(OWN_COMMAND)).toBe(false)
  })
})

describe('Claude Code: /oc:<name>', () => {
  let project: string
  const stack: StackConfig = { ides: ['claude-code'], techTools: [], teamTools: [] }

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-ns-claude-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it("compiles a team's own prompt into the namespace too", async () => {
    write(project, { '.opencastle/prompts/release.prompt.md': "---\ndescription: 'Cut a release'\n---\n\nRELEASE-PROMPT\n" })
    const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack }), pkgRoot)
    try {
      await (await IDE_ADAPTERS['claude-code']()).install(pkgRoot, project, stack, undefined, src)
    } finally {
      src.dispose()
    }
    expect(readFileSync(join(project, '.claude/commands/oc/release.md'), 'utf8')).toContain('RELEASE-PROMPT')
    expect(existsSync(join(project, '.claude/commands/oc/bug-fix.md'))).toBe(true)
    expect(existsSync(join(project, '.claude/commands/oc/workflow-bug-fix.md'))).toBe(true)
  })

  it('gives each command the one line Claude Code lists beside it, and nothing else', async () => {
    write(project, {
      '.opencastle/prompts/release.prompt.md': "---\ndescription: 'Cut a release'\nagent: 'Team Lead (OpenCastle)'\n---\n\nRELEASE-PROMPT\n",
    })
    const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack }), pkgRoot)
    try {
      await (await IDE_ADAPTERS['claude-code']()).install(pkgRoot, project, stack, undefined, src)
    } finally {
      src.dispose()
    }
    const release = readFileSync(join(project, '.claude/commands/oc/release.md'), 'utf8')
    // Without it Claude Code shows the first line, which was the managed-file banner.
    expect(release.startsWith('---\ndescription: "Cut a release"\n---\n')).toBe(true)
    expect(release).not.toContain('agent:')
    // A workflow has no frontmatter; its heading is the description.
    expect(readFileSync(join(project, '.claude/commands/oc/workflow-bug-fix.md'), 'utf8')).toMatch(
      /^---\ndescription: "Workflow: Bug Fix"\n---\n/,
    )
  })

  it('leaves a command someone wrote alone: not swept, not overwritten, not drift', async () => {
    write(project, { '.claude/commands/deploy.md': OWN_COMMAND, '.claude/commands/bug-fix.md': OWN_COMMAND })
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(pkgRoot, project, stack)
    const swept = await adapter.update(pkgRoot, project, stack)
    await writeManifest(project, manifestFor(['claude-code']))
    await recordLockFor(pkgRoot, project, manifestFor(['claude-code']))

    // Their `/bug-fix` and ours, `/oc:bug-fix`, side by side.
    expect(readFileSync(join(project, '.claude/commands/deploy.md'), 'utf8')).toBe(OWN_COMMAND)
    expect(readFileSync(join(project, '.claude/commands/bug-fix.md'), 'utf8')).toBe(OWN_COMMAND)
    expect(readFileSync(join(project, '.claude/commands/oc/bug-fix.md'), 'utf8')).toContain('# Fix Bug')
    expect(swept.deleted ?? []).toEqual([])

    const report = await buildCheckReport(pkgRoot, project)
    expect(report.drift).toEqual([])
  })

  it('removes what a release before the namespace left at the top, and keeps what a person wrote', async () => {
    write(project, {
      '.claude/commands/bug-fix.md': LEGACY_COMMAND,
      '.claude/commands/workflow-bug-fix.md': `${BANNER}\n\n# Workflow: Bug Fix\n`,
      '.claude/commands/deploy.md': OWN_COMMAND,
    })
    const adapter = await IDE_ADAPTERS['claude-code']()
    await writeManifest(project, manifestFor(['claude-code'], '0.38.2'))

    // Before the sync, the check names the stale commands.
    const before = await buildCheckReport(pkgRoot, project)
    const extra = before.drift.filter((d) => d.kind === 'extra').map((d) => d.path)
    expect(extra).toEqual(['.claude/commands/bug-fix.md', '.claude/commands/workflow-bug-fix.md'])

    const results = await adapter.update(pkgRoot, project, stack)
    expect(results.deleted).toEqual(expect.arrayContaining(['.claude/commands/bug-fix.md', '.claude/commands/workflow-bug-fix.md']))
    expect(readdirSync(join(project, '.claude/commands')).sort()).toEqual(['deploy.md', 'oc'])
    expect(readFileSync(join(project, '.claude/commands/deploy.md'), 'utf8')).toBe(OWN_COMMAND)
    expect(legacyClaudeCommands(project)).toEqual([])
  })

  it("keeps a person's edited copy of a namespaced command, banner and all", async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(pkgRoot, project, stack)
    const ours = readFileSync(join(project, '.claude/commands/oc/bug-fix.md'), 'utf8')
    expect(carriesOurBanner(ours)).toBe(true)
    write(project, { '.claude/commands/our-bug-fix.md': `${ours}\nOur extra step.\n` })

    const results = await adapter.update(pkgRoot, project, stack)
    expect(results.deleted ?? []).toEqual([])
    expect(existsSync(join(project, '.claude/commands/our-bug-fix.md'))).toBe(true)
    expect(legacyClaudeCommands(project)).toEqual([])
  })

  it('cleans up after 1.0.0 too, which shipped before the namespace', async () => {
    write(project, { '.claude/commands/bug-fix.md': LEGACY_COMMAND, '.claude/commands/deploy.md': OWN_COMMAND })
    // As 1.0.0 wrote it: a later version than any cut-off would have guessed,
    // and no namespace mark.
    await writeManifest(project, manifestFor(['claude-code'], '1.0.0'))
    expect(legacyClaudeCommands(project)).toEqual(['.claude/commands/bug-fix.md'])

    await (await IDE_ADAPTERS['claude-code']()).update(pkgRoot, project, stack)
    expect(readdirSync(join(project, '.claude/commands')).sort()).toEqual(['deploy.md', 'oc'])
  })

  it('a new manifest carries the namespace mark from the start', async () => {
    expect(createManifest('9.9.9', 'claude-code').commandNamespace).toBe('oc')
  })

  it('frees the old names once the project is namespaced: a copy under one is kept', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(pkgRoot, project, stack)
    await writeManifest(project, manifestFor(['claude-code'], '1.0.0', { commandNamespace: 'oc' }))
    // A team that prefers the short name copies ours back, banner and all.
    const ours = readFileSync(join(project, '.claude/commands/oc/bug-fix.md'), 'utf8')
    write(project, { '.claude/commands/bug-fix.md': ours })

    expect(legacyClaudeCommands(project)).toEqual([])
    const results = await adapter.update(pkgRoot, project, stack)
    expect(results.deleted ?? []).toEqual([])
    expect(readFileSync(join(project, '.claude/commands/bug-fix.md'), 'utf8')).toBe(ours)
  })

  it('narrows a stored .claude/commands/ to the namespace, so nothing else is ever deleted by it', async () => {
    const paths = await resolveManagedPaths(
      manifestFor(['claude-code'], '0.38.2', {
        managedPaths: { framework: ['.claude/agents/', '.claude/skills/', '.claude/commands/'], customizable: [] },
      }),
    )
    expect(paths.framework).toContain('.claude/commands/oc/')
    expect(paths.framework).not.toContain('.claude/commands/')
  })
})

describe('remove --all', () => {
  let project: string
  let cwd: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-ns-remove-'))
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    cwd.mockRestore()
    vi.restoreAllMocks()
    rmSync(project, { recursive: true, force: true })
  })

  it("takes OpenCastle's commands, old and new, and leaves the user's", async () => {
    const stack: StackConfig = { ides: ['claude-code'], techTools: [], teamTools: [] }
    await (await IDE_ADAPTERS['claude-code']()).install(pkgRoot, project, stack)
    write(project, {
      '.claude/commands/bug-fix.md': LEGACY_COMMAND,
      '.claude/commands/deploy.md': OWN_COMMAND,
    })
    // As a release before the namespace recorded it: the whole directory.
    await writeManifest(
      project,
      manifestFor(['claude-code'], '0.38.2', {
        managedPaths: { framework: ['.claude/agents/', '.claude/skills/', '.claude/commands/'], customizable: ['.opencastle/', '.mcp.json'], merged: ['CLAUDE.md'] },
      }),
    )

    await remove({ pkgRoot, args: ['--all', '--yes'] })

    expect(existsSync(join(project, '.claude/commands/oc'))).toBe(false)
    expect(existsSync(join(project, '.claude/commands/bug-fix.md'))).toBe(false)
    expect(readFileSync(join(project, '.claude/commands/deploy.md'), 'utf8')).toBe(OWN_COMMAND)
  })
})

describe('VS Code: /oc:<name>', () => {
  let project: string
  const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: [] }

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-ns-vscode-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('names each prompt oc:<name>, in a file VS Code finds at the top of .github/prompts/', async () => {
    await (await IDE_ADAPTERS['vscode']()).install(pkgRoot, project, stack)
    const files = readdirSync(join(project, '.github/prompts'))
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.startsWith('oc.') && f.endsWith('.prompt.md'))).toBe(true)

    const text = readFileSync(join(project, '.github/prompts/oc.bug-fix.prompt.md'), 'utf8')
    expect(text.split('\n').slice(0, 2)).toEqual(['---', "name: 'oc:bug-fix'"])
    // The rest of the source's frontmatter is still there.
    expect(text).toContain("agent: 'Team Lead (OpenCastle)'")
  })

  it('replaces the un-namespaced prompt files an earlier release wrote', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(pkgRoot, project, stack)
    write(project, { '.github/prompts/bug-fix.prompt.md': `---\ndescription: 'old'\n---\n\n${BANNER}\n` })
    // The project as the upgrading sync finds it: last compiled before the namespace.
    await writeManifest(project, manifestFor(['vscode'], '0.38.2'))

    // Reported once, saying why.
    const report = await buildCheckReport(pkgRoot, project)
    expect(report.drift.filter((d) => d.kind === 'extra')).toEqual([
      { ide: 'vscode', path: '.github/prompts/bug-fix.prompt.md', kind: 'extra', detail: 'written by a release before the oc: namespace' },
    ])

    const results = await adapter.update(pkgRoot, project, stack)
    expect(results.deleted).toContain('.github/prompts/bug-fix.prompt.md')
    expect(existsSync(join(project, '.github/prompts/oc.bug-fix.prompt.md'))).toBe(true)
  })

  it("leaves a prompt someone wrote in .github/prompts/ alone: not swept, not drift, not removed", async () => {
    const own = "---\ndescription: 'Deploy'\n---\n\nRun our deploy.\n"
    write(project, {
      '.github/prompts/deploy.prompt.md': own,
      // Same name as one of ours before the namespace, but theirs: no banner.
      '.github/prompts/bug-fix.prompt.md': own,
    })
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(pkgRoot, project, stack)
    const results = await adapter.update(pkgRoot, project, stack)
    expect(results.deleted ?? []).toEqual([])
    await writeManifest(project, manifestFor(['vscode']))
    await recordLockFor(pkgRoot, project, manifestFor(['vscode']))
    expect((await buildCheckReport(pkgRoot, project)).drift).toEqual([])

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await writeManifest(
        project,
        manifestFor(['vscode'], '1.0.0', { managedPaths: { framework: ['.github/prompts/', '.github/agents/'], customizable: [] } }),
      )
      await remove({ pkgRoot, args: ['--all', '--yes'] })
    } finally {
      cwd.mockRestore()
      log.mockRestore()
    }
    expect(readFileSync(join(project, '.github/prompts/deploy.prompt.md'), 'utf8')).toBe(own)
    expect(readFileSync(join(project, '.github/prompts/bug-fix.prompt.md'), 'utf8')).toBe(own)
    expect(readdirSync(join(project, '.github/prompts')).sort()).toEqual(['bug-fix.prompt.md', 'deploy.prompt.md'])
    expect(existsSync(join(project, '.github/agents'))).toBe(false)
  })
})

const cli = join(pkgRoot, 'bin', 'cli.mjs')
const built = existsSync(join(pkgRoot, 'dist', 'cli', 'init.js'))

describe.skipIf(!built)('init over an install a release before the namespace left without a manifest', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-ns-orphan-'))
    execFileSync('git', ['init', '-q'], { cwd: project })
    write(project, {
      'CLAUDE.md': '# House rules\n',
      '.claude/commands/bug-fix.md': LEGACY_COMMAND,
      '.claude/commands/deploy.md': OWN_COMMAND,
      '.claude/agents/developer.agent.md': 'an old body\n',
    })
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('recompiles it: the stale /bug-fix goes, old bodies are refreshed, their own command stays', () => {
    const out = execFileSync('node', [cli, 'init', '--yes'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(out).toContain('from a previous installation')
    expect(existsSync(join(project, '.claude/commands/bug-fix.md'))).toBe(false)
    expect(readFileSync(join(project, '.claude/commands/deploy.md'), 'utf8')).toBe(OWN_COMMAND)
    expect(readFileSync(join(project, '.claude/agents/developer.agent.md'), 'utf8')).not.toBe('an old body\n')
    expect(existsSync(join(project, '.claude/commands/oc/bug-fix.md'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(project, '.opencastle/manifest.json'), 'utf8')) as Manifest
    expect(manifest.commandNamespace).toBe('oc')
  })

  it('the sync that upgrades a 1.0.0 project removes its old commands and marks it, once', () => {
    execFileSync('node', [cli, 'init', '--yes'], { cwd: project, stdio: 'ignore' })
    // Back to how 1.0.0 left it: its commands at the top, its manifest unmarked.
    write(project, { '.claude/commands/bug-fix.md': LEGACY_COMMAND })
    const path = join(project, '.opencastle/manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    delete manifest.commandNamespace
    manifest.version = '1.0.0'
    writeFileSync(path, JSON.stringify(manifest, null, 2))

    execFileSync('node', [cli, 'sync', '--yes'], { cwd: project, stdio: 'ignore' })
    expect(existsSync(join(project, '.claude/commands/bug-fix.md'))).toBe(false)
    expect((JSON.parse(readFileSync(path, 'utf8')) as Manifest).commandNamespace).toBe('oc')

    // Now the short name is theirs to use.
    write(project, { '.claude/commands/bug-fix.md': LEGACY_COMMAND })
    execFileSync('node', [cli, 'sync', '--yes', '--force'], { cwd: project, stdio: 'ignore' })
    expect(existsSync(join(project, '.claude/commands/bug-fix.md'))).toBe(true)
  })
})

describe('removing from the shared prompts directory', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-ns-shared-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it("takes only our files at the top, and none of a person's subfolders", () => {
    write(project, {
      '.github/prompts/oc.bug-fix.prompt.md': 'ours',
      '.github/prompts/deploy.prompt.md': 'theirs',
      '.github/prompts/drafts/oc.idea.prompt.md': 'theirs, below the top',
    })
    mkdirSync(join(project, '.github/prompts/empty-folder'))
    const owns = (rel: string): boolean => /^\.github\/prompts\/oc\.[^/]+$/.test(rel)
    expect(removeOwnedFiles(project, '.github/prompts/', owns)).toBe(1)
    expect(readdirSync(join(project, '.github/prompts')).sort()).toEqual(['deploy.prompt.md', 'drafts', 'empty-folder'])
    expect(existsSync(join(project, '.github/prompts/drafts/oc.idea.prompt.md'))).toBe(true)
  })

  it('leaves a file wearing the directory name for a person, without throwing', () => {
    write(project, { '.github/prompts': 'not a directory' })
    expect(removeOwnedFiles(project, '.github/prompts/', () => true)).toBe(0)
    expect(readFileSync(join(project, '.github/prompts'), 'utf8')).toBe('not a directory')
  })

  it('removes the directory when ours was all it held', () => {
    write(project, { '.github/prompts/oc.bug-fix.prompt.md': 'ours' })
    expect(removeOwnedFiles(project, '.github/prompts/', () => true)).toBe(1)
    expect(existsSync(join(project, '.github/prompts'))).toBe(false)
  })

  it('treats only .github/prompts/ as shared — every other VS Code directory is removed whole', async () => {
    const vscode = await IDE_ADAPTERS['vscode']()
    expect(ownerOf([vscode], '.github/prompts/', project)).toBeTypeOf('function')
    for (const dir of ['.github/agents/', '.github/instructions/', '.github/skills/', '.github/agent-workflows/']) {
      expect(ownerOf([vscode], dir, project)).toBeUndefined()
    }
  })
})
