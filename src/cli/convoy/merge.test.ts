import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMergeQueue, MergeConflictError } from './merge.js'
import type { MergeQueue } from './merge.js'

const execFile = promisify(execFileCb)

// ── helpers ───────────────────────────────────────────────────────────────────

let repoPath: string
let featureBranch: string
let queue: MergeQueue

async function setupTestRepo(): Promise<{ repoPath: string; featureBranch: string }> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'merge-test-')))
  await execFile('git', ['init', path])
  await execFile('git', ['-C', path, 'config', 'user.email', 'test@test.com'])
  await execFile('git', ['-C', path, 'config', 'user.name', 'Test'])
  writeFileSync(join(path, 'README.md'), '# Test')
  await execFile('git', ['-C', path, 'add', '-A'])
  await execFile('git', ['-C', path, 'commit', '-m', 'Initial commit'])
  await execFile('git', ['-C', path, 'checkout', '-b', 'feat/test'])
  return { repoPath: path, featureBranch: 'feat/test' }
}

async function addWorktree(repo: string, workerId: string, branch: string): Promise<string> {
  const worktreesDir = join(repo, '.opencastle', 'worktrees')
  mkdirSync(worktreesDir, { recursive: true })
  const worktreePath = join(worktreesDir, workerId)
  await execFile('git', ['-C', repo, 'worktree', 'add', worktreePath, '-b', `convoy-${workerId}`, branch])
  return worktreePath
}

beforeEach(async () => {
  const result = await setupTestRepo()
  repoPath = result.repoPath
  featureBranch = result.featureBranch
  queue = createMergeQueue(repoPath)
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ── successful merge ──────────────────────────────────────────────────────────

describe('merge - successful merge', () => {
  it('stages, commits, and merges worktree changes to the target branch', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)
    writeFileSync(join(worktreePath, 'output.txt'), 'worker output')

    const result = await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    expect(result).toEqual({ success: true, conflicted: false, message: 'Merged successfully' })
  })

  it('makes the merged file available in the target branch working tree', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)
    writeFileSync(join(worktreePath, 'output.txt'), 'worker output')

    await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    const { existsSync } = await import('node:fs')
    expect(existsSync(join(repoPath, 'output.txt'))).toBe(true)
  })

  it('creates an auto-commit on the worktree branch with the convoy message', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)
    writeFileSync(join(worktreePath, 'output.txt'), 'worker output')

    await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    const { stdout } = await execFile('git', ['-C', repoPath, 'log', '--oneline', 'convoy-worker1'])
    expect(stdout).toContain('convoy: convoy-worker1 completed')
  })
})

// ── no changes ────────────────────────────────────────────────────────────────

describe('merge - no changes', () => {
  it('returns success with "No changes to merge" when the worker made no file changes', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)

    const result = await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    expect(result).toEqual({ success: true, conflicted: false, message: 'No changes to merge' })
  })

  it('does not create a commit when there is nothing to stage', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)

    await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    const { stdout } = await execFile('git', ['-C', repoPath, 'log', '--oneline', 'convoy-worker1'])
    expect(stdout).not.toContain('convoy: convoy-worker1 completed')
  })
})

// ── merge conflict ────────────────────────────────────────────────────────────

describe('merge - conflict', () => {
  it('throws MergeConflictError and aborts when two worktrees edit the same file', async () => {
    const worktree1 = await addWorktree(repoPath, 'worker1', featureBranch)
    const worktree2 = await addWorktree(repoPath, 'worker2', featureBranch)

    writeFileSync(join(worktree1, 'shared.txt'), 'content from worker 1')
    writeFileSync(join(worktree2, 'shared.txt'), 'content from worker 2')

    const first = await queue.merge(worktree1, 'convoy-worker1', featureBranch)
    expect(first).toEqual({ success: true, conflicted: false, message: 'Merged successfully' })

    await expect(queue.merge(worktree2, 'convoy-worker2', featureBranch))
      .rejects.toThrow(MergeConflictError)
  })

  it('leaves the repo in a clean state (no pending merge) after aborting a conflict', async () => {
    const worktree1 = await addWorktree(repoPath, 'worker1', featureBranch)
    const worktree2 = await addWorktree(repoPath, 'worker2', featureBranch)

    writeFileSync(join(worktree1, 'shared.txt'), 'content from worker 1')
    writeFileSync(join(worktree2, 'shared.txt'), 'content from worker 2')

    await queue.merge(worktree1, 'convoy-worker1', featureBranch)
    await expect(queue.merge(worktree2, 'convoy-worker2', featureBranch))
      .rejects.toBeInstanceOf(MergeConflictError)

    // --untracked-files=no excludes the .opencastle/worktrees/ dir from the check;
    // we only want to verify there is no pending merge (no staged/modified tracked files).
    const { stdout } = await execFile('git', ['-C', repoPath, 'status', '--porcelain', '--untracked-files=no'])
    expect(stdout.trim()).toBe('')
  })
})

// ── already committed changes ─────────────────────────────────────────────────

describe('merge - already committed changes', () => {
  it('merges pre-committed changes without auto-committing', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)

    writeFileSync(join(worktreePath, 'output.txt'), 'pre-committed content')
    await execFile('git', ['-C', worktreePath, 'add', '-A'])
    await execFile('git', ['-C', worktreePath, 'commit', '-m', 'Worker manual commit'])

    const result = await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    expect(result).toEqual({ success: true, conflicted: false, message: 'Merged successfully' })
  })

  it('makes pre-committed files available in the target branch after merge', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)

    writeFileSync(join(worktreePath, 'output.txt'), 'pre-committed content')
    await execFile('git', ['-C', worktreePath, 'add', '-A'])
    await execFile('git', ['-C', worktreePath, 'commit', '-m', 'Worker manual commit'])

    await queue.merge(worktreePath, 'convoy-worker1', featureBranch)

    const { existsSync } = await import('node:fs')
    expect(existsSync(join(repoPath, 'output.txt'))).toBe(true)
  })
})

// ── error handling ────────────────────────────────────────────────────────────

describe('merge - error handling', () => {
  it('throws when the worktree branch does not exist in the repo', async () => {
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)

    await expect(
      queue.merge(worktreePath, 'nonexistent-branch', featureBranch),
    ).rejects.toThrow()
  })

  it('throws when path is outside the managed worktrees directory', async () => {
    await expect(
      queue.merge('/tmp/evil', 'some-branch', featureBranch),
    ).rejects.toThrow(/outside the managed worktrees directory/)
  })
})

// ── one merge at a time ───────────────────────────────────────────────────────

describe('merge - concurrency', () => {
  it('lands every one of eight merges started at once', async () => {
    // Without the mutex, concurrent merges fought over index.lock and HEAD.
    const paths: string[] = []
    for (let i = 0; i < 8; i++) {
      const p = await addWorktree(repoPath, `w${i}`, featureBranch)
      writeFileSync(join(p, `f${i}.txt`), `${i}`)
      paths.push(p)
    }
    const results = await Promise.all(paths.map((p, i) => queue.merge(p, `convoy-w${i}`, featureBranch)))
    expect(results.every(r => r.success)).toBe(true)
    const { stdout } = await execFile('git', ['-C', repoPath, 'ls-tree', '--name-only', featureBranch])
    for (let i = 0; i < 8; i++) expect(stdout).toContain(`f${i}.txt`)
  })

  it('throws MergeError, not a success, when the merge fails for another reason', async () => {
    const { MergeError } = await import('./merge.js')
    const worktreePath = await addWorktree(repoPath, 'worker1', featureBranch)
    await expect(queue.merge(worktreePath, 'no-such-branch', featureBranch)).rejects.toBeInstanceOf(MergeError)
  })
})
