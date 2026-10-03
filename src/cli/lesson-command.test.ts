/**
 * `opencastle lesson`, as agents call it.
 *
 * The command is hidden from help because people rarely type it — the
 * generated instructions tell agents to. That made it the least exercised
 * writer of a file every agent reads first: it had no test at all, and the
 * skill describing it told agents to check their entry with `tail -1`, which
 * showed the index row, not the entry.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkLessons } from './lessons.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(pkgRoot, 'bin', 'cli.mjs')
const built = existsSync(join(pkgRoot, 'dist', 'cli', 'lesson.js'))

describe.skipIf(!built)('opencastle lesson', () => {
  let project: string
  const sh = (...args: string[]): string =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const lesson = (...args: string[]) => spawnSync('node', [cli, 'lesson', ...args], { cwd: project, encoding: 'utf8' })
  const files = (): string[] => readdirSync(join(project, '.opencastle', 'lessons')).sort()
  const index = (): string => readFileSync(join(project, '.opencastle', 'LESSONS-LEARNED.md'), 'utf8')
  const base = ['--title', 'Quote shell variables', '--category', 'terminal', '--severity', 'medium', '--problem', 'Paths with spaces break']

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-lesson-cmd-'))
    sh('init', '-q')
    sh('config', 'user.email', 't@example.com')
    sh('config', 'user.name', 'T')
    mkdirSync(join(project, '.opencastle'))
    mkdirSync(join(project, 'scripts'))
    writeFileSync(join(project, 'scripts', 'clean.sh'), 'rm -rf "$DIR/old"\n')
    writeFileSync(
      join(project, '.opencastle', 'LESSONS-LEARNED.md'),
      readFileSync(join(import.meta.dirname, 'fixtures', 'lessons-template-1.0.md'), 'utf8'),
    )
    sh('add', '.')
    sh('commit', '-qm', 'init')
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('writes one file, named by date and title, and lists it in the index', () => {
    const out = lesson(...base, '--cite', 'scripts/clean.sh:1')
    expect(out.status).toBe(0)
    const [file] = files()
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}-quote-shell-variables\.md$/)
    const text = readFileSync(join(project, '.opencastle', 'lessons', file), 'utf8')
    expect(text).toContain('citations:\n  - "scripts/clean.sh:1"')
    expect(text).toMatch(/fingerprints:\n  scripts\/clean\.sh: "[0-9a-f]{12}"/)
    expect(index()).toContain('**Quote shell variables** — `medium`')
    expect(out.stdout).toContain(file.replace(/\.md$/, ''))
  })

  it('names two lessons with one title apart, so branches never collide', () => {
    lesson(...base)
    lesson(...base)
    expect(files()).toHaveLength(2)
    expect(files().some((f) => /-quote-shell-variables-2\.md$/.test(f))).toBe(true)
  })

  it('refuses a citation that does not exist, and writes nothing', () => {
    const out = lesson(...base, '--cite', 'scripts/missing.sh')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('scripts/missing.sh does not exist')
    expect(existsSync(join(project, '.opencastle', 'lessons'))).toBe(false)
  })

  it('refuses a lesson that would commit a credential', () => {
    const out = lesson(...base, '--correct', 'use AKIAIOSFODNN7EXAMPLE as the key')
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/looks like a AWS Access Key/)
    expect(existsSync(join(project, '.opencastle', 'lessons'))).toBe(false)
  })

  it('verify clears what doctor said about changed code', () => {
    lesson(...base, '--cite', 'scripts/clean.sh')
    writeFileSync(join(project, 'scripts', 'clean.sh'), 'rm -rf -- "$DIR/old"\n')
    expect(checkLessons(project).warning).toBe(true)
    const id = files()[0].replace(/\.md$/, '')
    expect(lesson('verify', id).status).toBe(0)
    expect(checkLessons(project).warning).toBeUndefined()
  })

  it('archive moves a lesson out of the list agents read, and keeps it on record', () => {
    lesson(...base)
    const id = files()[0].replace(/\.md$/, '')
    expect(lesson('archive', id, '--into', 'scripts/clean.sh').status).toBe(0)
    const [active, archived] = index().split('## Archived')
    expect(active).not.toContain('Quote shell variables')
    expect(archived).toContain('**Quote shell variables** → `scripts/clean.sh`')
  })

  it('moves an old single-file log into lesson files before adding to it', () => {
    writeFileSync(
      join(project, '.opencastle', 'LESSONS-LEARNED.md'),
      '# Lessons Learned\n\n### LES-004: Never push to main\n\n| Field | Value |\n|---|---|\n| **Category** | `git` |\n| **Added** | 2026-03-02 |\n| **Severity** | `high` |\n\n**Problem:** It was pushed.\n',
    )
    const out = lesson(...base)
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('Moved 1 lesson(s)')
    expect(files()).toEqual(expect.arrayContaining(['LES-004-never-push-to-main.md']))
    expect(index()).toContain('## git')
    expect(existsSync(join(project, '.opencastle', 'LESSONS-LEARNED.md.opencastle-backup'))).toBe(true)
  })

  it('--dry-run prints the lesson and writes nothing', () => {
    const out = lesson(...base, '--dry-run')
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('title: "Quote shell variables"')
    expect(existsSync(join(project, '.opencastle', 'lessons'))).toBe(false)
  })
})
