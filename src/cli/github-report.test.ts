import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { escapeData, escapeProperty, annotationPath, annotations, summaryMarkdown, reportToGitHub } from './github-report.js'
import type { CheckReport } from './sync-check.js'

const clean: CheckReport = { installed: true, ides: ['claude-code', 'cursor'], drift: [], checked: 42 }
const drifted: CheckReport = {
  installed: true,
  ides: ['cursor'],
  checked: 10,
  drift: [
    { ide: 'cursor', path: '.cursor/rules/general.mdc', kind: 'changed' },
    { ide: 'cursor', path: '.cursor/rules/gone.mdc', kind: 'missing' },
    { ide: 'cursor', path: '.cursor/rules/stray.mdc', kind: 'extra' },
    { ide: 'claude-code', path: 'CLAUDE.md', kind: 'unreducible', detail: 'two start markers', fix: 'keep one pair' },
  ],
}

describe('escaping', () => {
  it('encodes what the runner decodes', () => {
    expect(escapeData('50%\nnext')).toBe('50%25%0Anext')
    expect(escapeProperty('a:b,c')).toBe('a%3Ab%2Cc')
  })
})

describe('annotationPath', () => {
  it('is relative to the checkout, so a monorepo project annotates the right file', () => {
    expect(annotationPath('CLAUDE.md', '/ws/apps/web', '/ws')).toBe('apps/web/CLAUDE.md')
  })
  it('falls back to the project when there is no workspace', () => {
    expect(annotationPath('.cursor/rules/x.mdc', '/p')).toBe('.cursor/rules/x.mdc')
  })
  it('never climbs out of the workspace', () => {
    expect(annotationPath('CLAUDE.md', '/elsewhere', '/ws')).toBe('CLAUDE.md')
  })
})

describe('annotations', () => {
  it('writes one error per drifted file, each with its own remedy', () => {
    const lines = annotations(drifted, '/ws', '/ws')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^::error file=\.cursor\/rules\/general\.mdc,title=Generated file edited in place::/)
    expect(lines[0]).toContain('.opencastle/')
    expect(lines[1]).toContain('commit the result')
    expect(lines[2]).toContain('deletes it')
    expect(lines[3]).toContain('two start markers')
    expect(lines[3]).toContain('Fix: keep one pair')
  })
  it('pins no file when the comparison itself failed', () => {
    const failed: CheckReport = { ...clean, drift: [{ ide: 'all', path: 'EACCES: denied', kind: 'unreducible' }] }
    expect(annotations(failed, '/ws')[0]).toMatch(/^::error title=/)
  })
  it('says what to run when nothing is installed', () => {
    expect(annotations({ ...clean, installed: false }, '/ws')[0]).toContain('opencastle init')
  })
})

describe('summaryMarkdown', () => {
  it('reports health in one line', () => {
    expect(summaryMarkdown(clean)).toContain('42 generated files match their sources across 2 targets')
  })
  it('tabulates drift with a remedy per row', () => {
    const md = summaryMarkdown(drifted)
    expect(md).toContain('| File | Target | What happened | What to do |')
    expect(md).toContain('`.cursor/rules/general.mdc`')
    expect(md).toContain('Run `npx opencastle sync`')
  })
  it('keeps a pipe in a path from breaking the table', () => {
    const md = summaryMarkdown({ ...drifted, drift: [{ ide: 'cursor', path: 'a|b.mdc', kind: 'extra' }] })
    expect(md).toContain('a\\|b.mdc')
  })
})

describe('reportToGitHub', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gh-report-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing off GitHub Actions', () => {
    const out: string[] = []
    const summary = join(dir, 'summary.md')
    reportToGitHub(drifted, dir, { env: { GITHUB_STEP_SUMMARY: summary }, write: (l) => out.push(l) })
    expect(out).toEqual([])
    expect(existsSync(summary)).toBe(false)
  })

  it('annotates and appends the summary on GitHub Actions', () => {
    const out: string[] = []
    const summary = join(dir, 'summary.md')
    writeFileSync(summary, 'earlier step\n')
    reportToGitHub(drifted, dir, {
      env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: dir },
      write: (l) => out.push(l),
    })
    expect(out).toHaveLength(4)
    const text = readFileSync(summary, 'utf8')
    expect(text.startsWith('earlier step\n')).toBe(true)
    expect(text).toContain('4 files differ from their sources')
  })

  it('keeps stdout clean for --json, and still writes the summary', () => {
    const out: string[] = []
    const summary = join(dir, 'summary.md')
    reportToGitHub(clean, dir, { json: true, env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }, write: (l) => out.push(l) })
    expect(out).toEqual([])
    expect(readFileSync(summary, 'utf8')).toContain('match their sources')
  })

  it('does not throw when the summary cannot be written', () => {
    expect(() =>
      reportToGitHub(clean, dir, { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: join(dir, 'no', 'such', 'dir', 'x.md') }, write: () => {} }),
    ).not.toThrow()
  })
})
