/**
 * `opencastle promote`, through the built CLI, with a home directory and a
 * Claude Code config directory of the test's own.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
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
  // Every assistant's memory store is the test's own: none of this machine's is read.
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    VSCODE_APPDATA: join(home, 'vscode'),
    CODEX_HOME: join(home, '.codex'),
  })
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

    it('says where it looked when there is none, and why Cursor and Copilot Memory are not among them', () => {
      const out = run(project, 'promote', 'memory')
      expect(out.status).toBe(1)
      expect(out.stderr).toMatch(/no memory at ~\/\.claude\/projects\/.*\/memory/)
      expect(out.stderr).toContain('Cursor keeps its memories on its servers')
    })

    it('reads VS Code’s repository memory for this folder, and no other folder’s or the user’s', () => {
      const storage = join(home, 'vscode', 'Code', 'User', 'workspaceStorage')
      write(join(storage, 'a1b2c3'), {
        'workspace.json': JSON.stringify({ folder: pathToFileURL(project).href }),
        'GitHub.copilot-chat/memory-tool/memories/repo/build.md': '# Build with pnpm\n\n- `pnpm build`, never `npm run build`: the lockfile is pnpm’s.\n',
        'GitHub.copilot-chat/memory-tool/memories/c2Vzc2lvbg==/scratch.md': '# This conversation only\n',
      })
      write(join(storage, 'ffffff'), {
        'workspace.json': JSON.stringify({ folder: pathToFileURL(join(root, 'other')).href }),
        'GitHub.copilot-chat/memory-tool/memories/repo/other.md': '# Another repository\n',
      })
      write(join(home, 'vscode', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories'), {
        'me.md': '# I like short answers\n',
      })
      const out = run(project, 'promote', 'memory')
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toMatch(/VS Code from .*a1b2c3/)
      const files = readdirSync(join(project, '.opencastle', 'lessons'))
      expect(files).toHaveLength(1)
      const text = readFileSync(join(project, '.opencastle', 'lessons', files[0]), 'utf8')
      expect(text).toContain('title: "Build with pnpm"')
      expect(text).toContain('`pnpm build`, never `npm run build`')
      expect(text).not.toContain('# Build with pnpm')
      expect(text).toMatch(/source: "vscode-memory:build\.md#[0-9a-f]{12}"/)
      expect(run(project, 'promote', 'memory').stdout).toContain('build.md: already a lesson')
    })

    it('takes from Codex only the blocks whose directory is this repository, and only what the team can use', () => {
      write(join(home, '.codex', 'memories'), {
        'MEMORY.md': [
          '# Task Group: app test runs',
          '',
          `scope: running the app's tests`,
          `applies_to: cwd=${project}/src; reuse_rule=safe while the test runner is vitest`,
          '',
          '## Task 1: ran the tests, passed',
          '',
          '### rollout_summary_files',
          '',
          `- rollout_summaries/2026-10-01-ab12-tests.md (cwd=${project}, rollout_path=${home}/.codex/sessions/x.jsonl)`,
          '',
          '## User preferences',
          '',
          '- the user asked for terse answers [Task 1]',
          '',
          '## Reusable knowledge',
          '',
          '- Run `npx vitest run --pool=forks`; threads hang on the native module [Task 1]',
          '',
          '## Failures and how to do differently',
          '',
          '- `npm test` without a build fails on missing dist/ -> build first [Task 1]',
          '',
          '# Task Group: another repository',
          '',
          'scope: elsewhere',
          'applies_to: cwd=/srv/elsewhere; reuse_rule=never here',
          '',
          '## Reusable knowledge',
          '',
          '- Not this repository',
          '',
        ].join('\n'),
      })
      const out = run(project, 'promote', 'memory')
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toMatch(/Codex from ~\/\.codex\/memories\/MEMORY\.md/)
      const files = readdirSync(join(project, '.opencastle', 'lessons'))
      expect(files).toHaveLength(1)
      const text = readFileSync(join(project, '.opencastle', 'lessons', files[0]), 'utf8')
      expect(text).toContain('title: "App test runs"')
      expect(text).toContain('## Reusable knowledge')
      expect(text).toContain('threads hang on the native module')
      expect(text).toContain('## Failures and how to do differently')
      expect(text).not.toContain('terse answers')
      expect(text).not.toContain('rollout_summary_files')
      expect(text).not.toContain('[Task 1]')
      expect(text).not.toContain('Not this repository')
      expect(text).toMatch(/source: "codex-memory:app test runs#[0-9a-f]{12}"/)
    })

    it('as the hook runs it: shares the project’s memory, keeps the user’s, refreshes what agents load, exits 0', () => {
      write(memoryDir(), {
        'build.md': memory('build', 'project', 'Set CI=1 before pnpm build.'),
        'dashboards.md': memory('dashboards', 'reference', 'Errors are in the Sentry project acme-web.'),
        'terse.md': memory('terse', 'user', 'Keep answers short.'),
      })
      const out = spawnSync('node', [cli, 'promote', 'memory', '--json'], {
        cwd: project,
        encoding: 'utf8',
        env: env(),
        input: '{"hook_event_name":"SessionEnd","reason":"exit"}',
      })
      expect(out.status).toBe(0)
      const report = JSON.parse(out.stdout) as { shared: Array<{ lesson: string }>; left: Array<{ memory: string; why: string }> }
      expect(report.shared).toHaveLength(2)
      expect(report.left).toEqual([{ assistant: 'Claude Code', memory: 'terse.md', why: 'about you, not the project' }])
      const rule = readFileSync(join(project, '.claude', 'rules', 'opencastle-lessons.md'), 'utf8')
      expect(rule).toContain('**Build**')
      expect(rule).toContain('**Dashboards**')
      expect(rule).not.toContain('Terse')
      expect(run(project, 'sync', '--check').status).toBe(0)

      const again = spawnSync('node', [cli, 'promote', 'memory', '--json'], { cwd: project, encoding: 'utf8', env: env(), input: '{}' })
      expect(JSON.parse(again.stdout).shared).toEqual([])

      const nowhere = spawnSync('node', [cli, 'promote', 'memory', '--json'], { cwd: root, encoding: 'utf8', env: env(), input: '{}' })
      expect(nowhere.status).toBe(0)
      expect(JSON.parse(nowhere.stdout).note).toContain('no .opencastle/ here')
    })

    it('init adds the memory hook beside the project’s own settings, and sync --check holds it', () => {
      const settings = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')) as { hooks: { SessionEnd: Array<{ hooks: Array<{ command: string; timeout: number }> }> } }
      const ours = settings.hooks.SessionEnd.flatMap((g) => g.hooks).find((h) => h.command.includes('promote memory --json'))
      expect(ours?.timeout).toBe(30)
      writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }))
      const check = run(project, 'sync', '--check')
      expect(check.status).toBe(1)
      expect(check.stdout + check.stderr).toContain('.claude/settings.json')
      expect(run(project, 'sync', '--yes').status).toBe(0)
      const merged = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')) as { permissions: unknown; hooks: unknown }
      expect(merged.permissions).toEqual({ allow: ['Bash(npm test)'] })
      expect(JSON.stringify(merged.hooks)).toContain('promote memory --json')
      expect(run(project, 'sync', '--check').status).toBe(0)
    })
  })
})
