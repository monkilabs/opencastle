import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const START_MARKER = '# >>> OpenCastle managed (do not edit) >>>'
const END_MARKER = '# <<< OpenCastle managed <<<'

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
const LOCAL_ONLY = [
  '.env',
  '.opencastle/logs/',
  '.opencastle/runs/',
  '.opencastle/worktrees/',
  '.opencastle/artifacts/',
  '.opencastle/baselines/',
  '.opencastle/*.db',
  '.opencastle/*.db-wal',
  '.opencastle/*.db-shm',
  '.opencastle/*.ndjson',
]

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

  // Replace existing block
  const startIdx = existing.indexOf(START_MARKER)
  const endIdx = existing.indexOf(END_MARKER)

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx)
    const after = existing.slice(endIdx + END_MARKER.length)
    const updated = before + block + after

    if (updated === existing) return 'unchanged'

    await writeFile(gitignorePath, updated, 'utf8')
    return 'updated'
  }

  // Append block to existing file
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  await writeFile(gitignorePath, existing + separator + block + '\n', 'utf8')
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
export async function removeGitignoreBlock(
  projectRoot: string
): Promise<'removed' | 'unchanged'> {
  const gitignorePath = resolve(projectRoot, '.gitignore')
  if (!existsSync(gitignorePath)) return 'unchanged'

  const existing = await readFile(gitignorePath, 'utf8')
  const startIdx = existing.indexOf(START_MARKER)
  const endIdx = existing.indexOf(END_MARKER)

  if (startIdx === -1 || endIdx === -1) return 'unchanged'

  const before = existing.slice(0, startIdx)
  const after = existing.slice(endIdx + END_MARKER.length)

  // Collapse consecutive blank lines left by removal
  const updated = (before + after).replace(/\n{3,}/g, '\n\n').trimEnd()

  if (!updated) {
    const { unlink } = await import('node:fs/promises')
    await unlink(gitignorePath)
    return 'removed'
  }

  await writeFile(gitignorePath, updated + '\n', 'utf8')
  return 'removed'
}
