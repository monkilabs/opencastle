/**
 * `opencastle plugin` and an Agent Plugin baseline, through the built CLI.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mcpSchemaUrl, pluginSchemaUrl } from './agent-plugin.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(pkgRoot, 'bin', 'cli.mjs')
const built = existsSync(join(pkgRoot, 'dist', 'cli', 'plugin.js'))

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))

describe.skipIf(!built)('opencastle plugin', () => {
  let dir: string
  const run = (cwd: string, ...args: string[]) => spawnSync('node', [cli, ...args], { cwd, encoding: 'utf8' })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-plugin-cmd-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a scaffolded baseline is a plugin every assistant loads, Claude Code included', () => {
    expect(run(dir, 'baseline', 'init', 'base', '--name', '@acme/base').status).toBe(0)
    const out = run(dir, 'plugin', 'check', 'base')
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('Loads in GitHub Copilot, VS Code, Cursor, Codex and Kiro as it is, and in Claude Code.')
    expect(readJson(join(dir, 'base', 'plugin.json'))).toMatchObject({ $schema: pluginSchemaUrl(), name: 'acme.base' })
    expect(run(dir, 'baseline', 'check', 'base').status).toBe(0)
  })

  it('build keeps Claude Code’s files in step with the portable ones, and keeps what only Claude Code reads', () => {
    run(dir, 'baseline', 'init', 'base', '--name', '@acme/base')
    const base = join(dir, 'base')
    write(base, {
      'mcp.json': JSON.stringify({ $schema: mcpSchemaUrl(), mcpServers: { docs: { type: 'streamable-http', url: 'https://docs.acme.example/mcp' } } }),
      // The scaffold's example policy allows four servers; a team adding one allows it.
      'dev.opencastle/config.json': JSON.stringify({ policy: { mcp: { allow: ['docs'], remoteHosts: ['docs.acme.example'] } } }),
    })
    const claude = join(base, '.claude-plugin', 'plugin.json')
    writeFileSync(claude, JSON.stringify({ ...readJson(claude), userConfig: { region: { type: 'string', title: 'Region', description: 'Where' } } }))

    const stale = run(dir, 'plugin', 'check', 'base')
    expect(stale.status).toBe(1)
    expect(stale.stdout).toContain('.mcp.json does not match plugin.json and mcp.json')
    expect(run(dir, 'plugin', 'build', 'base', '--check').status).toBe(1)

    expect(run(dir, 'plugin', 'build', 'base').status).toBe(0)
    expect(readJson(join(base, '.mcp.json'))).toEqual({ mcpServers: { docs: { type: 'http', url: 'https://docs.acme.example/mcp' } } })
    expect(readJson(claude)).toMatchObject({ name: 'acme.base', version: '0.1.0', userConfig: { region: { title: 'Region' } } })
    expect(run(dir, 'plugin', 'check', 'base').status).toBe(0)
    expect(run(dir, 'baseline', 'check', 'base').status).toBe(0)
  })

  it('index lists every plugin for Claude Code and Copilot, Cursor and Codex', () => {
    const plugin = (name: string): Record<string, string> => ({
      [`plugins/${name}/plugin.json`]: JSON.stringify({ $schema: pluginSchemaUrl(), name, description: `The ${name} plugin` }),
    })
    write(dir, { 'package.json': JSON.stringify({ name: '@acme/agent-plugins', author: 'Acme Platform <p@acme.example>' }), ...plugin('deploy'), ...plugin('review') })
    const out = run(dir, 'plugin', 'index')
    expect(out.status).toBe(0)
    const shared = {
      name: 'acme.agent-plugins',
      owner: { name: 'Acme Platform' },
      metadata: { description: 'Agent Plugins from acme.agent-plugins' },
      plugins: [
        { name: 'deploy', source: './plugins/deploy', description: 'The deploy plugin' },
        { name: 'review', source: './plugins/review', description: 'The review plugin' },
      ],
    }
    expect(readJson(join(dir, '.claude-plugin', 'marketplace.json'))).toEqual(shared)
    expect(readJson(join(dir, '.cursor-plugin', 'marketplace.json'))).toEqual(shared)
    expect(readJson(join(dir, '.agents', 'plugins', 'marketplace.json'))).toMatchObject({
      name: 'acme.agent-plugins',
      plugins: [{ name: 'deploy', source: { source: 'local', path: './plugins/deploy' }, policy: { installation: 'AVAILABLE' } }, { name: 'review' }],
    })
    expect(out.stdout).toContain('Claude Code needs .claude-plugin/plugin.json')
    expect(run(dir, 'plugin', 'index', '--check').status).toBe(0)

    write(dir, plugin('release'))
    const behind = run(dir, 'plugin', 'index', '--check')
    expect(behind.status).toBe(1)
    expect(behind.stderr).toContain('.claude-plugin/marketplace.json does not list the plugins under plugins/')
  })

  it('index refuses two plugins with one name', () => {
    write(dir, {
      'plugins/a/plugin.json': JSON.stringify({ $schema: pluginSchemaUrl(), name: 'same' }),
      'plugins/b/plugin.json': JSON.stringify({ $schema: pluginSchemaUrl(), name: 'same' }),
    })
    const out = run(dir, 'plugin', 'index')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('are both named "same"')
  })

  it('a project extending the plugin gets its skill and server in every assistant', () => {
    run(dir, 'baseline', 'init', 'base', '--name', '@acme/base')
    write(join(dir, 'base'), {
      'mcp.json': JSON.stringify({ $schema: mcpSchemaUrl(), mcpServers: { docs: { type: 'streamable-http', url: 'https://docs.acme.example/mcp' } } }),
      // The scaffold's example policy allows four servers; a team adding one allows it.
      'dev.opencastle/config.json': JSON.stringify({ policy: { mcp: { allow: ['docs'], remoteHosts: ['docs.acme.example'] } } }),
    })
    const project = join(dir, 'app')
    write(project, {
      'CLAUDE.md': '# App\n',
      '.opencastle/config.json': JSON.stringify({ extends: ['../../base'] }),
    })
    execFileSync('git', ['init', '-q'], { cwd: project })
    const init = run(project, 'init', '--yes')
    expect(init.status, init.stdout + init.stderr).toBe(0)
    expect(existsSync(join(project, '.claude', 'skills', 'code-review', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toContain('Engineering standards')
    expect(readJson(join(project, '.mcp.json'))).toMatchObject({ mcpServers: { docs: { type: 'http', url: 'https://docs.acme.example/mcp' } } })
    expect(run(project, 'sync', '--check').status).toBe(0)
  })
})
