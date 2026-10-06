/**
 * The team commands, driven through the CLI the way a platform team, a new
 * teammate and a CI job drive them — against a baseline installed where npm
 * would install it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')
const built = existsSync(join(repoRoot, 'dist', 'cli', 'review.js'))

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  const base = { ...process.env }
  for (const k of Object.keys(base)) if (k.startsWith('GITHUB_')) delete base[k]
  try {
    const out = execFileSync('node', [cli, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...base, ...env } })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' })
}

const BASELINE = 'node_modules/@acme/base'

function installBaseline(dir: string, version: string, extra: Record<string, string> = {}): void {
  write(dir, {
    [`${BASELINE}/package.json`]: JSON.stringify({ name: '@acme/base', version, opencastle: { baseline: 'layer' } }),
    [`${BASELINE}/layer/config.json`]: JSON.stringify({
      policy: { mcp: { allow: ['chrome-devtools', 'next-devtools', 'acme-*'], requirePinned: true }, require: ['skills/secure-coding'] },
    }),
    [`${BASELINE}/layer/skills/secure-coding/SKILL.md`]:
      '---\nname: secure-coding\ndescription: "Our secure coding rules. Use when touching auth or user input."\n---\n\n# Secure coding\n',
    ...extra,
  })
}

describe.skipIf(!built)('a repository extending a baseline', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-cmd-'))
    git(dir, 'init', '-q')
    write(dir, {
      'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'vitest' }, devDependencies: { next: '15.0.0', '@acme/base': '1.4.0' } }),
      '.opencastle/config.json': JSON.stringify({
        extends: ['@acme/base'],
        mcpServers: { 'acme-db': { command: 'npx', args: ['-y', '@acme/db-mcp@2.1.0'], env: { DB_URL: '${DB_URL}' } } },
      }),
    })
    installBaseline(dir, '1.4.0')
    expect(run(dir, ['init', '--yes']).code).toBe(0)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("compiles the baseline and the project's own server, writes the lock, and checks clean", () => {
    expect(existsSync(join(dir, '.github', 'skills', 'secure-coding', 'SKILL.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf8')).servers['acme-db']).toBeDefined()
    const lock = JSON.parse(readFileSync(join(dir, '.opencastle', 'lock.json'), 'utf8'))
    expect(lock.layers.map((l: { id: string }) => l.id)).toEqual(['opencastle', '@acme/base', 'project'])
    expect(run(dir, ['sync', '--check']).code).toBe(0)
    const doctor = run(dir, ['doctor'])
    expect(doctor.out).toContain('extends @acme/base@1.4.0')
    expect(doctor.out).toContain('Always-loaded context')
  })

  it('refuses to sync with a baseline missing, and says what to install', () => {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    const sync = run(dir, ['sync', '--yes'])
    expect(sync.code).toBe(1)
    expect(sync.out).toContain('extends "@acme/base", which is not installed')
    expect(sync.out).toContain('nothing was compiled')
    expect(run(dir, ['sync', '--check']).code).toBe(1)
  })

  it('reviews a baseline upgrade in sentences, and writes it to the job summary', () => {
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    installBaseline(dir, '1.5.0', {
      [`${BASELINE}/layer/config.json`]: JSON.stringify({
        policy: { mcp: { allow: ['chrome-devtools', 'next-devtools', 'acme-*'], requirePinned: true }, require: ['skills/secure-coding'] },
        mcpServers: { 'acme-docs': { url: 'https://docs.acme.dev/mcp' } },
      }),
    })
    const summary = join(dir, 'summary.md')
    const review = run(dir, ['review', '--base', 'HEAD'], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary })
    expect(review.code).toBe(0)
    expect(review.out).toContain('@acme/base 1.4.0 → 1.5.0')
    expect(review.out).toContain('New MCP server')
    expect(readFileSync(summary, 'utf8')).toContain('### OpenCastle — what this change does to the AI assistants')
    // The lock has not been synced yet, and review says so.
    expect(review.out).toContain('is not what the sources compile to')
  })

  it('explains what a new teammate needs to set up', () => {
    const explain = run(dir, ['explain'])
    expect(explain.code).toBe(0)
    expect(explain.out).toContain('secure-coding')
    expect(explain.out).toContain('DB_URL')
    const json = JSON.parse(run(dir, ['explain', '--json']).out)
    expect(json.setup).toContainEqual(expect.objectContaining({ server: 'acme-db', need: 'DB_URL', ok: false }))
  })

  it('does not rewrite the manifest when a sync changes only generated content', () => {
    const before = readFileSync(join(dir, '.opencastle', 'manifest.json'), 'utf8')
    write(dir, { '.opencastle/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: "How we deploy. Use when releasing."\n---\n\n# Deploy\n' })
    const sync = run(dir, ['sync', '--yes'])
    expect(sync.code).toBe(0)
    expect(existsSync(join(dir, '.github', 'skills', 'deploy', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(dir, '.opencastle', 'manifest.json'), 'utf8')).toBe(before)
  })

  it('refuses to downgrade a project compiled by a newer OpenCastle — --force included', () => {
    const path = join(dir, '.opencastle', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.version = '99.0.0'
    writeFileSync(path, JSON.stringify(manifest))
    for (const args of [['sync', '--yes'], ['sync', '--force', '--yes']]) {
      const sync = run(dir, args)
      expect(sync.code).toBe(1)
      expect(sync.out).toContain('compiled by OpenCastle 99.0.0')
    }
    const doctor = run(dir, ['doctor'])
    expect(doctor.code).toBe(1)
    expect(doctor.out).toContain('older than the 99.0.0')
    // The check says why it compared nothing, instead of prescribing the sync that refuses.
    const check = run(dir, ['sync', '--check'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('older than the one that compiled the project')
    expect(check.out).not.toContain('Fix: opencastle sync')
    const down = run(dir, ['sync', '--allow-downgrade', '--yes'])
    expect(down.code).toBe(0)
    expect(down.out).toContain('Downgrading this project from OpenCastle 99.0.0')
  })

  it('refuses a baseline older than the one the lock records — a node_modules from before the bump', () => {
    installBaseline(dir, '1.3.0')
    const sync = run(dir, ['sync', '--yes'])
    expect(sync.code).toBe(1)
    expect(sync.out).toContain('@acme/base 1.3.0 is installed here; this project was compiled with 1.4.0')
    expect(JSON.parse(readFileSync(join(dir, '.opencastle', 'lock.json'), 'utf8')).layers[1].version).toBe('1.4.0')
    const down = run(dir, ['sync', '--allow-downgrade', '--yes'])
    expect(down.code).toBe(0)
    expect(down.out).toContain('Downgrading @acme/base from 1.4.0 to 1.3.0')
  })

  it('adds nothing to a .env the repository commits', () => {
    write(dir, { '.env': 'SHARED_DEFAULT=1\n' })
    git(dir, 'add', '-f', '.env')
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'shared defaults')
    const init = run(dir, ['init', '--yes'])
    expect(init.code).toBe(0)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('SHARED_DEFAULT=1\n')
    expect(init.out).toContain('.env is committed in this repository, so nothing was added to it')
    expect(init.out).toContain('in your shell — .env is committed here')
  })

  it('init refuses to downgrade too', () => {
    const path = join(dir, '.opencastle', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.version = '99.0.0'
    writeFileSync(path, JSON.stringify(manifest))
    const init = run(dir, ['init', '--yes'])
    expect(init.code).toBe(1)
    expect(init.out).toContain('compiled by OpenCastle 99.0.0')
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe('99.0.0')
  })

  it('reports removing a hand-added server the project excluded', () => {
    write(dir, {
      '.opencastle/config.json': JSON.stringify({
        extends: ['@acme/base'],
        exclude: ['mcpServers/acme-db'],
      }),
    })
    const vscode = JSON.parse(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf8'))
    expect(vscode.servers['acme-db']).toBeDefined()
    const check = run(dir, ['sync', '--check'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('acme-db (excluded by project)')
    const sync = run(dir, ['sync', '--yes'])
    expect(sync.out.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/Removed \d MCP server\(s\) the team's layers retired or its policy does not allow: acme-db/)
    expect(run(dir, ['sync', '--check']).code).toBe(0)
  })

  it('holds the lock back while an MCP config cannot be read, so a retired server is not forgotten', () => {
    write(dir, { '.opencastle/config.json': JSON.stringify({ extends: ['@acme/base'] }) })
    const lockBefore = readFileSync(join(dir, '.opencastle', 'lock.json'), 'utf8')
    writeFileSync(join(dir, '.vscode', 'mcp.json'), '{ not json')
    const sync = run(dir, ['sync', '--yes'])
    expect(sync.out).toContain('Left .opencastle/lock.json as it was')
    expect(readFileSync(join(dir, '.opencastle', 'lock.json'), 'utf8')).toBe(lockBefore)
  })

  it('says which integration servers the policy left out', () => {
    const add = run(dir, ['add', 'sentry'])
    expect(add.out.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/Left out 1 MCP server\(s\):\s+Sentry — not on the MCP allowlist of @acme\/base/)
  })

  it('writes the CI workflow and routes the lock to its owners', () => {
    const ci = run(dir, ['ci', '--owners', '@acme/platform'])
    expect(ci.code).toBe(0)
    const workflow = readFileSync(join(dir, '.github', 'workflows', 'opencastle.yml'), 'utf8')
    expect(workflow).toContain('sync --check')
    expect(readFileSync(join(dir, '.github', 'CODEOWNERS'), 'utf8')).toContain('/.opencastle/lock.json @acme/platform')
    // Again: the same workflow is done, not a conflict.
    const again = run(dir, ['ci'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('is already this workflow')
    // A different file of that name is someone's; it needs --force.
    writeFileSync(join(dir, '.github', 'workflows', 'opencastle.yml'), 'name: ours\n')
    const theirs = run(dir, ['ci'])
    expect(theirs.code).toBe(1)
    expect(theirs.out).toContain('differs from the one OpenCastle writes')
    expect(readFileSync(join(dir, '.github', 'workflows', 'opencastle.yml'), 'utf8')).toBe('name: ours\n')
  })

  it('reads the fleet from committed locks', () => {
    const fleet = JSON.parse(run(dir, ['fleet', dir, '--json']).out)
    expect(fleet.versions['@acme/base']).toEqual({ '1.4.0': ['shop'] })
  })
})

describe.skipIf(!built)('a baseline package', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-baseline-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('scaffolds one that passes its own check', () => {
    expect(run(dir, ['baseline', 'init', 'base', '--name', '@acme/base']).code).toBe(0)
    const pkg = JSON.parse(readFileSync(join(dir, 'base', 'package.json'), 'utf8'))
    expect(pkg.opencastle).toEqual({ baseline: '.' })
    const check = run(dir, ['baseline', 'check', 'base', '--json'])
    expect(check.code).toBe(0)
    const report = JSON.parse(check.out)
    expect(report.errors).toEqual([])
    expect(report.contributes).toMatchObject({ skills: 1, instructions: 1 })
  })

  it('fails one whose layer sits outside the package, as every consumer would', () => {
    run(dir, ['baseline', 'init', 'base', '--name', '@acme/base'])
    const path = join(dir, 'base', 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.opencastle.baseline = '../shared'
    delete pkg.files
    writeFileSync(path, JSON.stringify(pkg))
    mkdirSync(join(dir, 'shared'), { recursive: true })
    const check = run(dir, ['baseline', 'check', 'base'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('points outside the package')
  })

  it('names each problem once, by the path it was given', () => {
    run(dir, ['baseline', 'init', 'base', '--name', '@acme/base'])
    writeFileSync(
      join(dir, 'base', 'mcp.json'),
      JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { docs: { type: 'streamable-http', url: 'https://docs.acme.example/mcp' } } }),
    )
    run(dir, ['plugin', 'build', 'base'])
    const check = run(dir, ['baseline', 'check', 'base'])
    // eslint-disable-next-line no-control-regex
    check.out = check.out.replace(/\x1b\[[0-9;]*m/g, '')
    expect(check.code).toBe(1)
    expect(check.out).toContain('✗ base/mcp.json: defines MCP server "docs", which @acme/base does not allow\n    → add it to policy.mcp.allow in @acme/base')
    expect(check.out).not.toContain('✗ ✗')
    expect(check.out).not.toContain(dir.replace(/^\//, ''))
  })

  it('fails one that would publish empty', () => {
    run(dir, ['baseline', 'init', 'base', '--name', '@acme/base'])
    const path = join(dir, 'base', 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.files = ['README.md']
    writeFileSync(path, JSON.stringify(pkg))
    const check = run(dir, ['baseline', 'check', 'base'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('"files" does not include plugin.json, so npm publish would leave it out')
  })
})
