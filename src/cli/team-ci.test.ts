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

  it('doctor and CI both fail on it, sync at the same version fixes it, both pass', () => {
    // What every release before this one wrote into .mcp.json for Supabase.
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } }, null, 2) + '\n',
    )

    const before = run(dir, ['doctor'])
    expect(before.code).toBe(1)
    expect(before.out).toContain('npx opencastle sync fixes Supabase')
    // The check a team runs in CI must not be green over what doctor fails.
    const check = run(dir, ['sync', '--check'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('still an earlier OpenCastle default: Supabase')

    const sync = run(dir, ['sync', '--yes'])
    expect(sync.code).toBe(0)
    expect(sync.out).toContain('Moved 1 MCP server(s) to the current default: Supabase')

    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    expect(config.mcpServers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
    expect(run(dir, ['doctor']).code).toBe(0)
    expect(run(dir, ['sync', '--check']).code).toBe(0)
  })

  it('an edited entry: the remedy doctor names brings back the current default', () => {
    // Edited since OpenCastle wrote it, so sync must leave it — and doctor must
    // not say otherwise.
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp', note: 'ours' } } }, null, 2) + '\n',
    )
    const doctor = run(dir, ['doctor'])
    expect(doctor.code).toBe(1)
    expect(doctor.out).toContain('delete the entry and run npx opencastle sync --force')
    expect(run(dir, ['sync', '--check']).code).toBe(1)

    // Follow it literally.
    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    delete config.mcpServers.Supabase
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config, null, 2) + '\n')
    expect(run(dir, ['sync', '--force', '--yes']).code).toBe(0)
    const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    expect(after.mcpServers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
    expect(run(dir, ['doctor']).code).toBe(0)
  })

  it('a plugin server the stack dropped: doctor, CI and sync agree it goes', () => {
    // An old Figma default in a project whose stack has no Figma.
    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    config.mcpServers.Figma = {
      command: 'npx',
      args: ['-y', '@anthropic/figma-mcp@latest'],
      env: { FIGMA_ACCESS_TOKEN: '${FIGMA_ACCESS_TOKEN}' },
    }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config, null, 2) + '\n')

    const doctor = run(dir, ['doctor'])
    expect(doctor.code).toBe(1)
    expect(doctor.out).toContain('npx opencastle sync removes Figma')
    const check = run(dir, ['sync', '--check'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('so sync removes: Figma')

    const sync = run(dir, ['sync', '--yes'])
    expect(sync.out).toContain('Removed 1 MCP server(s)')
    expect(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers.Figma).toBeUndefined()
    expect(run(dir, ['doctor']).code).toBe(0)
    expect(run(dir, ['sync', '--check']).code).toBe(0)
  })

  it('a broken server of the user’s own fails CI, and sync leaves the repo alone', () => {
    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    config.mcpServers.context7 = { url: 'https://mcp.context7.com/mcp' }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config, null, 2) + '\n')

    const check = run(dir, ['sync', '--check'])
    expect(check.code).toBe(1)
    expect(check.out).toContain('only a person can fix')
    expect(check.out).toContain('fix context7 by hand')

    // Recompiling cannot fix it, so sync must not rewrite committed files for it.
    const manifest = join(dir, '.opencastle', 'manifest.json')
    const before = readFileSync(manifest, 'utf8')
    const sync = run(dir, ['sync', '--yes'])
    expect(sync.out).toContain('Everything matches its sources')
    expect(readFileSync(manifest, 'utf8')).toBe(before)

    // And the front door does not call it stale output.
    expect(run(dir, []).out).not.toContain('no longer match their sources')
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
    expect(r.out).toMatch(/::error file=\.claude\/agents\/developer\.agent\.md,title=Generated file differs from its source::/)
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
