/**
 * Agent Plugins 1.0, as a conformant client reads one — and as a team's
 * baseline, compiled into every assistant.
 *
 * The spec's own examples are used where it gives them, so a reading that
 * drifts from the published text fails here first.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  checkSkill,
  claudeMcpFor,
  isAgentPlugin,
  mcpSchemaUrl,
  pluginNameFrom,
  pluginSchemaUrl,
  readAgentPlugin,
  serverProblem,
  teamServerFor,
} from './agent-plugin.js'
import { resolveSources, materialize, hasErrors } from './layers.js'
import type { StackConfig } from './types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const noTools: StackConfig = { ides: ['claude-code'], techTools: [], teamTools: [] }

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

const skill = (name: string, description = `${name} does a thing. Use when it matters.`): string =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`

const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ $schema: pluginSchemaUrl(), name: 'acme.standard', version: '1.2.0', ...extra })

const mcp = (servers: Record<string, unknown>): string => JSON.stringify({ $schema: mcpSchemaUrl(), mcpServers: servers })

describe('reading a plugin', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-ap-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('loads the spec’s layout: manifest, skills and servers', () => {
    write(dir, {
      'plugin.json': manifest(),
      'skills/summarize/SKILL.md': skill('summarize'),
      'skills/summarize/references/checklist.md': '- one\n',
      'skills/notes.txt': 'not a skill',
      'mcp.json': mcp({
        'local-validator': { type: 'stdio', command: './bin/validator', args: ['--data', '${PLUGIN_DATA}/validator'], env: { CONFIG: '${PLUGIN_ROOT}/config.json' }, cwd: '${PLUGIN_ROOT}' },
        'deployment-api': { type: 'streamable-http', url: 'https://deploy.example.com/mcp', headers: { 'X-Tenant': 'public-tenant' } },
        'legacy-events': { type: 'sse', url: 'https://legacy.example.com/sse' },
      }),
    })
    const r = readAgentPlugin(dir)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.version).toBe('1.0.0')
    expect(r.skills).toEqual(['summarize'])
    expect(Object.keys(r.servers)).toEqual(['local-validator', 'deployment-api', 'legacy-events'])
    expect(isAgentPlugin(dir)).toBe(true)
  })

  it('refuses a manifest a client must reject, and names the field', () => {
    for (const [bad, said] of [
      [{ name: 'My-Plugin' }, '"name" must be'],
      [{ name: 'has--double' }, '"name" must be'],
      [{ version: 2 }, '"version" must be a string'],
      [{ author: { name: 'A', team: 'B' } }, '"author" may hold only'],
      [{ keywords: 'x' }, '"keywords" must be a list'],
    ] as const) {
      write(dir, { 'plugin.json': manifest(bad) })
      const r = readAgentPlugin(dir)
      expect(r.manifest).toBeUndefined()
      expect(r.errors.join('\n')).toContain(said)
    }
    write(dir, { 'plugin.json': JSON.stringify({ $schema: 'https://example.com/x.json', name: 'a' }) })
    expect(readAgentPlugin(dir).errors[0]).toContain('"$schema" must be')
    expect(isAgentPlugin(dir)).toBe(false)
  })

  it('reports and ignores an unknown field, as a client must', () => {
    write(dir, { 'plugin.json': manifest({ logo: 'x.png', commands: [] }) })
    const r = readAgentPlugin(dir)
    expect(r.errors).toEqual([])
    expect(r.manifest?.name).toBe('acme.standard')
    expect(r.warnings.join('\n')).toMatch(/"logo" is not an Agent Plugins field[\s\S]*"commands"/)
  })

  it('accepts the 1.1.0 draft, which changes only the number', () => {
    write(dir, {
      'plugin.json': JSON.stringify({ $schema: pluginSchemaUrl('1.1.0'), name: 'a' }),
      'mcp.json': JSON.stringify({ $schema: mcpSchemaUrl('1.0.0'), mcpServers: {} }),
    })
    const r = readAgentPlugin(dir)
    expect(r.version).toBe('1.1.0')
    expect(r.errors).toEqual(['mcp.json: targets Agent Plugins 1.0.0 while plugin.json targets 1.1.0, so no server loads'])
  })

  it('skips one bad server and keeps the rest', () => {
    write(dir, {
      'plugin.json': manifest(),
      'mcp.json': mcp({ bad: { type: 'stdio', command: 'npx -y thing' }, good: { type: 'stdio', command: 'npx', args: ['-y', 'thing@1.0.0'] } }),
    })
    const r = readAgentPlugin(dir)
    expect(Object.keys(r.servers)).toEqual(['good'])
    expect(r.errors[0]).toContain('command must be one executable')
  })
})

describe('a server entry', () => {
  it.each([
    [{ type: 'stdio', command: '../bin/server' }, 'must start with ./'],
    [{ type: 'stdio', command: 'node', cwd: 'data' }, 'cwd must start with'],
    [{ type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/x' } }, 'cannot set PLUGIN_ROOT'],
    [{ type: 'stdio', command: '${PLUGIN_ROOT}/bin/x' }, 'command is not expanded'],
    [{ type: 'streamable-http', url: 'http://api.example.com/mcp' }, 'needs https'],
    [{ type: 'streamable-http', url: 'https://user:pw@api.example.com/mcp' }, 'user or password'],
    [{ type: 'streamable-http', url: 'https://api.example.com/mcp#x' }, 'fragment'],
    [{ type: 'streamable-http', url: 'https://a.example.com', headers: { 'X-A': '1', 'x-a': '2' } }, 'given twice'],
    [{ type: 'streamable-http', url: 'https://a.example.com', command: 'x' }, 'cannot have'],
    [{ type: 'websocket', url: 'wss://a' }, 'type must be'],
  ])('refuses %j', (raw, said) => {
    expect(serverProblem('s', raw)).toContain(said)
  })

  it('lets a loopback server use plain http', () => {
    expect(serverProblem('s', { type: 'streamable-http', url: 'http://127.0.0.1:3845/mcp' })).toBeNull()
    expect(serverProblem('s', { type: 'streamable-http', url: 'http://localhost:3845/mcp' })).toBeNull()
  })
})

describe('a skill, against the Agent Skills spec', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-skill-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('must be named as its directory', () => {
    write(dir, { 'deploy/SKILL.md': skill('deploy-runbook') })
    expect(checkSkill(join(dir, 'deploy')).errors[0]).toContain('must match its directory, deploy/')
  })

  it('needs a description of at most 1024 characters', () => {
    write(dir, { 'a/SKILL.md': skill('a', 'x'.repeat(1025)), 'b/SKILL.md': '---\nname: b\n---\n' })
    expect(checkSkill(join(dir, 'a')).errors[0]).toContain('1025 characters')
    expect(checkSkill(join(dir, 'b')).errors[0]).toContain('has no description')
  })

  it('names fields the spec does not define, and lets assistant ones pass', () => {
    write(dir, { 'a/SKILL.md': '---\nname: a\ndescription: "Does a. Use when a."\nuser-invocable: true\napplyTo: "**"\n---\n' })
    const r = checkSkill(join(dir, 'a'))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual(['skills/a/SKILL.md: applyTo is not an Agent Skills field; other assistants ignore it'])
  })
})

describe('Claude Code’s copies', () => {
  it('resolves ./ and the plugin variables in Claude Code’s spelling', () => {
    expect(
      claudeMcpFor({
        local: { type: 'stdio', command: './bin/server', args: ['${PLUGIN_ROOT}/a', '${PLUGIN_DATA}/b'] },
        remote: { type: 'streamable-http', url: 'https://x.example.com/mcp' },
        old: { type: 'sse', url: 'https://y.example.com/sse' },
      }),
    ).toEqual({
      mcpServers: {
        local: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: ['${CLAUDE_PLUGIN_ROOT}/a', '${CLAUDE_PLUGIN_DATA}/b'] },
        remote: { type: 'http', url: 'https://x.example.com/mcp' },
        old: { type: 'sse', url: 'https://y.example.com/sse' },
      },
    })
  })
})

describe('naming', () => {
  it('makes a plugin name from a package name', () => {
    expect(pluginNameFrom('@acme/ai-standard')).toBe('acme.ai-standard')
    expect(pluginNameFrom('My Plugin!')).toBe('my-plugin')
  })
})

describe('a plugin as a team’s baseline', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-ap-layer-'))
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  const plugin = (root: string, files: Record<string, string> = {}): void =>
    write(join(project, root), {
      'plugin.json': manifest(),
      'skills/secure-coding/SKILL.md': skill('secure-coding'),
      'mcp.json': mcp({
        docs: { type: 'streamable-http', url: 'https://docs.acme.example/mcp' },
        lint: { type: 'stdio', command: './bin/lint', args: ['--config', '${PLUGIN_ROOT}/lint.json'] },
        cache: { type: 'stdio', command: 'node', args: ['${PLUGIN_DATA}/x.js'] },
      }),
      'dev.opencastle/instructions/standards.md': '# Standards\n\nBe kind.\n',
      'dev.opencastle/config.json': JSON.stringify({ policy: { contextBudget: 9000 } }),
      ...files,
    })

  it('compiles its skills, its portable servers and its OpenCastle layer', () => {
    plugin('standard')
    write(project, { '.opencastle/config.json': JSON.stringify({ extends: ['../standard'] }) })
    const r = resolveSources({ pkgRoot, projectRoot: project, stack: noTools })
    expect(hasErrors(r)).toBe(false)
    expect(r.items.get('skills/secure-coding')?.layer).toBe('standard')
    expect(r.items.get('instructions/standards')?.layer).toBe('standard')
    expect(r.policy.contextBudget).toEqual({ tokens: 9000, by: 'standard' })
    expect(r.servers.get('docs')).toMatchObject({ server: { type: 'http', url: 'https://docs.acme.example/mcp' }, where: 'standard/mcp.json' })
    expect(r.servers.get('lint')?.server).toEqual({ type: 'stdio', command: './standard/bin/lint', args: ['--config', './standard/lint.json'] })
    expect(r.servers.has('cache')).toBe(false)
    expect(r.issues.map((i) => i.message).join('\n')).toContain('MCP server "cache" uses ${PLUGIN_DATA}')
    const src = materialize(r, pkgRoot)
    try {
      expect(readFileSync(join(src.root, 'skills', 'secure-coding', 'SKILL.md'), 'utf8')).toContain('secure-coding')
    } finally {
      src.dispose()
    }
  })

  it('moves its integrity when anything it contributes changes, not only its skills', () => {
    plugin('standard')
    write(project, { '.opencastle/config.json': JSON.stringify({ extends: ['../standard'] }) })
    const integrity = (): string | undefined =>
      resolveSources({ pkgRoot, projectRoot: project, stack: noTools }).layers.find((l) => l.id === 'standard')?.integrity
    const before = integrity()
    expect(before).toMatch(/^sha256-/)
    write(join(project, 'standard'), { 'dev.opencastle/instructions/standards.md': '# Standards\n\nBe brief.\n' })
    const afterInstruction = integrity()
    expect(afterInstruction).not.toBe(before)
    write(join(project, 'standard'), { 'mcp.json': mcp({ docs: { type: 'streamable-http', url: 'https://docs.acme.example/v2/mcp' } }) })
    expect(integrity()).not.toBe(afterInstruction)
  })

  it('extends one published to npm as it is, with no OpenCastle declaration', () => {
    plugin('node_modules/@acme/standard', { 'package.json': JSON.stringify({ name: '@acme/standard', version: '1.2.0' }) })
    write(project, { '.opencastle/config.json': JSON.stringify({ extends: ['@acme/standard'] }) })
    const r = resolveSources({ pkgRoot, projectRoot: project, stack: noTools })
    expect(hasErrors(r)).toBe(false)
    expect(r.layers.find((l) => l.id === '@acme/standard')?.version).toBe('1.2.0')
    expect(r.servers.get('lint')?.server).toMatchObject({ command: './node_modules/@acme/standard/bin/lint' })
  })

  it('refuses a server defined in both mcp.json and config.json', () => {
    plugin('standard', {
      'dev.opencastle/config.json': JSON.stringify({ mcpServers: { docs: { url: 'https://docs.acme.example/mcp' } } }),
    })
    write(project, { '.opencastle/config.json': JSON.stringify({ extends: ['../standard'] }) })
    const r = resolveSources({ pkgRoot, projectRoot: project, stack: noTools })
    expect(r.issues.find((i) => i.level === 'error')?.message).toBe('defines MCP server "docs", which standard/dev.opencastle/config.json defines too')
  })

  it('refuses one a conformant client would reject', () => {
    write(join(project, 'broken'), { 'plugin.json': JSON.stringify({ $schema: pluginSchemaUrl(), name: 'Bad Name' }) })
    write(project, { '.opencastle/config.json': JSON.stringify({ extends: ['../broken'] }) })
    const r = resolveSources({ pkgRoot, projectRoot: project, stack: noTools })
    expect(hasErrors(r)).toBe(true)
    expect(r.issues[0].message).toContain('which is not a valid Agent Plugin: plugin.json: "name" must be')
  })

  it('compiles a portable server the way a team server is compiled', () => {
    expect(teamServerFor({ type: 'stdio', command: 'npx', args: ['-y', 'x@1.0.0'] }, 'node_modules/x')).toEqual({
      server: { type: 'stdio', command: 'npx', args: ['-y', 'x@1.0.0'] },
    })
    expect(teamServerFor({ type: 'sse', url: 'https://a.example.com/sse' }, 'x').skipped).toContain('legacy SSE')
    expect(teamServerFor({ type: 'stdio', command: 'node', cwd: './data' }, 'x').skipped).toContain('runs in ./data')
  })
})
