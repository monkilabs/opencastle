import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installStubCli, type StubCli } from './stub-cli.test-helper.js'
import { resolveAdapter, detectAdapter, listAdapters } from './index.js'

/**
 * Which runtime a run uses: `--adapter`, then the spec, then what
 * `opencastle init` configured, then detection. Every case runs against stub
 * binaries on a PATH of their own, so the machine's real CLIs never count.
 */
describe.skipIf(process.platform === 'win32')('resolveAdapter', () => {
  let stub: StubCli
  afterEach(() => stub.restore())

  /** Stub CLIs on PATH, and a project whose manifest lists `ides` (or none). */
  function setup(binaries: string[], manifest?: Record<string, unknown> | string): string {
    stub = installStubCli(...binaries)
    const project = join(stub.work, 'project')
    mkdirSync(join(project, '.opencastle'), { recursive: true })
    if (manifest !== undefined) {
      writeFileSync(
        join(project, '.opencastle', 'manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify({ version: '1.0.0', installedAt: '', updatedAt: '', ...manifest }),
      )
    }
    return project
  }

  it('takes --adapter over the spec and the configured runtime', async () => {
    const projectRoot = setup(['claude', 'codex', 'cursor-agent'], { ide: 'claude-code', ides: ['claude-code'] })
    const r = await resolveAdapter({ projectRoot, explicit: 'codex', specAdapter: 'cursor' })
    expect(r.name).toBe('codex')
    expect(r.source).toBe('flag')
    expect(r.adapter.name).toBe('codex')
    expect(r.detail).toBe('Codex CLI — --adapter codex')
  })

  it('accepts the names a person types: any case, the assistant id, or auto for none', async () => {
    const projectRoot = setup(['claude', 'copilot'])
    expect((await resolveAdapter({ projectRoot, explicit: 'Claude-Code' })).name).toBe('claude')
    expect((await resolveAdapter({ projectRoot, explicit: 'vscode' })).name).toBe('copilot')
    const auto = await resolveAdapter({ projectRoot, explicit: 'auto', specAdapter: 'auto' })
    expect(auto.source).toBe('detected')
  })

  it('refuses a chosen runtime that is not installed, saying what to install', async () => {
    const projectRoot = setup(['claude'])
    const err = await resolveAdapter({ projectRoot, explicit: 'codex' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('`codex` is not on PATH')
    expect((err as Error).message).toContain('npm install -g @openai/codex')
    expect((err as Error).message).toContain('--adapter')
  })

  it('refuses a name it does not know, listing the ones it does', async () => {
    const projectRoot = setup(['claude'])
    await expect(resolveAdapter({ projectRoot, specAdapter: 'claud' })).rejects.toThrow(/Unknown adapter "claud".*claude, codex, cursor, opencode, copilot/)
  })

  it('takes the spec over the configured runtime, and refuses it when it is missing', async () => {
    const projectRoot = setup(['claude', 'opencode'], { ides: ['claude-code'] })
    const r = await resolveAdapter({ projectRoot, specAdapter: 'opencode' })
    expect(r).toMatchObject({ name: 'opencode', source: 'spec', detail: 'OpenCode — adapter: opencode in the spec' })
    await expect(resolveAdapter({ projectRoot, specAdapter: 'cursor' })).rejects.toThrow(/Cursor Agent CLI is not installed/)
  })

  it('uses the runtime opencastle init configured, before anything detection would find', async () => {
    // Detection would pick claude; the user configured VS Code, i.e. Copilot.
    const projectRoot = setup(['claude', 'copilot'], { ides: ['vscode', 'claude-code'] })
    const r = await resolveAdapter({ projectRoot })
    expect(r).toMatchObject({ name: 'copilot', source: 'configured' })
    expect(r.detail).toBe('GitHub Copilot CLI — configured by npx opencastle init')
  })

  it('walks the configured assistants in order, saying which came first but is missing', async () => {
    const projectRoot = setup(['codex'], { ides: ['claude-code', 'codex'] })
    const r = await resolveAdapter({ projectRoot })
    expect(r).toMatchObject({ name: 'codex', source: 'configured' })
    expect(r.detail).toContain('Claude Code came first but is not installed')
  })

  it('reads a manifest written before `ides` existed', async () => {
    const projectRoot = setup(['claude', 'cursor-agent'], { ide: 'cursor' })
    expect(await resolveAdapter({ projectRoot })).toMatchObject({ name: 'cursor', source: 'configured' })
  })

  it('detects when the configured assistant has no command-line runtime', async () => {
    const projectRoot = setup(['opencode'], { ides: ['windsurf'] })
    const r = await resolveAdapter({ projectRoot })
    expect(r).toMatchObject({ name: 'opencode', source: 'detected' })
    expect(r.detail).toContain('Windsurf has no command-line agent')
  })

  it('detects, and says so, when the configured runtime is not installed', async () => {
    const projectRoot = setup(['codex'], { ides: ['claude-code'] })
    const r = await resolveAdapter({ projectRoot })
    expect(r).toMatchObject({ name: 'codex', source: 'detected' })
    expect(r.detail).toContain('npx opencastle init configured Claude Code, but `claude` is not on PATH')
  })

  it('detects in the order claude, codex, cursor, opencode, copilot', async () => {
    let projectRoot = setup(['copilot', 'opencode', 'cursor-agent', 'codex', 'claude'])
    expect((await resolveAdapter({ projectRoot })).name).toBe('claude')
    stub.restore()
    projectRoot = setup(['copilot', 'opencode', 'cursor-agent', 'codex'])
    expect((await resolveAdapter({ projectRoot })).name).toBe('codex')
    stub.restore()
    projectRoot = setup(['copilot', 'opencode'])
    const r = await resolveAdapter({ projectRoot })
    expect(r.name).toBe('opencode')
    expect(r.detail).toBe('OpenCode — found on PATH')
  })

  it('does not count Copilot unless its CLI is on PATH, though its SDK is installed here', async () => {
    const projectRoot = setup([], { ides: ['vscode'] })
    const err = await resolveAdapter({ projectRoot }).catch((e: Error) => e)
    expect((err as Error).message).toContain('npx opencastle init configured GitHub Copilot CLI, but no agent CLI is on PATH')
    expect((err as Error).message).toContain('npm install -g @github/copilot')
  })

  it('says what to install when nothing is', async () => {
    const projectRoot = setup([])
    const err = await resolveAdapter({ projectRoot }).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/^No agent CLI found on PATH/)
    for (const cmd of ['claude', 'codex', 'cursor-agent', 'opencode', 'copilot']) {
      expect((err as Error).message).toContain(`\`${cmd}\``)
    }
    expect((err as Error).message).toContain('--adapter')
  })

  it('falls back to detection when the manifest cannot be read', async () => {
    const projectRoot = setup(['codex'], '{ not json')
    expect(await resolveAdapter({ projectRoot })).toMatchObject({ name: 'codex', source: 'detected' })
  })

  it('keeps detectAdapter and listAdapters, in the new order', async () => {
    setup(['copilot', 'claude'])
    expect(await detectAdapter()).toBe('claude')
    expect(await listAdapters()).toEqual([
      { name: 'claude', available: true },
      { name: 'codex', available: false },
      { name: 'cursor', available: false },
      { name: 'opencode', available: false },
      { name: 'copilot', available: true },
    ])
  })
})
