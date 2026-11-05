import { statSync, realpathSync, lstatSync, readlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, normalize, join, resolve, sep } from 'node:path'
import type { Task } from './spec-types.js'

// ── Path normalization ────────────────────────────────────────────────────────

/**
 * Normalize a file path for partition comparison.
 * - Rejects glob patterns (* or ?)
 * - Strips leading ./ and /
 * - Replaces backslashes with forward slashes
 * - Resolves . and .. via path.normalize()
 * - Preserves trailing slash for directories
 */
export function normalizePath(p: string): string {
  if (p.includes('*') || p.includes('?')) {
    throw new Error(`Glob patterns are not allowed in file paths: "${p}"`)
  }

  // Record whether the path indicates a directory (trailing slash)
  const hasTrailingSlash = p.endsWith('/') || p.endsWith('\\')

  // Normalize separators to forward slash
  let result = p.replace(/\\/g, '/')

  // Strip trailing slashes before further processing
  result = result.replace(/\/+$/, '')

  // Strip leading './' (may be multiple, e.g. '././')
  result = result.replace(/^(\.\/)+/, '')

  // Strip leading '/'
  result = result.replace(/^\/+/, '')

  // Reject any .. path segment — even those that would not escape the root.
  // All usage of .. is rejected for safety, not just escaping traversals.
  if (/(^|\/)\.\.(\/|$)/.test(result)) {
    throw new Error(`Path traversal detected: "${p}" resolves to a path containing ".." segments`)
  }

  // Resolve '.' and '..' segments
  result = normalize(result).replace(/\\/g, '/')

  // normalize can introduce leading './' (e.g. for '.') — strip it again
  result = result.replace(/^(\.\/)+/, '')
  result = result.replace(/^\/+/, '')

  // Restore trailing slash for directories (but not when result is '.' or empty)
  if (hasTrailingSlash && result !== '.' && result !== '') {
    result += '/'
  }

  return result
}

// ── Overlap detection ─────────────────────────────────────────────────────────

/**
 * Returns true if path a and path b overlap (exact match or prefix containment).
 * Example: 'src/auth/' overlaps 'src/auth/service.ts' in both directions.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  // Treat each path as a potential directory prefix
  const aDir = a.endsWith('/') ? a : a + '/'
  const bDir = b.endsWith('/') ? b : b + '/'
  return b.startsWith(aDir) || a.startsWith(bDir)
}

// ── Partition validation ──────────────────────────────────────────────────────

export interface PartitionConflict {
  phase: number
  taskA: string
  taskB: string
  overlapping: string[]
}

export interface PartitionValidationResult {
  valid: boolean
  conflicts: PartitionConflict[]
}

/**
 * Validate that tasks within the same parallel phase do not have overlapping file partitions.
 * Tasks in different phases (sequential) are allowed to share files.
 */
export function validateFilePartitions(
  _tasks: Task[],
  phases: Task[][],
): PartitionValidationResult {
  const isCaseSensitive = determineFsCaseSensitivity()
  const conflicts: PartitionConflict[] = []

  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
    const phaseTasks = phases[phaseIdx]
    for (let i = 0; i < phaseTasks.length; i++) {
      for (let j = i + 1; j < phaseTasks.length; j++) {
        const taskA = phaseTasks[i]
        const taskB = phaseTasks[j]

        // Empty files arrays are not partitioned — skip
        if (!taskA.files.length || !taskB.files.length) continue

        const normalizedA = taskA.files.map(normalizePath)
        const normalizedB = taskB.files.map(normalizePath)
        const overlapping: string[] = []

        for (const fileA of normalizedA) {
          for (const fileB of normalizedB) {
            const directOverlap = pathsOverlap(fileA, fileB)
            // On case-insensitive filesystems, also check lowercased paths
            const ciOverlap =
              !isCaseSensitive && pathsOverlap(fileA.toLowerCase(), fileB.toLowerCase())
            if ((directOverlap || ciOverlap) && !overlapping.includes(fileA)) {
              overlapping.push(fileA)
            }
          }
        }

        if (overlapping.length > 0) {
          conflicts.push({ phase: phaseIdx, taskA: taskA.id, taskB: taskB.id, overlapping })
        }
      }
    }
  }

  return { valid: conflicts.length === 0, conflicts }
}

// ── Filesystem case-sensitivity probe ────────────────────────────────────────

/**
 * Probe whether the filesystem is case-sensitive by creating a mixed-case temp file
 * and checking if the lowercase path resolves to the same inode.
 *
 * Uses realpathSync per LES-003: on macOS, os.tmpdir() returns /var/... which is a
 * symlink to /private/var/... — realpathSync resolves this to the canonical path.
 *
 * Returns true if case-sensitive (git-compatible default), false if case-insensitive.
 */
export function determineFsCaseSensitivity(): boolean {
  const base = realpathSync(tmpdir())
  const mixedCase = join(base, `OpenCastle_CaseSensitivity_${Date.now()}`)
  const lowerCase = mixedCase.toLowerCase()

  try {
    writeFileSync(mixedCase, '')
    try {
      const statMixed = statSync(mixedCase)
      const statLower = statSync(lowerCase)
      // Same inode → same file → case-insensitive
      return statMixed.ino !== statLower.ino
    } catch {
      // stat(lowerCase) threw → file not found at lowercase path → case-sensitive
      return true
    }
  } finally {
    try { rmSync(mixedCase) } catch { /* ignore cleanup errors */ }
  }
}

// ── Symlink security scan ─────────────────────────────────────────────────────

/**
 * Where a write through the link at `absLink` lands, every link on the way
 * followed. A link to something not there yet (a build output, say) lands
 * where its target would be created. Null when even that cannot be told.
 */
function linkTarget(absLink: string): string | null {
  try {
    return realpathSync(absLink)
  } catch { /* a link to nothing yet */ }
  let target: string
  try {
    target = resolve(dirname(absLink), readlinkSync(absLink))
  } catch {
    return null
  }
  const missing: string[] = []
  for (let dir = target; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...missing)
    } catch { /* not there either: try its parent */ }
    if (dirname(dir) === dir) return null
    missing.unshift(basename(dir))
  }
}

/** The first of `paths` (relative to `realBase`) that is a symlink leading out of it. */
function escapingLink(realBase: string, paths: Iterable<string>): { path: string; resolved: boolean } | null {
  for (const rel of paths) {
    const abs = join(realBase, rel)
    try {
      if (!lstatSync(abs).isSymbolicLink()) continue
    } catch {
      continue // not there (yet)
    }
    const target = linkTarget(abs)
    if (target === null) return { path: rel, resolved: false }
    if (target !== realBase && !target.startsWith(realBase + sep)) return { path: rel, resolved: true }
  }
  return null
}

/** The directories above a path: `a/b/c` → `a`, `a/b`. */
function parentsOf(rel: string): string[] {
  const parts = rel.replace(/\/+$/, '').split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/**
 * Before task execution: no declared path may lead out of `basePath` through a
 * symlink. Checked are the declared paths, the directories above them, and
 * each of `trackedLinks` (the links git tracks, from the worktree) inside a
 * declared directory, since a write through any of them lands wherever the
 * link points. Throws symlink_escape.
 */
export function scanSymlinks(files: string[], basePath: string, trackedLinks: string[] = []): void {
  const realBase = realpathSync(resolve(basePath))
  const declared = files.map(normalizePath)
  const links = trackedLinks.filter(link => declared.some(file => pathsOverlap(file, link)))
  const bad = escapingLink(realBase, new Set([...declared, ...declared.flatMap(parentsOf), ...links]))
  if (!bad) return
  throw new Error(bad.resolved
    ? `symlink_escape: "${bad.path}" is a symlink that resolves outside the partition`
    : `symlink_escape: symlink at "${bad.path}" could not be resolved`)
}

/**
 * After task execution: no new symlink may lead out of the worktree. Checked
 * are the declared paths and every path in `changed` (what the task's commit
 * changed, from git), so a link added inside a declared directory, or outside
 * the task's paths altogether, is found too: all of it merges.
 * Throws symlink_escape_post_task.
 */
export function scanNewSymlinks(worktreePath: string, files: string[], changed: string[] = []): void {
  const realBase = realpathSync(resolve(worktreePath))
  const bad = escapingLink(realBase, new Set([...files.map(normalizePath), ...changed]))
  if (!bad) return
  throw new Error(bad.resolved
    ? `symlink_escape_post_task: "${bad.path}" is a new symlink that escapes the partition`
    : `symlink_escape_post_task: "${bad.path}" is a new symlink that cannot be resolved`)
}
