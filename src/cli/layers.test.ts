/**
 * Team sources: `.opencastle/config.json`, the baselines it extends, and the
 * merged content every adapter compiles.
 *
 * These are the rules a platform team relies on when it hands a standard to
 * fifty repositories: later layers override earlier ones, a repository cannot
 * quietly drop or replace what the baseline requires, policy only tightens, and
 * a baseline is found exactly where the package manager put it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveSources, materialize, usesTeamSources, requiredEnvVars, hasErrors } from './layers.js'
import { parseTeamConfig, stripJsonc, TeamConfigSchema } from './team-config.js'
import { satisfies } from './version-range.js'
import { findInlineSecret } from './policy.js'
import { buildLock, serializeLock } from './lock.js'
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

/** A baseline installed where npm would put it. */
function baseline(project: string, name: string, version: string, files: Record<string, string>, pkg: Record<string, unknown> = {}): void {
  const dir = join(project, 'node_modules', ...name.split('/'))
  write(dir, {
    'package.json': JSON.stringify({ name, version, opencastle: { baseline: 'layer' }, ...pkg }),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`layer/${k}`, v])),
  })
}

const skill = (name: string, description = `${name} does a thing. Use when it matters.`): string =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`

describe('version ranges', () => {
  it('reads the ranges npm users write', () => {
    expect(satisfies('0.36.2', '^0.36.0')).toBe(true)
    expect(satisfies('0.37.0', '^0.36.0')).toBe(false)
    expect(satisfies('1.4.0', '^1.2.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfies('0.36.9', '~0.36.1')).toBe(true)
    expect(satisfies('0.37.0', '~0.36.1')).toBe(false)
    expect(satisfies('0.36.4', '0.36.x')).toBe(true)
    expect(satisfies('0.36.0', '>=0.35.0 <0.37.0')).toBe(true)
    expect(satisfies('0.36.0', '>= 0.37.0')).toBe(false)
    expect(satisfies('0.36.0', '0.35.0 || 0.36.0')).toBe(true)
    expect(satisfies('0.36.0', '*')).toBe(true)
  })

  it('keeps prereleases out of ranges that do not name them', () => {
    expect(satisfies('0.37.0-rc.1', '^0.36.0')).toBe(false)
    expect(satisfies('0.37.0-rc.2', '>=0.37.0-rc.1')).toBe(true)
  })

  it('says so when it cannot read a range, instead of guessing', () => {
    expect(satisfies('0.36.0', 'latest')).toBeNull()
  })
})

describe('the config file', () => {
  it('accepts comments and trailing commas, as an editor with $schema writes them', () => {
    const text = `{
      // the org standard
      "extends": ["@acme/base",], /* pinned in package.json */
      "exclude": ["skills/seo-patterns"],
    }`
    const { config, issues } = parseTeamConfig(text, 'x')
    expect(issues).toEqual([])
    expect(config).toEqual({ extends: ['@acme/base'], exclude: ['skills/seo-patterns'] })
  })

  it('leaves comment-like text inside strings alone', () => {
    expect(JSON.parse(stripJsonc('{"url": "https://a.dev/x//y", "s": "a, }"}'))).toEqual({ url: 'https://a.dev/x//y', s: 'a, }' })
  })

  it('names an unknown setting and suggests the one meant', () => {
    const { config, issues } = parseTeamConfig('{ "extend": ["@acme/base"] }', '.opencastle/config.json')
    expect(config).toBeNull()
    expect(issues[0].message).toContain('unknown setting "extend"')
    expect(issues[0].fix).toContain('"extends"')
  })

  it('rejects an exclude that names no kind', () => {
    const { issues } = parseTeamConfig('{ "exclude": ["seo-patterns"] }', 'x')
    expect(issues[0].message).toMatch(/must name a kind/)
  })

  it('matches the published JSON schema, key for key', () => {
    const schema = JSON.parse(readFileSync(join(pkgRoot, 'website', 'public', 'schema', 'config.json'), 'utf8'))
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(TeamConfigSchema.entries).sort())
    const policy = TeamConfigSchema.entries.policy.wrapped.entries
    expect(Object.keys(schema.properties.policy.properties).sort()).toEqual(Object.keys(policy).sort())
    expect(Object.keys(schema.properties.policy.properties.mcp.properties).sort()).toEqual(
      Object.keys(policy.mcp.wrapped.entries).sort(),
    )
    const server = TeamConfigSchema.entries.mcpServers.wrapped.value.entries
    expect(Object.keys(schema.properties.mcpServers.additionalProperties.properties).sort()).toEqual(Object.keys(server).sort())
  })
})

describe('credentials written into a server entry', () => {
  it('finds real token formats and secret-named values, and says where — never what', () => {
    expect(findInlineSecret({ env: { STRIPE_KEY: 'sk_live_abcdefghijklmnop1234' } })).toBe('env.STRIPE_KEY')
    expect(findInlineSecret({ headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' } })).toBe('headers.Authorization')
    expect(findInlineSecret({ env: { API_TOKEN: 'a8f3k2j9d0s7x6c5v4b3' } })).toBe('env.API_TOKEN')
    expect(findInlineSecret({ command: 'npx', args: ['-y', 'srv@1.0.0', '--api-key=a8f3k2j9d0s7x6c5v4b3'] })).toBe('args')
    expect(findInlineSecret({ url: 'https://x.dev/mcp?token=a8f3k2j9d0s7x6c5v4b3' })).toBe('url')
    expect(findInlineSecret({ command: ['npx', '-y', 'srv@1.0.0', '--token', 'glpat-abcdefghijklmnopqrst'] })).toBe('args')
  })

  it('leaves references, placeholders and ordinary values alone', () => {
    expect(findInlineSecret({ env: { API_TOKEN: '${API_TOKEN}' } })).toBeNull()
    expect(findInlineSecret({ env: { API_TOKEN: '${env:API_TOKEN}' } })).toBeNull()
    expect(findInlineSecret({ environment: { API_TOKEN: '{env:API_TOKEN}' } })).toBeNull()
    expect(findInlineSecret({ headers: { Authorization: 'Bearer ${input:token}' } })).toBeNull()
    expect(findInlineSecret({ env: { API_TOKEN: 'REPLACE_ME' } })).toBeNull()
    expect(findInlineSecret({ env: { LOG_LEVEL: 'debug', PORT: '3000' } })).toBeNull()
    expect(findInlineSecret({ env: { AUTH_URL: 'https://auth.example.com/oauth2/v1' } })).toBeNull()
    expect(findInlineSecret({ command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'] })).toBeNull()
  })
})

describe('resolving layers', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'layers-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  const resolveHere = (stack: StackConfig = noTools) => resolveSources({ pkgRoot, projectRoot: project, stack })

  it('is OpenCastle alone when the project has no team sources', () => {
    const r = resolveHere()
    expect(r.issues).toEqual([])
    expect(usesTeamSources(r)).toBe(false)
    expect([...r.items.values()].every((i) => i.layer === 'opencastle')).toBe(true)
  })

  it("adds the project's own content, and records what it replaces", () => {
    write(project, {
      '.opencastle/skills/deploy/SKILL.md': skill('deploy'),
      '.opencastle/skills/testing-workflow/SKILL.md': skill('testing-workflow', 'Our testing rules. Use when writing tests.'),
      '.opencastle/instructions/house-style.md': '# House style\n',
      '.opencastle/agents/release-captain.agent.md': '---\nname: Release captain\ndescription: "Cuts releases"\n---\n\n# RC\n',
      // Not an agent: the directory also holds OpenCastle's own registry.
      '.opencastle/agents/agent-registry.md': '# registry\n',
    })
    const r = resolveHere()
    expect(r.items.get('skills/deploy')?.layer).toBe('project')
    expect(r.items.get('skills/testing-workflow')).toMatchObject({ layer: 'project', overrides: 'opencastle' })
    expect(r.items.get('instructions/house-style')?.layer).toBe('project')
    expect(r.items.get('agents/release-captain')?.layer).toBe('project')
    expect(r.items.has('agents/agent-registry')).toBe(false)
    expect(usesTeamSources(r)).toBe(true)
  })

  it('finds a baseline where the package manager installed it, below the project', () => {
    baseline(project, '@acme/base', '1.4.0', {
      'skills/secure-coding/SKILL.md': skill('secure-coding'),
      'skills/deploy/SKILL.md': skill('deploy', 'The org default.'),
    })
    write(project, {
      '.opencastle/config.json': '{ "extends": ["@acme/base"] }',
      '.opencastle/skills/deploy/SKILL.md': skill('deploy', 'This repo overrides it.'),
    })
    const r = resolveHere()
    expect(r.issues).toEqual([])
    expect(r.layers.map((l) => l.id)).toEqual(['opencastle', '@acme/base', 'project'])
    expect(r.layers[1].version).toBe('1.4.0')
    expect(r.items.get('skills/secure-coding')?.layer).toBe('@acme/base')
    expect(r.items.get('skills/deploy')).toMatchObject({ layer: 'project', overrides: '@acme/base' })
  })

  it('refuses a baseline that is not installed, a versioned spec, an absolute path, or a package that is not a baseline', () => {
    write(project, { 'node_modules/plain/package.json': JSON.stringify({ name: 'plain', version: '1.0.0' }) })
    write(project, {
      '.opencastle/config.json': JSON.stringify({ extends: ['@acme/missing', '@acme/base@2.0.0', '/abs/path', 'plain'] }),
    })
    const r = resolveHere()
    const messages = r.issues.map((i) => i.message).join('\n')
    expect(messages).toContain('"@acme/missing", which is not installed')
    expect(messages).toContain('version belongs in package.json')
    expect(messages).toContain('an absolute path')
    expect(messages).toContain('"plain", which is not an OpenCastle baseline')
    expect(hasErrors(r)).toBe(true)
  })

  it('reads a baseline from a path, and loads a diamond once and a cycle not at all', () => {
    write(project, {
      'shared/a/config.json': '{ "extends": ["../c"] }',
      'shared/a/skills/a/SKILL.md': skill('a'),
      'shared/b/config.json': '{ "extends": ["../c"] }',
      'shared/c/skills/c/SKILL.md': skill('c'),
      '.opencastle/config.json': '{ "extends": ["../shared/a", "../shared/b"] }',
    })
    const r = resolveHere()
    expect(r.issues).toEqual([])
    expect(r.layers.map((l) => l.id)).toEqual(['opencastle', 'shared/c', 'shared/a', 'shared/b', 'project'])

    write(project, { 'shared/c/config.json': '{ "extends": ["../a"] }' })
    const cyclic = resolveHere()
    expect(cyclic.issues.some((i) => /cycle/.test(i.message))).toBe(true)
  })

  it('excludes from the layers below, and warns about an exclude that matches nothing', () => {
    write(project, { '.opencastle/config.json': '{ "exclude": ["skills/testing-workflow", "skills/no-such-skill"] }' })
    const r = resolveHere()
    expect(r.items.has('skills/testing-workflow')).toBe(false)
    expect(r.excluded).toEqual([{ ref: 'skills/testing-workflow', by: 'project', from: 'opencastle' }])
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('skills/no-such-skill') })])
  })

  it('does not call an exclude of something the stack already left out a mistake', () => {
    write(project, { '.opencastle/config.json': '{ "exclude": ["agents/content-engineer"] }' })
    expect(resolveHere().issues).toEqual([])
  })

  it('refuses to drop or replace what a baseline requires', () => {
    baseline(project, '@acme/base', '1.0.0', {
      'config.json': '{ "policy": { "require": ["skills/secure-coding", "instructions/security"] } }',
      'skills/secure-coding/SKILL.md': skill('secure-coding'),
      'instructions/security.md': '# Security\n',
    })
    write(project, {
      '.opencastle/config.json': '{ "extends": ["@acme/base"], "exclude": ["instructions/security"] }',
      '.opencastle/skills/secure-coding/SKILL.md': skill('secure-coding', 'A weaker local copy.'),
    })
    const errors = resolveHere().issues.filter((i) => i.level === 'error').map((i) => i.message)
    expect(errors).toContain('excludes instructions/security, which @acme/base requires')
    expect(errors).toContain('project replaces skills/secure-coding, which @acme/base requires as it ships it')
  })

  it('holds MCP servers to the policy: allowlist, hosts, pinning, and credentials', () => {
    baseline(project, '@acme/base', '1.0.0', {
      'config.json': JSON.stringify({
        policy: { mcp: { allow: ['acme-*', 'docs', 'Linear'], remoteHosts: ['*.acme.dev', 'mcp.linear.app'], requirePinned: true } },
      }),
    })
    write(project, {
      '.opencastle/config.json': JSON.stringify({
        extends: ['@acme/base'],
        policy: { mcp: { requirePinned: false } },
        mcpServers: {
          'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], env: { DB_URL: '${DB_URL}' } },
          'acme-loose': { command: 'npx', args: ['-y', '@acme/loose-mcp'] },
          docs: { url: 'https://docs.example.com/mcp' },
          rogue: { command: 'node', args: ['tools/mcp.js'] },
          'acme-leak': { url: 'https://x.acme.dev/mcp', headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' } },
        },
      }),
    })
    const r = resolveHere({ ides: ['claude-code'], techTools: [], teamTools: ['linear', 'slack'] })
    const errors = r.issues.filter((i) => i.level === 'error').map((i) => i.message)
    const warnings = r.issues.filter((i) => i.level === 'warning').map((i) => i.message)
    expect(errors.some((m) => m.includes('"acme-loose" runs @acme/loose-mcp without an exact version'))).toBe(true)
    expect(errors.some((m) => m.includes('"docs" connects to https://docs.example.com/mcp, a host @acme/base does not allow'))).toBe(true)
    expect(errors.some((m) => m.includes('"rogue", which @acme/base does not allow'))).toBe(true)
    expect(errors.some((m) => m.includes('"acme-leak" has a credential written into headers.Authorization'))).toBe(true)
    expect(errors.some((m) => m.includes('acme-db'))).toBe(false)
    expect(warnings.some((m) => m.includes('a layer can tighten policy, not relax it'))).toBe(true)
    // An integration the policy refuses is left out, not an error.
    expect(r.blocked.get('Slack')).toContain('allowlist')
    expect(r.blocked.has('Linear')).toBe(false)
  })

  it('leaves out an integration whose remote host the policy does not allow', () => {
    baseline(project, '@acme/base', '1.0.0', { 'config.json': JSON.stringify({ policy: { mcp: { remoteHosts: ['*.acme.dev'] } } }) })
    write(project, { '.opencastle/config.json': '{ "extends": ["@acme/base"] }' })
    const r = resolveHere({ ides: ['claude-code'], techTools: [], teamTools: ['linear'] })
    expect(r.blocked.get('Linear')).toBe('mcp.linear.app is not an allowed host for @acme/base')
  })

  it('narrows an allowlist from above, and says so when a layer tries to widen one', () => {
    baseline(project, '@acme/base', '1.0.0', { 'config.json': JSON.stringify({ policy: { mcp: { allow: ['Linear', 'Sentry'] } } }) })
    write(project, { '.opencastle/config.json': JSON.stringify({ extends: ['@acme/base'], policy: { mcp: { allow: ['Linear', 'rogue'] } } }) })
    const r = resolveHere({ ides: ['claude-code'], techTools: ['sentry'], teamTools: ['linear'] })
    expect(r.issues.map((i) => i.message)).toContain('allows MCP server "rogue", but @acme/base does not — the stricter list applies')
    // On both lists: kept. On the baseline's only: the project narrowed it out.
    expect(r.blocked.has('Linear')).toBe(false)
    expect(r.blocked.get('Sentry')).toContain('project')
  })

  it('refuses to compile with an OpenCastle the project did not ask for', () => {
    write(project, { '.opencastle/config.json': '{ "opencastle": "^99.0.0" }' })
    expect(resolveHere().issues[0].message).toMatch(/needs OpenCastle \^99\.0\.0; this is/)
  })

  it('lists the variables the written servers need: team servers in, refused integrations out', () => {
    write(project, {
      '.opencastle/config.json': JSON.stringify({
        policy: { mcp: { allow: ['acme-db', 'Linear'] } },
        mcpServers: { 'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], env: { DB_URL: '${DB_URL}' } } },
      }),
    })
    const stack: StackConfig = { ides: ['claude-code'], techTools: ['sentry'], teamTools: ['linear'] }
    const vars = requiredEnvVars(resolveHere(stack), stack).map((v) => v.envVar)
    expect(vars).toContain('DB_URL')
    expect(vars).not.toContain('SENTRY_ACCESS_TOKEN')
  })
})

describe('the merged source and the lock', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'layers-lock-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('normalises team files the way every target needs them', () => {
    write(project, {
      '.opencastle/instructions/security.md': '# Security\r\n\r\nNo secrets.\r\n',
      '.opencastle/agents/rc.agent.md': '# Release captain\n',
    })
    const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack: noTools }), pkgRoot)
    try {
      const instruction = readFileSync(join(src.root, 'instructions', 'security.instructions.md'), 'utf8')
      expect(instruction).toBe("---\napplyTo: '**'\n---\n\n# Security\n\nNo secrets.\n")
      expect(readFileSync(join(src.root, 'agents', 'rc.agent.md'), 'utf8')).toMatch(/^---\nname: 'rc'\n---/)
    } finally {
      src.dispose()
    }
    expect(existsSync(src.root)).toBe(false)
  })

  it('ships an integration skill as its SKILL.md alone', () => {
    const stack: StackConfig = { ides: ['claude-code'], techTools: ['sentry'], teamTools: [] }
    const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack }), pkgRoot)
    try {
      expect(readdirSync(join(src.root, 'skills', 'sentry'))).toEqual(['SKILL.md'])
    } finally {
      src.dispose()
    }
  })

  it('is deterministic and carries no machine-specific paths', () => {
    baseline(project, '@acme/base', '1.4.0', { 'skills/secure-coding/SKILL.md': skill('secure-coding') })
    write(project, {
      '.opencastle/config.json': JSON.stringify({
        extends: ['@acme/base'],
        exclude: ['skills/seo-patterns'],
        mcpServers: { 'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], env: { DB_URL: '${DB_URL}' } } },
      }),
    })
    const lockOnce = (): string => {
      const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack: noTools }), pkgRoot)
      try {
        return serializeLock(buildLock(src, { ides: ['cursor', 'claude-code'], stack: noTools }))
      } finally {
        src.dispose()
      }
    }
    const a = lockOnce()
    expect(lockOnce()).toBe(a)
    expect(a).not.toContain(project)
    expect(a).not.toContain(tmpdir())
    const lock = JSON.parse(a)
    expect(lock.targets).toEqual(['claude-code', 'cursor'])
    expect(lock.layers.map((l: { id: string }) => l.id)).toEqual(['opencastle', '@acme/base', 'project'])
    expect(lock.content['skills/secure-coding'].from).toBe('@acme/base')
    expect(lock.excluded).toEqual({ 'skills/seo-patterns': 'project' })
    expect(lock.mcp['acme-db']).toEqual({ from: 'project', transport: 'stdio', launch: 'npx -y @acme/db-mcp@2.1.0', env: ['DB_URL'] })
    expect(lock.context.tokens).toBeGreaterThan(0)
  })
})
