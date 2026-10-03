import { join, resolve } from 'node:path'
import { commitAllIn, git, isInside, mergeIn } from './worktree.js'

export interface MergeResult {
  success: boolean
  conflicted: boolean
  message: string
}

export class MergeConflictError extends Error {
  constructor(
    public readonly conflictingFiles: string[],
    message?: string,
  ) {
    super(message ?? `Merge conflict in: ${conflictingFiles.join(', ')}`)
    this.name = 'MergeConflictError'
  }
}

/** Any merge that did not land for a reason other than a conflict. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeError'
  }
}

export interface MergeQueue {
  /**
   * Merge a worker's branch into the target branch, one merge at a time.
   * Commits anything the worker left uncommitted first. Throws
   * `MergeConflictError` on a conflict and `MergeError` on anything else —
   * a merge that did not land is never reported as one that did.
   */
  merge(worktreePath: string, worktreeBranch: string, targetBranch: string): Promise<MergeResult>
}

/** A promise chain: each merge waits for the previous one to settle. */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/**
 * Merges happen in `targetWorktree` — the convoy's own checkout of its branch —
 * never in the user's checkout.
 *
 * The old queue ran `git checkout <target>` and `git merge` in the main
 * repository with no lock. Eight tasks merging at once fought over
 * `index.lock` and `HEAD`; the losers were logged only with `--verbose`,
 * reported as merged, and their branches deleted. A dirty file in the user's
 * tree did the same to a single task.
 */
export function createMergeQueue(
  targetWorktree: string,
  opts: { worktreesDir?: string } = {},
): MergeQueue {
  const target = resolve(targetWorktree)
  const worktreesDir = resolve(opts.worktreesDir ?? join(target, '.opencastle', 'worktrees'))
  const serialize = createMutex()

  async function mergeOnce(
    worktreePath: string,
    worktreeBranch: string,
    targetBranch: string,
  ): Promise<MergeResult> {
    if (!isInside(worktreesDir, worktreePath)) {
      throw new Error(`Path "${worktreePath}" is outside the managed worktrees directory`)
    }

    try {
      await commitAllIn(resolve(worktreePath), `convoy: ${worktreeBranch} completed`)
    } catch (err) {
      throw new MergeError(`could not commit the task's work: ${firstLine((err as { stderr?: string }).stderr) || (err as Error).message}`)
    }

    try {
      const head = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], target)).trim()
      if (head !== targetBranch) await git(['checkout', '-q', targetBranch], target)
    } catch (err) {
      throw new MergeError(`could not check out ${targetBranch}: ${firstLine((err as { stderr?: string }).stderr) || (err as Error).message}`)
    }

    try {
      const stdout = await mergeIn(target, ['--no-edit', worktreeBranch])
      if (stdout.includes('Already up to date')) {
        return { success: true, conflicted: false, message: 'No changes to merge' }
      }
      return { success: true, conflicted: false, message: 'Merged successfully' }
    } catch (err) {
      const error = err as { code?: number | string; stderr?: string; stdout?: string; message?: string }
      const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
      let conflictingFiles: string[] = []
      if (text.includes('CONFLICT')) {
        try {
          conflictingFiles = (await git(['diff', '--name-only', '--diff-filter=U'], target))
            .split('\n').filter(Boolean)
        } catch { /* still abort below */ }
      }
      // Leave the integration checkout as it was before this merge, whatever
      // went wrong, so the next task's merge starts clean.
      try { await git(['merge', '--abort'], target) } catch { /* no merge in progress */ }
      if (text.includes('CONFLICT')) throw new MergeConflictError(conflictingFiles)
      throw new MergeError(firstLine(error.stderr) || firstLine(error.stdout) || error.message || 'git merge failed')
    }
  }

  return {
    merge: (worktreePath, worktreeBranch, targetBranch) =>
      serialize(() => mergeOnce(worktreePath, worktreeBranch, targetBranch)),
  }
}
