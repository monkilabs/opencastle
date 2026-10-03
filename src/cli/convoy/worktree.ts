import { execFile as execFileCb } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, basename, dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/**
 * Git worktrees for a convoy.
 *
 * Every worktree — the convoy's own integration checkout and each task's —
 * lives directly under `<repo>/.opencastle/worktrees/`, created from the main
 * repository with a short name. They used to nest (a task's worktree inside the
 * convoy's, each named with a 13-digit timestamp), which put ~100 characters in
 * front of every path in the repo and broke Windows' 260-character limit.
 * Staying inside the repository keeps npm's walk up to the project's
 * node_modules working for gates run in a worktree.
 */

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  /** git marks a worktree whose directory has gone as prunable. */
  prunable?: boolean
}

/** What a task changed since its worktree was created. */
export interface WorktreeChanges {
  files: string[]
  diff: string
}

export interface WorktreeManager {
  /** Create a worktree on a new branch `convoy-<workerId>` starting at `featureBranch`. */
  create(workerId: string, featureBranch: string): Promise<string>
  /** Remove a worktree; its branch goes too unless `keepBranch` — kept when its work could not be merged. */
  remove(worktreePath: string, opts?: { keepBranch?: boolean }): Promise<void>
  list(): Promise<WorktreeInfo[]>
  /** Remove every managed worktree except the paths in `except`. */
  removeAll(opts?: { except?: string[] }): Promise<void>
  /**
   * Commit everything in a worktree. Returns true when a commit was made.
   * Optional so a test double can leave git out entirely.
   */
  commitAll?(worktreePath: string, message: string): Promise<boolean>
  /** The commit a worktree's HEAD points at. */
  head?(worktreePath: string): Promise<string | null>
  /** Files and diff between `sinceRef` and the worktree's HEAD. */
  changes?(worktreePath: string, sinceRef: string): Promise<WorktreeChanges | null>
}

/** The branch name a worker's worktree is created on. */
export function workerBranchName(workerId: string): string {
  return `convoy-${workerId}`
}

/** Absolute path of the directory every managed worktree lives in. */
export function worktreesDirFor(repoRoot: string): string {
  return join(resolve(repoRoot), '.opencastle', 'worktrees')
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** True when `child` is inside `parent`, on either path separator. */
export function isInside(parent: string, child: string): boolean {
  const p = realOrResolved(parent)
  const c = realOrResolved(child)
  return c.startsWith(p + sep) || c.startsWith(p + '/')
}

// ── git, with an identity when the user has none ────────────────────────────

let identityKnown: boolean | null = null

/**
 * Run git. A commit or merge on a machine with no `user.email` (a CI box, a
 * fresh container) used to fail the task outright; the convoy signs as itself
 * there, and only there.
 */
/**
 * git refuses a command, before doing anything, when another git process holds
 * a lock it needs — the index, a ref, packed-refs. Tasks create and remove
 * worktrees and branches in one repository at the same moment, so a refusal is
 * contention, not a fault, and a moment later the command goes through.
 */
const LOCK_CONTENTION = /\.lock'?: File exists|Unable to create '[^']*\.lock'|cannot lock ref|could not lock config file|failed to read \S*worktrees\/\S*\/(commondir|gitdir)/i

/**
 * One worktree command at a time per repository.
 *
 * `git worktree add` reads every other worktree's entry under .git/worktrees/,
 * and one being written by a concurrent add is half there: with eight tasks
 * starting together, two failed "Could not create a worktree: fatal: failed to
 * read .git/worktrees/<other>/commondir". Adding, removing and listing
 * worktrees, and deleting branches, now queue per repository. Each takes
 * milliseconds; the agents still run side by side.
 */
const repoQueues = new Map<string, Promise<unknown>>()

function changesWorktrees(args: string[]): boolean {
  return args[0] === 'worktree' || (args[0] === 'branch' && (args.includes('-D') || args.includes('-d')))
}

export async function git(args: string[], cwd: string): Promise<string> {
  if (!changesWorktrees(args)) return runGit(args, cwd)
  const key = realOrResolved(cwd)
  const prev = repoQueues.get(key) ?? Promise.resolve()
  const next = prev.then(() => runGit(args, cwd), () => runGit(args, cwd))
  repoQueues.set(key, next.catch(() => undefined))
  return next
}

async function runGit(args: string[], cwd: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
      return stdout
    } catch (err) {
      const text = `${(err as { stderr?: string }).stderr ?? ''}\n${(err as Error).message}`
      if (attempt >= 6 || !LOCK_CONTENTION.test(text)) throw err
      await new Promise((r) => setTimeout(r, 40 * 2 ** attempt + Math.random() * 40))
    }
  }
}

async function gitWithIdentity(args: string[], cwd: string): Promise<string> {
  if (identityKnown === null) {
    try {
      await execFile('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd })
      identityKnown = true
    } catch {
      identityKnown = false
    }
  }
  const prefix = identityKnown ? [] : ['-c', 'user.name=OpenCastle convoy', '-c', 'user.email=convoy@opencastle.invalid']
  return git([...prefix, ...args], cwd)
}

/**
 * Stage and commit everything in `cwd`. Returns true when there was something
 * to commit.
 *
 * `--no-verify`: this is the convoy's bookkeeping commit inside its own
 * worktree, and the checks it cares about run as gates, with their output fed
 * back to the agent. A project's pre-commit hook (lint-staged and the like) is
 * for the commit a person makes when they merge the convoy branch.
 */
export async function commitAllIn(cwd: string, message: string): Promise<boolean> {
  await git(['add', '-A'], cwd)
  const staged = await git(['diff', '--cached', '--name-only'], cwd)
  if (!staged.trim()) return false
  await gitWithIdentity(['commit', '-q', '--no-verify', '-m', message], cwd)
  return true
}

/** `git merge` with the convoy's fallback identity. */
export async function mergeIn(cwd: string, args: string[]): Promise<string> {
  return gitWithIdentity(['merge', ...args], cwd)
}

export function parseWorktreeList(output: string): WorktreeInfo[] {
  const results: WorktreeInfo[] = []
  const blocks = output.trim().split(/\n\n+/).filter(Boolean)
  for (const block of blocks) {
    let path = ''
    let head = ''
    let branch = ''
    let prunable = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length)
      else if (line.startsWith('prunable')) prunable = true
    }
    if (path) results.push({ path, branch, head, prunable })
  }
  return results
}

/** Every worktree of the repository, the main checkout first. */
export async function listAllWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  return parseWorktreeList(await git(['worktree', 'list', '--porcelain'], repoRoot))
}

export function createWorktreeManager(repoRoot: string): WorktreeManager {
  const resolvedBase = realpathSync(resolve(repoRoot))
  const worktreesDir = worktreesDirFor(resolvedBase)

  async function create(workerId: string, featureBranch: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(workerId)) {
      throw new Error(
        `Invalid workerId "${workerId}": must only contain alphanumeric characters, hyphens, and underscores`,
      )
    }
    const worktreePath = join(worktreesDir, workerId)
    mkdirSync(worktreesDir, { recursive: true })
    await git(['worktree', 'add', '-q', worktreePath, '-b', workerBranchName(workerId), featureBranch], resolvedBase)
    return worktreePath
  }

  async function remove(worktreePath: string, opts: { keepBranch?: boolean } = {}): Promise<void> {
    const resolved = realOrResolved(worktreePath)
    if (!resolved.startsWith(realOrResolved(worktreesDir) + sep)) {
      throw new Error(`Path "${worktreePath}" is outside the managed worktrees directory`)
    }
    const workerId = basename(resolved)
    try {
      await git(['worktree', 'remove', resolved, '--force'], resolvedBase)
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (!stderr.includes('is not a working tree')) throw err
    }
    if (opts.keepBranch) return
    try {
      await git(['branch', '-D', workerBranchName(workerId)], resolvedBase)
    } catch {
      // Branch may already be deleted — ignore
    }
  }

  async function list(): Promise<WorktreeInfo[]> {
    const all = await listAllWorktrees(resolvedBase)
    const dir = realOrResolved(worktreesDir)
    return all.filter((w) => realOrResolved(w.path).startsWith(dir + sep))
  }

  async function removeAll(opts: { except?: string[] } = {}): Promise<void> {
    const keep = new Set((opts.except ?? []).map(realOrResolved))
    for (const wt of await list()) {
      if (keep.has(realOrResolved(wt.path))) continue
      await remove(wt.path)
    }
    // A directory deleted by hand leaves its registration behind, and git then
    // refuses to check its branch out anywhere else.
    try { await git(['worktree', 'prune'], resolvedBase) } catch { /* nothing to prune */ }
  }

  async function commitAll(worktreePath: string, message: string): Promise<boolean> {
    return commitAllIn(worktreePath, message)
  }

  async function head(worktreePath: string): Promise<string | null> {
    try {
      return (await git(['rev-parse', 'HEAD'], worktreePath)).trim() || null
    } catch {
      return null
    }
  }

  async function changes(worktreePath: string, sinceRef: string): Promise<WorktreeChanges | null> {
    try {
      const files = (await git(['diff', '--name-only', `${sinceRef}..HEAD`], worktreePath))
        .split('\n').map((s) => s.trim()).filter(Boolean)
      const diff = await git(['diff', `${sinceRef}..HEAD`], worktreePath)
      return { files, diff }
    } catch {
      return null
    }
  }

  return { create, remove, list, removeAll, commitAll, head, changes }
}

// ── The convoy's integration checkout ───────────────────────────────────────

export class BranchInUseError extends Error {
  constructor(public readonly branch: string, public readonly path: string) {
    super(
      `Branch "${branch}" is checked out at ${path}.\n` +
        `    A convoy merges into its branch in a checkout of its own. Switch that ` +
        `checkout to another branch, then run again.`,
    )
    this.name = 'BranchInUseError'
  }
}

/**
 * Check `branch` out in the convoy's integration worktree, creating the branch
 * from `base` when it does not exist yet.
 *
 * A worktree left behind by a killed run is reused: its unfinished merge is
 * aborted and it is reset to the branch tip, which holds every merge that
 * completed. One whose directory has gone is pruned first. Either used to make
 * `resume` fail with "'<branch>' is already used by worktree".
 */
export async function ensureRootWorktree(opts: {
  repoRoot: string
  branch: string
  base: string
  dirName: string
}): Promise<string> {
  const repoRoot = realOrResolved(opts.repoRoot)
  const worktreesDir = worktreesDirFor(repoRoot)
  const target = join(worktreesDir, opts.dirName)
  const ref = `refs/heads/${opts.branch}`

  let worktrees = await listAllWorktrees(repoRoot)
  if (worktrees.some((w) => w.branch === ref && (w.prunable || !existsSync(w.path)))) {
    await git(['worktree', 'prune'], repoRoot)
    worktrees = await listAllWorktrees(repoRoot)
  }

  const holder = worktrees.find((w) => w.branch === ref)
  if (holder) {
    if (!isInside(worktreesDir, holder.path)) throw new BranchInUseError(opts.branch, holder.path)
    try { await git(['merge', '--abort'], holder.path) } catch { /* no merge in progress */ }
    await git(['reset', '-q', '--hard', 'HEAD'], holder.path)
    await git(['clean', '-q', '-fd'], holder.path)
    return holder.path
  }

  mkdirSync(dirname(target), { recursive: true })
  let exists = true
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], repoRoot)
  } catch {
    exists = false
  }
  if (exists) {
    await git(['worktree', 'add', '-q', target, opts.branch], repoRoot)
  } else {
    await git(['worktree', 'add', '-q', '-b', opts.branch, target, opts.base], repoRoot)
  }
  return target
}

/** Remove the integration worktree. The branch stays: it is the result. */
export async function removeRootWorktree(repoRoot: string, path: string): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', path], realOrResolved(repoRoot))
  } catch {
    try { await git(['worktree', 'prune'], realOrResolved(repoRoot)) } catch { /* ignore */ }
  }
}

/**
 * The repository's main checkout — where `.opencastle/` belongs — even when
 * `cwd` is a worktree. Logs written inside a worktree vanished with it.
 */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
  try {
    const top = (await git(['rev-parse', '--show-toplevel'], cwd)).trim()
    const list = await listAllWorktrees(top)
    return list[0]?.path ?? top
  } catch {
    return null
  }
}

/** The branch checked out at `cwd`, or its commit when HEAD is detached. */
export async function currentRef(cwd: string): Promise<string | null> {
  try {
    const name = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    if (name && name !== 'HEAD') return name
    return (await git(['rev-parse', 'HEAD'], cwd)).trim() || null
  } catch {
    return null
  }
}
