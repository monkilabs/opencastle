import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  blockRegions,
  orphanMarkers,
  cutBlockRegion,
  cutMarkerLine,
} from './managed-block.js'

// Exported so `doctor` can ask whether the entries it is complaining about sit
// inside a block this tool maintains — the answer decides which remedy it
// prints — rather than re-deriving the markers and drifting from them.
export const START_MARKER = '# >>> OpenCastle managed (do not edit) >>>'
export const END_MARKER = '# <<< OpenCastle managed <<<'

/**
 * What OpenCastle asks git to ignore — which is almost nothing.
 *
 * Generated assistant config used to be ignored wholesale, on the reasoning that
 * build output does not belong in git. That was wrong twice over. A teammate who
 * cloned the repo got no rules until they ran the tool, which defeats the point
 * of compiling one source into every assistant's format. And `sync --check` on a
 * clean CI checkout found no generated files at all, so the drift check this tool
 * ships could only ever fail.
 *
 * Generated config is committed, like a lockfile. What stays out is the genuinely
 * local: secrets and run artefacts.
 */
/**
 * Run artefacts, recreated by every `sync`.
 *
 * Listed here rather than inline so the ignore rules and the directories the
 * compiler creates cannot disagree — they did, and `doctor` failed on every
 * fresh clone as a result.
 */
export const LOCAL_DIRS = [
  '.opencastle/logs',
  '.opencastle/runs',
  '.opencastle/worktrees',
  '.opencastle/artifacts',
  '.opencastle/baselines',
]

const LOCAL_ONLY = [
  '.env',
  // Where `remove --all` parks your .opencastle/ so an uninstall is reversible.
  '.opencastle.removed/',
  '.opencastle.removed.*/',
  ...LOCAL_DIRS.map((d) => `${d}/`),
  '.opencastle/*.db',
  '.opencastle/*.db-wal',
  '.opencastle/*.db-shm',
  '.opencastle/*.ndjson',
]

// Deliberately NOT ignored: `<root>.opencastle-backup`. It is written when an
// upgrade replaces a root file an older release generated, and it is sometimes
// the only surviving copy of something the user wrote. Ignoring it hid it from
// `git status`, which left it one `git clean -xdf` from gone.

function buildBlock(): string {
  return [
    START_MARKER,
    '# Generated assistant config is committed on purpose, so teammates get',
    '# working rules on clone and `opencastle sync --check` can verify it in CI.',
    '# Only local artefacts are ignored.',
    ...LOCAL_ONLY,
    END_MARKER,
  ].join('\n')
}

/**
 * Create or update the project's `.gitignore` with OpenCastle entries.
 *
 * - If no `.gitignore` exists, creates one with the managed block.
 * - If `.gitignore` exists but has no OpenCastle block, appends it.
 * - If `.gitignore` already contains an OpenCastle block, replaces it
 *   (handles re-init or IDE switch cleanly).
 */
export async function updateGitignore(
  projectRoot: string
): Promise<'created' | 'updated' | 'unchanged'> {
  const gitignorePath = resolve(projectRoot, '.gitignore')
  const block = buildBlock()

  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, block + '\n', 'utf8')
    return 'created'
  }

  const existing = await readFile(gitignorePath, 'utf8')

  // Same region model as the root files, rather than a second reading of the
  // same idea. A doubled block — the "keep both sides" merge outcome — used to
  // survive every sync here and outlive an uninstall, leaving a file whose whole
  // contents were text this tool wrote.
  const regions = blockRegions(existing, START_MARKER, END_MARKER)
  if (regions.length > 0) {
    let collapsed = existing
    for (let i = regions.length - 1; i >= 1; i--) {
      collapsed = cutBlockRegion(collapsed, regions[i].start, regions[i].end)
    }
    const first = blockRegions(collapsed, START_MARKER, END_MARKER)[0]
    const updated = collapsed.slice(0, first.start) + block + collapsed.slice(first.end)

    if (updated === existing) return 'unchanged'
    await writeFile(gitignorePath, updated, 'utf8')
    return 'updated'
  }

  // Append block to existing file
  // One newline, same reasoning as the root-file merge: normalising the user's
  // file ending is information we cannot give back.
  await writeFile(gitignorePath, `${existing}\n${block}\n`, 'utf8')
  return 'updated'
}

/**
 * Remove the OpenCastle managed block from `.gitignore`.
 *
 * - No-op if no `.gitignore` exists or no block is present.
 * - Cleans up resulting double blank lines.
 * - Deletes `.gitignore` if the file becomes empty after removal.
 * - Returns 'removed' or 'unchanged'.
 */
/**
 * Every managed block and stray marker removed — the one implementation.
 *
 * `remove`'s preview used to predict this with a lazy regex of its own, which
 * matched a single block. On a `.gitignore` holding two (the "keep both sides"
 * merge outcome) the preview promised an edit and the action unlinked the file.
 */
function withoutManagedBlocks(content: string): string {
  let updated = content
  for (;;) {
    const regions = blockRegions(updated, START_MARKER, END_MARKER)
    if (regions.length === 0) break
    const r = regions[regions.length - 1]
    updated = cutBlockRegion(updated, r.start, r.end)
  }
  for (const at of orphanMarkers(updated, START_MARKER, END_MARKER).reverse()) {
    const len = updated.startsWith(START_MARKER, at) ? START_MARKER.length : END_MARKER.length
    updated = cutMarkerLine(updated, at, at + len)
  }
  return updated
}

/** What `removeGitignoreBlock` would leave behind, without writing anything. */
export async function predictGitignoreStrip(
  projectRoot: string,
): Promise<'deleted' | 'stripped' | 'absent'> {
  const path = resolve(projectRoot, '.gitignore')
  if (!existsSync(path)) return 'absent'

  const existing = await readFile(path, 'utf8')
  const remainder = withoutManagedBlocks(existing)
  if (remainder === existing) return 'absent'
  return remainder.trim() ? 'stripped' : 'deleted'
}

export async function removeGitignoreBlock(
  projectRoot: string
): Promise<'removed' | 'unchanged'> {
  const gitignorePath = resolve(projectRoot, '.gitignore')
  if (!existsSync(gitignorePath)) return 'unchanged'

  const existing = await readFile(gitignorePath, 'utf8')

  const updated = withoutManagedBlocks(existing)

  if (updated === existing) return 'unchanged'

  if (!updated.trim()) {
    const { unlink } = await import('node:fs/promises')
    await unlink(gitignorePath)
    return 'removed'
  }

  await writeFile(gitignorePath, updated, 'utf8')
  return 'removed'
}

