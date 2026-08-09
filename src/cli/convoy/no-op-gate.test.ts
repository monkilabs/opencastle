import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { noOpGate, collectWorktreeChanges } from './gates.js'

/**
 * A task that was refused write permission, tried, gave up and exited cleanly
 * used to be recorded as `done` with exit code 0 — the convoy reported fully
 * green with an empty branch behind it. These are the two halves of the check
 * that now catches it: the verdict, and the git evidence it prefers.
 */

// ── noOpGate ──────────────────────────────────────────────────────────────────

const BLOCKED_CONTRACT = {
  files_changed: [],
  tests_added: [],
  summary: 'BLOCKED: could not create .opencastle/convoy-pilot/PILOT.md',
}

describe('noOpGate', () => {
  it('passes a task that declared no files', () => {
    const result = noOpGate({
      declaredFiles: [],
      changedFiles: [],
      agent: 'developer',
      contractData: BLOCKED_CONTRACT,
    })
    expect(result.passed).toBe(true)
  })

  it('fails a task that declared files and left the worktree untouched', () => {
    const result = noOpGate({
      declaredFiles: ['PILOT.md'],
      changedFiles: [],
      agent: 'developer',
    })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('PILOT.md')
  })

  it('passes when git says the worktree changed, whatever the agent reported', () => {
    // Git is the stronger evidence: an agent that under-reports its own work is
    // not a no-op, and failing it here would be a false alarm on real changes.
    const result = noOpGate({
      declaredFiles: ['PILOT.md'],
      changedFiles: ['PILOT.md'],
      agent: 'developer',
      contractData: BLOCKED_CONTRACT,
    })
    expect(result.passed).toBe(true)
  })

  it('falls back to the contract when git could not be consulted', () => {
    const result = noOpGate({
      declaredFiles: ['PILOT.md'],
      changedFiles: null,
      agent: 'developer',
      contractData: BLOCKED_CONTRACT,
    })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('files_changed')
  })

  it('passes on the contract when the agent reported any file produced', () => {
    const result = noOpGate({
      declaredFiles: ['PILOT.md'],
      changedFiles: null,
      agent: 'developer',
      contractData: { files_changed: ['PILOT.md'], tests_added: [], summary: 'done' },
    })
    expect(result.passed).toBe(true)
  })

  it('passes when a tests-only report is the file evidence', () => {
    const result = noOpGate({
      declaredFiles: ['a.test.ts'],
      changedFiles: null,
      agent: 'developer',
      contractData: { files_changed: [], tests_added: ['a.test.ts'], summary: 'tests' },
    })
    expect(result.passed).toBe(true)
  })

  it('passes with no evidence at all rather than guessing', () => {
    // No worktree and no contract block is silence, not proof of a no-op. The
    // contract violation path reports the missing block on its own.
    const result = noOpGate({ declaredFiles: ['PILOT.md'], changedFiles: null, agent: 'developer' })
    expect(result.passed).toBe(true)
  })

  it('passes for an agent whose contract reports no file paths', () => {
    const result = noOpGate({
      declaredFiles: ['NOTES.md'],
      changedFiles: null,
      agent: 'researcher',
      contractData: { findings: 'none', sources: [], confidence: 'low', summary: 's' },
    })
    expect(result.passed).toBe(true)
  })
})

// ── collectWorktreeChanges ────────────────────────────────────────────────────

describe('collectWorktreeChanges', () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'no-op-gate-'))
    execFileSync('git', ['init', '-b', 'main', repo])
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'README.md'), 'base\n')
    git('add', '-A')
    git('commit', '-m', 'base')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports an untouched worktree as no changes, not as no evidence', async () => {
    expect(await collectWorktreeChanges(repo, 'main')).toEqual([])
  })

  it('sees uncommitted work the merge queue has yet to stage', async () => {
    mkdirSync(join(repo, 'nested'))
    writeFileSync(join(repo, 'nested', 'PILOT.md'), 'hello\n')
    expect(await collectWorktreeChanges(repo, 'main')).toContain('nested/PILOT.md')
  })

  it('sees work the agent committed itself', async () => {
    git('checkout', '-b', 'convoy-worker-1')
    writeFileSync(join(repo, 'PILOT.md'), 'hello\n')
    git('add', '-A')
    git('commit', '-m', 'agent commit')
    expect(await collectWorktreeChanges(repo, 'main')).toEqual(['PILOT.md'])
  })

  it('reports the destination of a rename, not the porcelain arrow', async () => {
    git('mv', 'README.md', 'DOCS.md')
    const changed = await collectWorktreeChanges(repo, 'main')
    expect(changed).toContain('DOCS.md')
    expect(changed!.some(p => p.includes('->'))).toBe(false)
  })

  it('returns null when git cannot answer', async () => {
    expect(await collectWorktreeChanges(join(repo, 'does-not-exist'), 'main')).toBeNull()
  })
})
