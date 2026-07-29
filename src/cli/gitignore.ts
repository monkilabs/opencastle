import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { UnreadableConfigError } from './types.js'
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
 * Read and written as bytes, like the root files — and for a sharper reason.
 *
 * A rule containing a byte that is not valid UTF-8 came back as U+FFFD, and a
 * pattern that has been re-spelled no longer matches: `secrets-café/` stopped
 * being ignored by `init` alone. Everything else in this file survives a
 * mangling as something a person can see; an ignore rule fails silently, and
 * the thing it was protecting gets committed.
 *
 * Both markers here are pure ASCII, so they need no conversion — but the
 * generated block does, since it is built from ordinary strings.
 */
async function readBytes(path: string): Promise<string> {
  return (await readFile(path)).toString('latin1')
}

async function writeBytes(path: string, bytes: string): Promise<void> {
  await writeFile(path, Buffer.from(bytes, 'latin1'))
}

function asBytes(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

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

/** A line only our generated block contains — the marker that it is ours. */
export const GENERATED_SENTINEL = 'Generated assistant config is committed on purpose'

/** Is a block of ours in this `.gitignore`, whatever state its markers are in? */
export function hasOurRules(content: string): boolean {
  return content.includes(GENERATED_SENTINEL)
}

export function buildBlock(): string {
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
/**
 * Which line indices belong to this tool.
 *
 * Line-based, and independent of the root files' `cutBlock`. Sharing that gave
 * `.gitignore` a heuristic about reclaiming blank lines that was designed for a
 * file whose block is *maintained in place*, and it welded `.env.local` into a
 * comment once already. Here the answer is simply: every line of a complete
 * block, and every marker line that pairs with nothing. Marker lines are text
 * this tool wrote; everything else is the user's and is returned untouched.
 */
function ourLineIndices(content: string): Set<number> {
  // A leading byte-order mark does not stop the first line being the first
  // line. Without this a BOM'd file's opening marker was not a marker, the
  // closing one looked unpaired, and `sync` inserted a second block leaving all
  // sixteen lines of the first orphaned — with every surface reporting health
  // and the copy surviving uninstall. The same hole `markerOffsets` was fixed
  // for two rounds ago, reintroduced in new code that had not learned it.
  const lines = splitLines(stripBom(content)).map((l) => l.text)
  const ours = new Set<number>()
  let openedAt: number | null = null
  for (const [i, line] of lines.entries()) {
    // `startsWith`, not equality — the same test `markerOffsets` applies. With
    // exact matching a line carrying our marker plus trailing text was not a
    // marker here and was one there, so the two readers disagreed about where a
    // block ended and this one swallowed a rule of the user's that sat between
    // them.
    if (line.startsWith(START_MARKER)) {
      // A second start before an end: the first one pairs with nothing.
      if (openedAt !== null) ours.add(openedAt)
      openedAt = i
    } else if (line.startsWith(END_MARKER)) {
      if (openedAt === null) {
        ours.add(i)
      } else {
        for (let k = openedAt; k <= i; k++) ours.add(k)
        openedAt = null
      }
    }
  }
  if (openedAt !== null) ours.add(openedAt)

  // Blank lines sitting *between* two things of ours are ours too.
  //
  // Nothing of the user's is adjacent to them — their nearest non-blank
  // neighbour is one of our lines in both directions — so claiming them takes
  // nothing that was written by anyone else. Without this, repairing a doubled
  // block left the separator between the two copies behind, and the user's file
  // came back from an uninstall one blank line longer than it went in.
  for (const [i, line] of lines.entries()) {
    if (ours.has(i) || line.trim() !== '') continue
    let before = i - 1
    while (before >= 0 && lines[before].trim() === '') before--
    let after = i + 1
    while (after < lines.length && lines[after].trim() === '') after++
    if (before >= 0 && after < lines.length && ours.has(before) && ours.has(after)) {
      ours.add(i)
    }
  }
  return ours
}

/**
 * Split into lines while keeping each line's own terminator.
 *
 * `split('\n')` was not enough. A file saved with classic Mac endings has no
 * `\n` at all, so the whole thing was one "line" — it began with our start
 * marker, so the entire file was classified as ours and every rule the user had
 * written was replaced by the block, with no backup, under a "✓ Updated" line.
 * `markerOffsets` had already been hardened for this exact alphabet entry; the
 * reader beside it had not.
 *
 * Terminators are carried rather than normalised, so rejoining is byte-exact
 * and a CRLF file stays CRLF.
 */
function splitLines(content: string): Array<{ text: string; eol: string }> {
  const out: Array<{ text: string; eol: string }> = []
  const re = /\r\n|\n|\r/g
  let at = 0
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    out.push({ text: content.slice(at, m.index), eol: m[0] })
    at = m.index + m[0].length
  }
  out.push({ text: content.slice(at), eol: '' })
  return out
}

function joinLines(lines: Array<{ text: string; eol: string }>): string {
  return lines.map((l) => l.text + l.eol).join('')
}

/** The lines present in `before` and absent from `after`, with multiplicity. */
function removedLines(before: string, after: string): string[] {
  const left = new Map<string, number>()
  for (const line of splitLines(after)) left.set(line.text, (left.get(line.text) ?? 0) + 1)
  const gone: string[] = []
  for (const { text: line } of splitLines(before)) {
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else gone.push(line)
  }
  return gone
}

/** Everything in `content` that is not ours, in order, byte for byte. */
/** A leading BOM removed, so the first line is testable like any other. */
function stripBom(content: string): string {
  if (content.startsWith(BOM_BYTES)) return content.slice(BOM_BYTES.length)
  return content.startsWith('\ufeff') ? content.slice(1) : content
}

const BOM_BYTES = Buffer.from('\ufeff', 'utf8').toString('latin1')

function withoutOurLines(content: string): string {
  const ours = ourLineIndices(content)
  if (ours.size === 0) return content
  return joinLines(splitLines(content).filter((_, i) => !ours.has(i)))
}

/**
 * The file as it should look: every line of the user's where they put it, and
 * exactly one current block where the first of ours was.
 *
 * Composed rather than patched, which is the point of this rewrite. Our block
 * here is a *constant* — `buildBlock()` takes no arguments and holds nothing
 * per-project — so there is never anything inside it worth preserving, and
 * rebuilding it is always correct. That removes the entire class of defects
 * this file kept producing: no region to maintain, so no collapse, no promotion
 * of stray markers, no `torn`/`severed`/`unreducible` states, and nothing for
 * two readers to disagree about.
 *
 * The block goes back where it was, not at the end. Moving it would relocate
 * every rule the user had written *below* it, which is both a change to their
 * file and a difference the comparison would report forever.
 *
 * The worst case of getting it wrong is also different from a root file's. A
 * stale instruction set left in a root file is two sets of rules the assistant
 * obeys; a stale *ignore rule* left here is a duplicate line git does not care
 * about. So this never refuses to write — it always converges in one run, which
 * is what every earlier version could not promise.
 */
function compose(content: string, block: string): string {
  const ours = ourLineIndices(content)
  const lines = splitLines(content)
  // The terminator the file already uses, so a CRLF file stays CRLF.
  const eol = lines.find((l) => l.eol !== '')?.eol ?? '\n'
  const blockLines = block.split('\n').map((text) => ({ text, eol }))

  if (ours.size === 0) {
    // A terminator first if the file has none. `content.endsWith(lastLine.eol)`
    // was the test, and `eol` is the empty string for a file that does not end
    // in one — so it was always true, no separator was added, and the block was
    // concatenated straight onto the user's last rule: `node_modules# >>> …`.
    const body = content === '' || /(\r\n|\n|\r)$/.test(content) ? content : content + eol
    return body + block.split('\n').join(eol) + eol
  }

  const firstOurs = Math.min(...ours)
  const out: Array<{ text: string; eol: string }> = []
  for (const [i, line] of lines.entries()) {
    if (i === firstOurs) out.push(...blockLines)
    if (!ours.has(i)) out.push(line)
  }
  return joinLines(out)
}

export async function updateGitignore(
  projectRoot: string,
): Promise<'created' | 'updated' | 'unchanged' | 'repaired'> {
  const gitignorePath = resolve(projectRoot, '.gitignore')
  const block = asBytes(buildBlock())

  if (!existsSync(gitignorePath)) {
    await writeBytes(gitignorePath, compose('', block))
    return 'created'
  }

  // Guarded like every other read of a user file. Unguarded, `sync` and
  // `remove` both died on `✗ EISDIR` with no path in it — and `remove` could
  // not uninstall at all — while `doctor`, reading the same file three lines
  // away, named it correctly.
  let raw: string
  try {
    raw = await readBytes(gitignorePath)
  } catch (err) {
    throw new UnreadableConfigError('.gitignore', 'unreadable')
  }
  // Split off a leading BOM and put it back at the end. It belongs to the file
  // rather than to any line, and if it happened to sit in front of one of our
  // markers, removing that line would otherwise take the BOM with it.
  const bom = raw.startsWith(BOM_BYTES) ? BOM_BYTES : ''
  const existing = bom ? raw.slice(bom.length) : raw
  const residue = withoutOurLines(existing)
  const next = bom + compose(existing, block)

  // Compared against the file as it was read, BOM included — and, failing that,
  // against the question every surface asks. `gitignoreNeedsRebuild` normalises
  // line endings and this did not, so a CRLF checkout was green on both
  // surfaces while `sync` rewrote the file anyway: a CI job of the shape this
  // branch recommends (`sync` then `git diff --exit-code`) failed where the
  // shipped gate passed.
  if (next === raw) return 'unchanged'
  if (gitignoreNeedsRebuild(raw) === '') return 'unchanged'

  // A backup whenever we take away a line that is not ours to take.
  //
  // "Ours" is a marker line or a line of the block we write — asked directly,
  // not inferred from how many lines went. Counting them was a first-case-only
  // assumption: it compared against the *current* block's length, and every
  // release before 0.36 wrote a shorter one. Upgrading such a project therefore
  // removed fewer lines than today's block has, the test said "nothing unusual",
  // and a rule the user had put inside that block went silently, with no backup
  // — which is precisely the failure this file's own header calls unacceptable,
  // because a dropped ignore rule is a committed secret.
  const ownLines = new Set(block.split('\n'))
  const taken = removedLines(existing, residue).filter(
    (line) => !ownLines.has(line) && !line.startsWith(START_MARKER) && !line.startsWith(END_MARKER),
  )
  const repaired = taken.length > 0
  if (repaired) await writeBytes(`${gitignorePath}.opencastle-backup`, raw)

  await writeBytes(gitignorePath, next)
  return repaired ? 'repaired' : 'updated'
}

/** What `removeGitignoreBlock` would leave behind, without writing anything. */
export async function predictGitignoreStrip(
  projectRoot: string,
): Promise<'deleted' | 'stripped' | 'absent'> {
  const path = resolve(projectRoot, '.gitignore')
  if (!existsSync(path)) return 'absent'

  const existing = await readBytes(path)
  const remainder = withoutOurLines(existing)
  if (remainder === existing) return 'absent'
  return remainder.trim() ? 'stripped' : 'deleted'
}

/**
 * Take every line of ours back out.
 *
 * The same function the preview uses, on the same bytes — these diverged twice
 * before, once leaving the user with a deleted file the preview had promised to
 * keep.
 */
export async function removeGitignoreBlock(
  projectRoot: string,
): Promise<'removed' | 'unchanged'> {
  const gitignorePath = resolve(projectRoot, '.gitignore')
  if (!existsSync(gitignorePath)) return 'unchanged'

  const existing = await readBytes(gitignorePath)
  const updated = withoutOurLines(existing)
  if (updated === existing) return 'unchanged'

  if (updated.trim().length === 0) {
    const { rm } = await import('node:fs/promises')
    await rm(gitignorePath, { force: true })
    return 'removed'
  }

  await writeBytes(gitignorePath, updated)
  return 'removed'
}


/**
 * Why `.gitignore` would be rewritten, or empty when it is already right.
 *
 * The single reader every surface shares — `doctor`, `sync --check` and the
 * status line. They each used to work this out for themselves and disagreed in
 * every combination: one red while another was green, a remedy that was a
 * no-op, a state reported by nothing. There is one question here and now one
 * function answering it.
 *
 * Line endings are normalised for the comparison, because a Git for Windows
 * checkout rewrites the committed file to CRLF and a byte comparison made every
 * such clone permanently red with a fix that produced nothing to commit.
 */
export function gitignoreNeedsRebuild(content: string): string {
  const normalise = (s: string): string => s.replace(/\r\n/g, '\n')
  const current = normalise(content)
  const wanted = compose(current, buildBlock())
  if (current === wanted) return ''

  const lines = splitLines(current).map((l) => l.text)
  const starts = lines.filter((l) => l === START_MARKER).length
  const ends = lines.filter((l) => l === END_MARKER).length
  if (starts === 0 && ends === 0) {
    return '.gitignore has no OpenCastle block — .env and the run artefacts are not ignored'
  }
  if (starts !== 1 || ends !== 1) {
    return `.gitignore has ${starts} start and ${ends} end marker(s) — its ignore rules may not be in force`
  }
  return '.gitignore\'s OpenCastle block is out of date'
}
