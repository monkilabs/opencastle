/**
 * `opencastle promote`, through the built CLI, with a home directory and a
 * Claude Code config directory of the test's own.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { claudeMemoryDir } from './promote.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(pkgRoot, 'bin', 'cli.mjs')
const built = existsSync(join(pkgRoot, 'dist', 'cli', 'promote.js'))

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

const skill = (name: string, body = 'Do the thing well.'): string =>
  `---\nname: ${name}\ndescription: "How we deploy. Use when releasing or rolling back."\n---\n\n# ${name}\n\n${body}\n`

const memory = (name: string, type: string, body: string): string =>
  `---\nname: ${name}\ndescription: "${name.replace(/-/g, ' ')}"\nmetadata:\n  node_type: memory\n  type: ${type}\n  originSessionId: a50c8b40-9d31-4f2e-b2d6-c56e14021622\n---\n\n${body}\n`

describe.skipIf(!built)('opencastle promote', () => {
  let root: string
  let home: string
  let config: string
  let project: string
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config })
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync('node', [cli, ...args], { cwd, encoding: 'utf8', env: env() })
    // eslint-disable-next-line no-control-regex
    const plain = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, '')
    return { status: r.status, stdout: plain(r.stdout), stderr: plain(r.stderr) }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oc-promote-'))
    home = join(root, 'home')
    config = join(home, '.claude')
    project = join(root, 'app')
    mkdirSync(home, { recursive: true })
    write(project, { 'CLAUDE.md': '# App\n' })
    execFileSync('git', ['init', '-q'], { cwd: project })
    expect(run(project, 'init', '--yes').status).toBe(0)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  describe('skill', () => {
    it('copies a personal skill into the team’s sources, and sync gives it to every assistant', () => {
      write(home, { '.claude/skills/deploy-runbook/SKILL.md': skill('deploy-runbook'), '.claude/skills/deploy-runbook/scripts/rollback.sh': '#!/bin/sh\n' })
      const out = run(project, 'promote', 'skill', 'deploy-runbook')
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toContain('Promoted deploy-runbook from ~/.claude/skills/deploy-runbook')
      expect(readdirSync(join(project, '.opencastle', 'skills', 'deploy-runbook')).sort()).toEqual(['SKILL.md', 'scripts'])
      expect(run(project, 'sync', '--yes').status).toBe(0)
      expect(existsSync(join(project, '.claude', 'skills', 'deploy-runbook', 'scripts', 'rollback.sh'))).toBe(true)
    })

    it('looks in Claude Code’s config directory where CLAUDE_CONFIG_DIR moves it, as promote memory does', () => {
      config = join(root, 'elsewhere')
      write(config, { 'skills/sql-tips/SKILL.md': skill('sql-tips') })
      const out = run(project, 'promote', 'skill', 'sql-tips', '--dry-run')
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toContain(join('elsewhere', 'skills', 'sql-tips'))
    })

    it('finds one in the shared .agents/skills/ too', () => {
      write(home, { '.agents/skills/deploy-runbook/SKILL.md': skill('deploy-runbook') })
      expect(run(project, 'promote', 'skill', 'deploy-runbook').status).toBe(0)
    })

    it('refuses one an assistant following the Agent Skills spec would skip', () => {
      write(home, { '.claude/skills/deploy/SKILL.md': skill('deploy-runbook') })
      const out = run(project, 'promote', 'skill', 'deploy')
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('must match its directory, deploy/')
      expect(existsSync(join(project, '.opencastle', 'skills', 'deploy'))).toBe(false)
    })

    it('refuses one that would commit a credential', () => {
      write(home, { '.claude/skills/deploy-runbook/SKILL.md': skill('deploy-runbook', 'Use key AKIAIOSFODNN7EXAMPLE.') })
      const out = run(project, 'promote', 'skill', 'deploy-runbook')
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('looks like a AWS Access Key')
    })

    it('will not replace a team skill unless told to', () => {
      write(home, { '.claude/skills/deploy-runbook/SKILL.md': skill('deploy-runbook', 'new') })
      write(project, { '.opencastle/skills/deploy-runbook/SKILL.md': skill('deploy-runbook', 'old') })
      expect(run(project, 'promote', 'skill', 'deploy-runbook').stderr).toContain('already exists')
      expect(run(project, 'promote', 'skill', 'deploy-runbook', '--force').status).toBe(0)
      expect(readFileSync(join(project, '.opencastle', 'skills', 'deploy-runbook', 'SKILL.md'), 'utf8')).toContain('new')
    })

    it('promotes into a baseline every repository extends, which still checks clean', () => {
      expect(run(root, 'baseline', 'init', 'standard', '--name', '@acme/standard').status).toBe(0)
      write(home, { '.claude/skills/deploy-runbook/SKILL.md': skill('deploy-runbook') })
      const out = run(project, 'promote', 'skill', 'deploy-runbook', '--to', '../standard')
      expect(out.status, out.stderr).toBe(0)
      expect(existsSync(join(root, 'standard', 'skills', 'deploy-runbook', 'SKILL.md'))).toBe(true)
      expect(out.stdout).toContain('opencastle baseline check')
      expect(run(root, 'plugin', 'check', 'standard').status).toBe(0)
    })

    it('--dry-run writes nothing', () => {
      write(home, { '.claude/skills/deploy-runbook/SKILL.md': skill('deploy-runbook') })
      expect(run(project, 'promote', 'skill', 'deploy-runbook', '--dry-run').stdout).toContain('[dry-run] Would copy')
      expect(existsSync(join(project, '.opencastle', 'skills', 'deploy-runbook'))).toBe(false)
    })
  })

  describe('memory', () => {
    const memoryDir = (): string => {
      const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
      process.env.HOME = home
      process.env.CLAUDE_CONFIG_DIR = config
      try {
        return claudeMemoryDir(project)
      } finally {
        process.env.HOME = saved.HOME
        process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR
      }
    }

    it('finds this repository’s auto memory where Claude Code keeps it', () => {
      expect(memoryDir()).toMatch(new RegExp(`${config.replace(/[/.]/g, '\\$&')}/projects/-.*-app/memory$`))
    })

    it('turns corrections and project notes into lessons, and leaves out the rest', () => {
      write(memoryDir(), {
        'MEMORY.md': '- [Never commit to main](never-commit-to-main.md)\n',
        'never-commit-to-main.md': memory('never-commit-to-main', 'feedback', `Always branch.\n\n**Why:** ${home}/notes said so.`),
        'release-freeze.md': memory('release-freeze', 'project', 'No merges after Thursday until the 12th.'),
        'user-role.md': memory('user-role', 'user', 'A senior engineer who prefers terse answers.'),
        'leaked.md': memory('leaked', 'feedback', 'The key is AKIAIOSFODNN7EXAMPLE.'),
      })
      const out = run(project, 'promote', 'memory')
      expect(out.status, out.stderr).toBe(0)
      const files = readdirSync(join(project, '.opencastle', 'lessons'))
      expect(files).toHaveLength(2)
      const text = files.map((f) => readFileSync(join(project, '.opencastle', 'lessons', f), 'utf8')).join('\n')
      expect(text).toContain('title: "Never commit to main"')
      expect(text).toContain('**Why:** ~/notes said so.')
      expect(text).not.toContain(home)
      expect(text).not.toContain('originSessionId')
      expect(text).toMatch(/source: "claude-code-memory:never-commit-to-main\.md#[0-9a-f]{12}"/)
      expect(out.stdout).toContain('user-role.md: about you, not the project')
      expect(out.stdout).toMatch(/leaked\.md: holds what looks like a AWS Access Key/)
      expect(readFileSync(join(project, '.opencastle', 'LESSONS-LEARNED.md'), 'utf8')).toContain('**Release freeze**')

      const again = run(project, 'promote', 'memory')
      expect(again.stdout).toContain('Nothing new to promote.')
      expect(again.stdout).toContain('never-commit-to-main.md: already a lesson')
      expect(run(project, 'sync', '--check').status).toBe(0)
    })

    it('reads where autoMemoryDirectory points', () => {
      const custom = join(home, 'my-memory')
      write(project, { '.claude/settings.local.json': JSON.stringify({ autoMemoryDirectory: '~/my-memory' }) })
      write(custom, { 'a.md': memory('quote-paths', 'feedback', 'Quote paths with spaces.') })
      const out = run(project, 'promote', 'memory')
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toContain('from ~/my-memory')
    })

    it('says where it looked when there is none', () => {
      const out = run(project, 'promote', 'memory')
      expect(out.status).toBe(1)
      expect(out.stderr).toMatch(/no memory at ~\/\.claude\/projects\/.*\/memory/)
    })
  })
})
