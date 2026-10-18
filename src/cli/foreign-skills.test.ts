import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { adoptForeignSkills, foreignSkills, skillFolders } from './foreign-skills.js'

const skill = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: How to run the e2e tests. Use when running them.\n---\n${extra}\n1. npm run e2e\n`

describe('a skill another tool wrote into a compiled folder', () => {
  let dir: string
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-foreign-skills-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds the compiled skill folders among a target’s paths', () => {
    expect(skillFolders(['.claude/agents/', '.claude/skills/', '.agents/skills/', '.cursor/rules/', '.agents/skills/'])).toEqual([
      '.claude/skills',
      '.agents/skills',
    ])
  })

  it('is one no source produces, OpenCastle never wrote, and that carries no OpenCastle marker', () => {
    write('.agents/skills/run-e2e/SKILL.md', skill('run-e2e'))
    write('.agents/skills/run-e2e/scripts/seed.sh', 'echo seed\n')
    write('.agents/skills/testing-workflow/SKILL.md', skill('testing-workflow'))
    write('.agents/skills/old-release/SKILL.md', skill('old-release'))
    write('.agents/skills/marked/SKILL.md', skill('marked', '<!-- ⚠️ This file is managed by OpenCastle. -->'))
    write('.agents/skills/no-skill-file/README.md', 'notes\n')
    write('.claude/skills/claude-made/SKILL.md', skill('claude-made'))
    write(
      '.opencastle/lock.json',
      JSON.stringify({
        lockfileVersion: 1,
        opencastle: '1.12.0',
        targets: ['cursor'],
        integrations: [],
        layers: [{ id: 'core' }],
        content: { 'skills/old-release': { from: 'core', sha: 'x' } },
        mcp: {},
        context: { tokens: 0, instructions: 0, index: 0 },
      }),
    )
    write('.opencastle/skills/already-ours/SKILL.md', skill('already-ours'))
    write('.agents/skills/already-ours/SKILL.md', skill('already-ours'))

    const found = foreignSkills(dir, ['.agents/skills', '.claude/skills'], new Set(['skills/testing-workflow']))
    expect(found).toEqual([
      { name: 'run-e2e', from: '.agents/skills/run-e2e' },
      { name: 'claude-made', from: '.claude/skills/claude-made' },
    ])

    adoptForeignSkills(dir, found)
    expect(readFileSync(join(dir, '.opencastle/skills/run-e2e/SKILL.md'), 'utf8')).toBe(skill('run-e2e'))
    expect(existsSync(join(dir, '.opencastle/skills/run-e2e/scripts/seed.sh'))).toBe(true)
    expect(existsSync(join(dir, '.opencastle/skills/claude-made/SKILL.md'))).toBe(true)
  })
})

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')
const cliBuilt = existsSync(join(repoRoot, 'dist', 'cli', 'init.js'))

// Devin writes a skill it proposes to `.agents/skills/`, which a project
// compiled for Cursor (or Windsurf, Codex, OpenCode) treats as compiled output:
// `sync` deleted it, and `sync --check` failed CI on it until then.
describe.skipIf(!cliBuilt)('sync and a skill another tool added', () => {
  let projectRoot: string
  const run = (...args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('node', [cli, ...args], { cwd: projectRoot, encoding: 'utf8', input: '' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oc-foreign-sync-'))
    execFileSync('git', ['init', '-q'], { cwd: projectRoot })
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'demo' }))
    // Cursor, then the defaults for every other question.
    execFileSync('node', [cli, 'init', '--customize', '--yes'], { cwd: projectRoot, input: `2\n${'\n'.repeat(30)}`, stdio: ['pipe', 'ignore', 'ignore'] })
  })
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }))

  it('keeps it: the team’s source now, compiled where it was, and the check is clean after', () => {
    const added = join(projectRoot, '.agents/skills/run-e2e/SKILL.md')
    mkdirSync(dirname(added), { recursive: true })
    writeFileSync(added, skill('run-e2e'))

    const check = run('sync', '--check')
    expect(check.status).toBe(1)
    expect(check.out).toContain('Skills another tool added')
    expect(check.out).not.toContain('Not produced by any source')

    const sync = run('sync', '--yes')
    expect(sync.status).toBe(0)
    expect(sync.out).toContain('.agents/skills/run-e2e → .opencastle/skills/run-e2e')
    expect(readFileSync(join(projectRoot, '.opencastle/skills/run-e2e/SKILL.md'), 'utf8')).toBe(skill('run-e2e'))
    expect(existsSync(added)).toBe(true)
    expect(run('sync', '--check').status).toBe(0)
  })

  it('still removes a skill OpenCastle wrote that no source produces any more', () => {
    const stale = join(projectRoot, '.agents/skills/old-release/SKILL.md')
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, skill('old-release', '<!-- ⚠️ This file is managed by OpenCastle. -->'))
    expect(run('sync', '--check').out).toContain('Not produced by any source')
    expect(run('sync', '--yes').status).toBe(0)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(projectRoot, '.opencastle/skills/old-release'))).toBe(false)
  })
})
