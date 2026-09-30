/**
 * The team-facing paths, driven through the CLI the way a person and a CI job
 * would drive them.
 *
 * Two promises are checked end to end here because each one failed in
 * development in a way unit tests did not see: `doctor` prescribed `sync` for a
 * stale MCP server and `sync` then reported nothing to do; and drift has to show
 * up where a pull request's author will read it, not only in a job log.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')
const built = existsSync(join(repoRoot, 'dist', 'cli', 'doctor.js'))

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  // GitHub's own variables are stripped, so a run of this suite inside Actions
  // does not report to the job it is running in.
  const base = { ...process.env }
  for (const k of Object.keys(base)) if (k.startsWith('GITHUB_')) delete base[k]
  try {
    const out = execFileSync('node', [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...base, ...env },
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe.skipIf(!built)('a stale MCP default is fixed by the command doctor names', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-mcp-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Ours\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@supabase/supabase-js': '^2.0.0' } }))
    expect(run(dir, ['init', '--yes']).code).toBe(0)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('doctor fails on it, sync at the same version fixes it, doctor passes', () => {
    // What every release before this one wrote into .mcp.json for Supabase.
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } }, null, 2) + '\n',
    )

    const before = run(dir, ['doctor'])
    expect(before.code).toBe(1)
    expect(before.out).toContain('opencastle sync fixes Supabase')

    const sync = run(dir, ['sync', '--yes'])
    expect(sync.code).toBe(0)
    expect(sync.out).toContain('Moved 1 MCP server(s) to the current default: Supabase')

    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    expect(config.mcpServers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
    expect(run(dir, ['doctor']).code).toBe(0)
  })

  it('leaves a server someone wrote, and says so', () => {
    const own = { command: 'npx', args: ['-y', 'our-internal-mcp'] }
    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    config.mcpServers.Ours = own
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config, null, 2) + '\n')

    const doctor = run(dir, ['doctor'])
    expect(doctor.code).toBe(0)
    expect(doctor.out).toContain('fix Ours by hand')

    run(dir, ['sync', '--yes'])
    expect(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers.Ours).toEqual(own)
  })
})

describe.skipIf(!built)('sync --check on GitHub Actions', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-ci-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Ours\n')
    expect(run(dir, ['init', '--yes']).code).toBe(0)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('annotates the drifted file and writes the run summary', () => {
    const agent = join(dir, '.claude', 'agents', 'developer.agent.md')
    expect(existsSync(agent)).toBe(true)
    appendFileSync(agent, '\nedited in place\n')
    const summary = join(dir, 'summary.md')

    const r = run(dir, ['sync', '--check'], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: dir })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::error file=\.claude\/agents\/developer\.agent\.md,title=Generated file edited in place::/)
    expect(readFileSync(summary, 'utf8')).toContain('`.claude/agents/developer.agent.md`')
  })

  it('keeps --json parseable', () => {
    const r = run(dir, ['sync', '--check', '--json'], { GITHUB_ACTIONS: 'true' })
    expect(r.code).toBe(0)
    expect(() => JSON.parse(r.out)).not.toThrow()
  })

  it('prints no workflow commands anywhere else', () => {
    appendFileSync(join(dir, '.claude', 'agents', 'developer.agent.md'), '\nedited\n')
    const r = run(dir, ['sync', '--check'])
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('::error')
  })
})
