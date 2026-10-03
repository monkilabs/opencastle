/**
 * Codex CLI, driven through the built CLI the way a project meets it.
 *
 * Codex reads a repository's skills only from `.agents/skills/` and its MCP
 * servers only from `.codex/config.toml`. Every release up to 1.0.0 wrote
 * `.codex/skills/` and `.codex/mcp.json` instead, so a Codex user got the root
 * AGENTS.md and nothing else — and every check reported the install healthy,
 * because each compared the project against the same wrong paths.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import type { Manifest } from './types.js'
import { teamEntryFor } from './mcp.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(pkgRoot, 'bin', 'cli.mjs')
const built = existsSync(join(pkgRoot, 'dist', 'cli', 'init.js'))

const USERS_CONFIG = `# Codex settings, written by hand
model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.mine]
command = "my-own-server"
`

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

function run(project: string, ...args: string[]): string {
  return execFileSync('node', [cli, ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function servers(project: string): Record<string, Record<string, unknown>> {
  const text = readFileSync(join(project, '.codex/config.toml'), 'utf8')
  return ((parseToml(text) as { mcp_servers?: Record<string, Record<string, unknown>> }).mcp_servers ?? {})
}

describe("a team server in Codex's own fields", () => {
  it('sends a bearer token, and a header that is one variable, from the environment', () => {
    const { entry } = teamEntryFor(
      'acme-docs',
      {
        type: 'http',
        url: 'https://docs.acme.example/mcp',
        headers: { Authorization: 'Bearer ${ACME_DOCS_TOKEN}', 'X-Tenant': '${ACME_TENANT}', 'X-Client': 'opencastle' },
      },
      'codex',
    )
    expect(entry).toEqual({
      url: 'https://docs.acme.example/mcp',
      bearer_token_env_var: 'ACME_DOCS_TOKEN',
      env_http_headers: { 'X-Tenant': 'ACME_TENANT' },
      http_headers: { 'X-Client': 'opencastle' },
    })
  })

  it('forwards a variable the server reads under its own name, and keeps literal values', () => {
    const { entry } = teamEntryFor(
      'acme-flags',
      { command: 'npx', args: ['-y', '@acme/flags-mcp@1.2.3'], env: { FLAGS_TOKEN: '${FLAGS_TOKEN}', MODE: 'ci' } },
      'codex',
    )
    expect(entry).toEqual({
      command: 'npx',
      args: ['-y', '@acme/flags-mcp@1.2.3'],
      env: { MODE: 'ci' },
      env_vars: ['FLAGS_TOKEN'],
    })
  })

  it('leaves a reference it cannot express as written, for doctor to name', () => {
    const { entry } = teamEntryFor('x', { command: 'srv', env: { API_KEY: '${OTHER_NAME}' } }, 'codex')
    expect(entry).toEqual({ command: 'srv', env: { API_KEY: '${OTHER_NAME}' } })
  })
})

describe.skipIf(!built)('Codex CLI as a target', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-codex-target-'))
    execFileSync('git', ['init', '-q'], { cwd: project })
    // A project that uses Supabase, so the stack carries a remote server, and
    // a Codex setup of the user's own that every write must leave alone.
    write(project, {
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@supabase/supabase-js': '^2.0.0' } }),
      '.codex/config.toml': USERS_CONFIG,
    })
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('installs skills and servers where Codex reads them, after the user’s own settings', () => {
    run(project, 'init', '--yes')
    expect(existsSync(join(project, '.agents/skills/testing-workflow/SKILL.md'))).toBe(true)
    expect(existsSync(join(project, '.codex/skills'))).toBe(false)
    expect(existsSync(join(project, '.codex/mcp.json'))).toBe(false)
    const text = readFileSync(join(project, '.codex/config.toml'), 'utf8')
    expect(text.startsWith(USERS_CONFIG)).toBe(true)
    expect(servers(project).Supabase).toEqual({ url: 'https://mcp.supabase.com/mcp' })
    expect(servers(project).mine).toEqual({ command: 'my-own-server' })
    run(project, 'sync', '--check')
  })

  it('the sync that upgrades a 1.0.0 install moves skills and servers, and keeps what is the user’s', () => {
    run(project, 'init', '--yes')
    // Back to how 1.0.0 left it: skills under `.codex/skills/`, servers in a
    // `.codex/mcp.json` it created, and a manifest that recorded both.
    rmSync(join(project, '.agents'), { recursive: true, force: true })
    write(project, {
      '.codex/config.toml': USERS_CONFIG,
      '.codex/skills/testing-workflow/SKILL.md': '---\nname: testing-workflow\ndescription: old\n---\nold\n',
      '.codex/mcp.json': JSON.stringify({ mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } }, null, 2) + '\n',
    })
    const path = join(project, '.opencastle/manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    manifest.version = '1.0.0'
    manifest.createdConfigs = ['.codex/mcp.json']
    manifest.managedPaths = {
      framework: ['.codex/agents/', '.codex/skills/', '.codex/prompts/', '.codex/workflows/'],
      customizable: ['.opencastle/', '.codex/mcp.json'],
      merged: ['AGENTS.md'],
    }
    writeFileSync(path, JSON.stringify(manifest, null, 2))

    const out = run(project, 'sync', '--yes')
    expect(out).toContain('Removed .codex/mcp.json')
    expect(existsSync(join(project, '.codex/skills'))).toBe(false)
    expect(existsSync(join(project, '.codex/mcp.json'))).toBe(false)
    expect(readFileSync(join(project, '.agents/skills/testing-workflow/SKILL.md'), 'utf8')).not.toContain('description: old')
    expect(readFileSync(join(project, '.codex/config.toml'), 'utf8').startsWith(USERS_CONFIG)).toBe(true)
    expect(servers(project).Supabase).toBeDefined()

    const after = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    expect(after.createdConfigs ?? []).not.toContain('.codex/mcp.json')
    expect(after.managedPaths?.framework).toContain('.agents/skills/')
    expect(after.managedPaths?.framework).not.toContain('.codex/skills/')
    run(project, 'sync', '--check')
  })

  it('keeps servers a person added to the old .codex/mcp.json, and says where they belong', () => {
    run(project, 'init', '--yes')
    write(project, {
      '.codex/mcp.json': JSON.stringify({ mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' }, theirs: { command: 'x' } } }),
    })
    const out = run(project, 'sync', '--yes', '--force')
    expect(out).toContain("Took OpenCastle's servers out of .codex/mcp.json")
    expect(out).toContain('.codex/config.toml')
    const left = JSON.parse(readFileSync(join(project, '.codex/mcp.json'), 'utf8')) as { mcpServers: object }
    expect(Object.keys(left.mcpServers)).toEqual(['theirs'])
  })

  it('shares .agents/skills/ with Antigravity without either sweep removing the other’s files', () => {
    write(project, { 'GEMINI.md': '# Gemini\n' })
    run(project, 'init', '--yes')
    const manifest = JSON.parse(readFileSync(join(project, '.opencastle/manifest.json'), 'utf8')) as Manifest
    expect(manifest.ides).toEqual(expect.arrayContaining(['codex', 'antigravity']))
    const skills = readdirSync(join(project, '.agents/skills')).sort()
    expect(skills).toContain('testing-workflow')
    run(project, 'sync', '--yes', '--force')
    expect(readdirSync(join(project, '.agents/skills')).sort()).toEqual(skills)
    run(project, 'sync', '--check')
  })

  it('remove --all takes our servers out of config.toml and leaves the user’s setup', () => {
    run(project, 'init', '--yes')
    run(project, 'remove', '--all', '--yes')
    expect(readFileSync(join(project, '.codex/config.toml'), 'utf8')).toBe(USERS_CONFIG)
    expect(existsSync(join(project, '.agents/skills'))).toBe(false)
  })
})
