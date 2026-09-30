/**
 * Team sources through the compiler: every target gets the team's content,
 * every target gets the team's MCP servers in its own dialect, and the check a
 * team runs in CI sees what `sync` would change.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IDE_ADAPTERS } from './adapters/index.js'
import { resolveSources, materialize, type CompileSource } from './layers.js'
import { rebuildMcpConfig, getMcpConfigRelPath, envRef, upgradeGeneratedServers } from './mcp.js'
import { buildCheckReport } from './sync-check.js'
import { writeManifest } from './manifest.js'
import { recordLockFor, type Lock } from './lock.js'
import { diffLocks, reviewMarkdown } from './review.js'
import { buildFleet } from './fleet.js'
import { planCi } from './ci.js'
import type { IdeChoice, StackConfig, Manifest } from './types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const ALL: IdeChoice[] = ['vscode', 'cursor', 'windsurf', 'claude-code', 'opencode', 'codex', 'antigravity']

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

const TEAM = {
  '.opencastle/skills/deploy-runbook/SKILL.md': '---\nname: deploy-runbook\ndescription: "How we deploy. Use when releasing."\n---\n\n# Deploy\n\nRELEASE-MARKER\n',
  '.opencastle/instructions/house-style.md': '# House style\n\nHOUSE-MARKER\n',
  '.opencastle/agents/release-captain.agent.md': '---\nname: Release captain\ndescription: "Cuts releases"\n---\n\nCAPTAIN-MARKER\n',
  '.opencastle/config.json': JSON.stringify({
    mcpServers: {
      'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], env: { DB_URL: '${DB_URL}' } },
      'acme-docs': { url: 'https://docs.acme.dev/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
    },
  }),
}

/** Every file under a directory, with its text. */
function textsUnder(root: string, skip = ['.opencastle', 'node_modules']): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(e.name)) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else out.push(readFileSync(abs, 'utf8'))
    }
  }
  walk(root)
  return out.join('\n')
}

describe('every target compiles the team content', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'team-targets-'))
    write(project, TEAM)
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  for (const ide of ALL) {
    it(`${ide}: the team's skill, instruction and agent reach the generated output`, async () => {
      const stack: StackConfig = { ides: [ide], techTools: [], teamTools: [] }
      const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack }), pkgRoot)
      try {
        const adapter = await IDE_ADAPTERS[ide]()
        await adapter.install(pkgRoot, project, stack, undefined, src)
      } finally {
        src.dispose()
      }
      const all = textsUnder(project)
      expect(all).toContain('RELEASE-MARKER')
      expect(all).toContain('HOUSE-MARKER')
      expect(all).toContain('CAPTAIN-MARKER')
    })
  }
})

describe("the team's MCP servers, in each target's dialect", () => {
  let project: string
  let src: CompileSource
  const stack: StackConfig = { ides: ALL, techTools: [], teamTools: [] }
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'team-mcp-'))
    write(project, TEAM)
    src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack }), pkgRoot)
  })
  afterEach(() => {
    src.dispose()
    rmSync(project, { recursive: true, force: true })
  })

  const read = (ide: IdeChoice): Record<string, Record<string, unknown>> => {
    const parsed = JSON.parse(readFileSync(join(project, getMcpConfigRelPath(ide)), 'utf8'))
    return parsed.mcp ?? parsed.servers ?? parsed.mcpServers
  }

  it('spells variables the way each assistant expands them', async () => {
    for (const ide of ['claude-code', 'cursor', 'opencode'] as IdeChoice[]) await rebuildMcpConfig(project, ide, stack, undefined, src.mcp)
    expect(read('claude-code')['acme-db']).toEqual({ command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], env: { DB_URL: '${DB_URL}' } })
    expect(read('claude-code')['acme-docs']).toEqual({ type: 'http', url: 'https://docs.acme.dev/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } })
    expect(read('cursor')['acme-db'].env).toEqual({ DB_URL: '${env:DB_URL}' })
    expect(read('cursor')['acme-docs'].headers).toEqual({ Authorization: 'Bearer ${env:DOCS_TOKEN}' })
    expect(read('opencode')['acme-db']).toEqual({ type: 'local', command: ['npx', '-y', '@acme/db-mcp@2.1.0'], environment: { DB_URL: '{env:DB_URL}' } })
    expect(read('opencode')['acme-docs']).toMatchObject({ type: 'remote', headers: { Authorization: 'Bearer {env:DOCS_TOKEN}' } })
  })

  it('gives VS Code an envFile for forwarded variables and a password input for a header', async () => {
    await rebuildMcpConfig(project, 'vscode', stack, undefined, src.mcp)
    const config = JSON.parse(readFileSync(join(project, '.vscode', 'mcp.json'), 'utf8'))
    expect(config.servers['acme-db']).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], envFile: '${workspaceFolder}/.env' })
    expect(config.servers['acme-docs'].headers).toEqual({ Authorization: 'Bearer ${input:DOCS_TOKEN}' })
    expect(config.inputs).toContainEqual({ id: 'DOCS_TOKEN', type: 'promptString', description: 'DOCS_TOKEN for the acme-docs MCP server', password: true })
  })

  it('rewrites an edited team server, keeps a hand-added one, and removes a retired one', async () => {
    const rel = getMcpConfigRelPath('claude-code')
    write(project, {
      [rel]: JSON.stringify({
        mcpServers: {
          'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@1.0.0'] },
          'acme-old': { url: 'https://old.acme.dev/mcp' },
          mine: { command: 'node', args: ['tools/mcp.js'] },
        },
      }),
    })
    const retiring = materialize(resolveSources({ pkgRoot, projectRoot: project, stack }), pkgRoot, ['acme-old'])
    try {
      const outcome = await rebuildMcpConfig(project, 'claude-code', stack, undefined, retiring.mcp)
      expect(outcome.teamWritten.sort()).toEqual(['acme-db', 'acme-docs'])
      expect(outcome.teamRemoved).toEqual(['acme-old'])
    } finally {
      retiring.dispose()
    }
    const servers = read('claude-code')
    expect(Object.keys(servers).sort()).toEqual(['acme-db', 'acme-docs', 'mine'])
    expect(servers['acme-db'].args).toEqual(['-y', '@acme/db-mcp@2.1.0'])
  })
})

describe('integration servers get per-target variables too', () => {
  it('writes ${env:NAME} for Cursor and {env:NAME} for OpenCode', () => {
    expect(envRef('cursor', 'X')).toBe('${env:X}')
    expect(envRef('windsurf', 'X')).toBe('${env:X}')
    expect(envRef('opencode', 'X')).toBe('{env:X}')
    expect(envRef('claude-code', 'X')).toBe('${X}')
  })

  it('moves an entry an earlier release wrote with ${NAME} for Cursor to the spelling Cursor expands', () => {
    const servers: Record<string, unknown> = {
      Sentry: { command: 'npx', args: ['@sentry/mcp-server@0.42.0'], env: { SENTRY_ACCESS_TOKEN: '${SENTRY_ACCESS_TOKEN}' } },
    }
    expect(upgradeGeneratedServers(servers, 'cursor', new Set(['Sentry']))).toEqual(['Sentry'])
    expect((servers.Sentry as { env: Record<string, string> }).env).toEqual({ SENTRY_ACCESS_TOKEN: '${env:SENTRY_ACCESS_TOKEN}' })
  })
})

describe('sync --check sees what the team sources say', () => {
  let project: string
  const manifest: Manifest = {
    version: '9.9.9',
    ide: 'claude-code',
    ides: ['claude-code'],
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stack: { ides: ['claude-code'], techTools: [], teamTools: [] },
  }
  async function compile(): Promise<void> {
    const src = materialize(resolveSources({ pkgRoot, projectRoot: project, stack: manifest.stack! }), pkgRoot)
    try {
      const adapter = await IDE_ADAPTERS['claude-code']()
      await adapter.install(pkgRoot, project, manifest.stack, undefined, src)
      await rebuildMcpConfig(project, 'claude-code', manifest.stack!, undefined, src.mcp)
    } finally {
      src.dispose()
    }
    await writeManifest(project, manifest)
    await recordLockFor(pkgRoot, project, manifest)
  }
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'team-check-'))
    write(project, TEAM)
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('is clean right after a compile', async () => {
    await compile()
    expect((await buildCheckReport(pkgRoot, project)).drift).toEqual([])
  })

  it('reports a changed team skill as drift in the output and in the lock', async () => {
    await compile()
    write(project, { '.opencastle/skills/deploy-runbook/SKILL.md': TEAM['.opencastle/skills/deploy-runbook/SKILL.md'] + '\nMore.\n' })
    const drift = (await buildCheckReport(pkgRoot, project)).drift
    expect(drift.some((d) => d.path === '.opencastle/lock.json' && d.kind === 'changed')).toBe(true)
    expect(drift.some((d) => d.path.includes('deploy-runbook') && d.kind === 'changed')).toBe(true)
  })

  it('reports a missing lock', async () => {
    await compile()
    rmSync(join(project, '.opencastle', 'lock.json'))
    expect((await buildCheckReport(pkgRoot, project)).drift).toEqual([
      expect.objectContaining({ path: '.opencastle/lock.json', kind: 'missing' }),
    ])
  })

  it('reports a team problem once, as the team problem, instead of comparing', async () => {
    await compile()
    write(project, { '.opencastle/config.json': '{ "extends": ["@acme/not-installed"] }' })
    const report = await buildCheckReport(pkgRoot, project)
    expect(report.checked).toBe(0)
    expect(report.drift).toEqual([expect.objectContaining({ origin: 'team', kind: 'unreducible', path: '.opencastle/config.json' })])
  })

  it('fails on a server the policy refuses, even one added by hand', async () => {
    write(project, {
      '.opencastle/config.json': JSON.stringify({
        policy: { mcp: { allow: ['acme-*'] } },
        mcpServers: { 'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'] } },
      }),
    })
    await compile()
    const rel = getMcpConfigRelPath('claude-code')
    const config = JSON.parse(readFileSync(join(project, rel), 'utf8'))
    config.mcpServers.rogue = { command: 'npx', args: ['-y', 'rogue-mcp@1.0.0'] }
    writeFileSync(join(project, rel), JSON.stringify(config))
    const drift = (await buildCheckReport(pkgRoot, project)).drift
    expect(drift).toEqual([
      expect.objectContaining({ kind: 'unreducible', origin: 'mcp', detail: expect.stringContaining('rogue: not on the MCP allowlist of project') }),
    ])
  })

  it('sees an edited team server as something sync rewrites', async () => {
    await compile()
    const rel = getMcpConfigRelPath('claude-code')
    const config = JSON.parse(readFileSync(join(project, rel), 'utf8'))
    config.mcpServers['acme-db'].args = ['-y', '@acme/db-mcp@1.0.0']
    writeFileSync(join(project, rel), JSON.stringify(config))
    const drift = (await buildCheckReport(pkgRoot, project)).drift
    expect(drift).toEqual([expect.objectContaining({ kind: 'outdated', detail: expect.stringContaining('so sync writes: acme-db') })])
  })
})

describe('review: a change in sentences', () => {
  const lock = (over: Partial<Lock> = {}): Lock => ({
    lockfileVersion: 1,
    opencastle: '0.36.0',
    targets: ['claude-code'],
    integrations: [],
    layers: [
      { id: 'opencastle', kind: 'core', version: '0.36.0' },
      { id: '@acme/base', kind: 'baseline', version: '1.4.0', integrity: 'sha256-a' },
    ],
    content: { 'skills/deploy': { from: 'project', sha: 'aaa' } },
    mcp: { Sentry: { from: 'plugin:sentry', transport: 'stdio', launch: 'npx @sentry/mcp-server@0.42.0' } },
    policy: { allow: { '@acme/base': ['Sentry'] } },
    context: { tokens: 5000, instructions: 2000, index: 3000 },
    ...over,
  })

  it('says nothing when nothing an assistant gets has changed', () => {
    expect(diffLocks(lock(), lock())).toEqual([])
  })

  it('marks a new server, a wider allowlist, a new instruction and a big context jump for review', () => {
    const head = lock({
      layers: [
        { id: 'opencastle', kind: 'core', version: '0.36.0' },
        { id: '@acme/base', kind: 'baseline', version: '1.5.0', integrity: 'sha256-b' },
      ],
      content: {
        'skills/deploy': { from: 'project', sha: 'aaa' },
        'instructions/api-style': { from: '@acme/base', sha: 'ccc', tokens: 900 },
      },
      mcp: {
        Sentry: { from: 'plugin:sentry', transport: 'stdio', launch: 'npx @sentry/mcp-server@0.43.0' },
        'acme-docs': { from: '@acme/base', transport: 'http', launch: 'https://docs.acme.dev/mcp', env: ['DOCS_TOKEN'] },
      },
      policy: { allow: { '@acme/base': ['Sentry', 'acme-docs'] } },
      context: { tokens: 5900, instructions: 2900, index: 3000 },
    })
    const lines = diffLocks(lock(), head)
    const flagged = lines.filter((l) => l.level === 'review').map((l) => l.text)
    const plain = lines.filter((l) => l.level === 'info').map((l) => l.text)
    expect(plain).toContain('@acme/base 1.4.0 → 1.5.0')
    expect(plain).toContain('MCP server **Sentry**: 0.42.0 → 0.43.0')
    expect(flagged).toContain('New MCP server **acme-docs** from @acme/base — remote, docs.acme.dev; reads DOCS_TOKEN')
    expect(flagged).toContain('The MCP allowlist now also allows acme-docs')
    expect(flagged.some((t) => t.startsWith('New always-loaded instruction **api-style**'))).toBe(true)
    expect(flagged.some((t) => t.includes('+18%'))).toBe(true)
    expect(reviewMarkdown({ base: 'origin/main', firstLock: false, lines })).toContain('**4 change(s) marked ⚠️ deserve a careful look.**')
  })

  it('flags a baseline whose contents changed under the same version', () => {
    const head = lock({ layers: [{ id: 'opencastle', kind: 'core', version: '0.36.0' }, { id: '@acme/base', kind: 'baseline', version: '1.4.0', integrity: 'sha256-z' }] })
    expect(diffLocks(lock(), head)).toEqual([expect.objectContaining({ level: 'review', text: expect.stringContaining('changed without a version change') })])
  })

  it('names who excluded a removed item, and flags loosened policy', () => {
    const head = lock({ content: {}, excluded: { 'skills/deploy': 'project' }, policy: {} })
    const texts = diffLocks(lock(), head).map((l) => `${l.level}:${l.text}`)
    expect(texts).toContain('info:skill **deploy** removed — excluded by this project (was from this project)')
    expect(texts).toContain('review:The MCP allowlist was removed — any server may now be written')
  })
})

describe('fleet: many repositories from their locks', () => {
  it('counts versions and finds servers that run differently', () => {
    const base = (v: string, sentry: string): Lock => ({
      lockfileVersion: 1,
      opencastle: '0.36.0',
      targets: ['cursor'],
      integrations: [],
      layers: [{ id: 'opencastle', kind: 'core', version: '0.36.0' }, { id: '@acme/base', kind: 'baseline', version: v }],
      content: {},
      mcp: { Sentry: { from: 'plugin:sentry', transport: 'stdio', launch: `npx @sentry/mcp-server@${sentry}` } },
      context: { tokens: 1, instructions: 0, index: 1 },
    })
    const report = buildFleet([
      { repo: 'shop', path: '/x', lock: base('1.5.0', '0.43.0') },
      { repo: 'api', path: '/y', lock: base('1.4.0', '0.42.0') },
      { repo: 'old', path: '/z', lock: null },
    ])
    expect(report.versions['@acme/base']).toEqual({ '1.5.0': ['shop'], '1.4.0': ['api'] })
    expect(Object.keys(report.spread.Sentry)).toHaveLength(2)
    expect(report.withoutLock).toEqual(['old'])
  })
})

describe('ci: the workflow a team commits', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'team-ci-plan-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it("runs the project's own OpenCastle when it has one, and installs first so baselines resolve", () => {
    write(project, { 'package.json': JSON.stringify({ devDependencies: { opencastle: '^0.36.0' } }), 'package-lock.json': '{}' })
    const plan = planCi(project, '0.36.0', '@acme/platform')
    expect(plan.workflow).toContain('run: npm ci')
    expect(plan.workflow).toContain('run: npx --no opencastle sync --check')
    expect(plan.workflow).toContain('npx --no opencastle review --base origin/${{ github.base_ref }}')
    expect(plan.workflow.indexOf('npm ci')).toBeLessThan(plan.workflow.indexOf('sync --check'))
    expect(plan.codeowners?.block).toContain('/.opencastle/lock.json @acme/platform')
  })

  it('pins the version that compiled the project when it has none', () => {
    write(project, { 'package.json': '{}', 'pnpm-lock.yaml': '' })
    const plan = planCi(project, '0.36.0')
    expect(plan.workflow).toContain('pnpm install --frozen-lockfile')
    expect(plan.workflow).toContain('npx -y opencastle@0.36.0 sync --check')
    expect(plan.pinned).toBe(false)
  })
})

