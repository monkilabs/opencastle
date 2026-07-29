import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  updateGitignore,
  removeGitignoreBlock,
  predictGitignoreStrip,
  gitignoreNeedsRebuild,
  START_MARKER,
  END_MARKER,
} from './gitignore.js'
import { blockRegions, orphanMarkers } from './managed-block.js'

/**
 * The same invariants the root file gets, on the file that had none.
 *
 * `.gitignore` is the one co-owned file whose loss cannot be noticed by reading
 * it — a rule silently dropped is a secret committed — and it was the one with
 * no backup and no property coverage. Two ordinary syncs removed `.env.local`
 * from a file that had been protecting it, with `sync --check` and `doctor`
 * green on both sides of the loss.
 *
 * `git check-ignore` is the oracle for the rules, not string matching: only git
 * knows what a pattern matches.
 */

// Negations are the point: `!keep.txt` only exempts anything if it comes *after*
// the pattern it exempts, so a rule that survives in the wrong position is still
// a behaviour change. Nothing here may move.
// Concrete file paths, never a bare directory with a trailing slash:
// `check-ignore` answers oddly for those — it reported `dist/` as matched by an
// empty pattern on a CRLF file — and the question here is about files anyway.
const RULES = [
  'node_modules/x',
  '.env.local',
  'secrets/prod.key',
  'dist/x',
  'a.tmp',
  'keep.txt',
  'logs/a.log',
]

const PIECES = [
  'node_modules\n',
  '*.txt\n',
  '!keep.txt\n',
  'logs/\n',
  '!logs/a.log\n',
  '.env.local\n',
  'secrets/prod.key\n',
  'dist/\n',
  '*.tmp\n',
  '\n',
  '# a comment of mine\n',
  `${START_MARKER}\n`,
  `${END_MARKER}\n`,
  `${START_MARKER}\n.env\n${END_MARKER}\n`,
  `${END_MARKER}\n${START_MARKER}\n`,
  // A block from a release that ignored the generated config — the population
  // `doctor`'s "generated config is committed" check exists for, and the shape
  // that made that check fail forever on a remedy which could not run.
  `${START_MARKER}\n.claude/\nCLAUDE.md\n.cursor/\n${END_MARKER}\n`,
  `  ${START_MARKER}\n`,
  `${START_MARKER} trailing\n`,
]

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function makeFile(seed: number): string {
  const rand = lcg(seed)
  const count = 1 + Math.floor(rand() * 12)
  let text = ''
  for (let i = 0; i < count; i++) text += PIECES[Math.floor(rand() * PIECES.length)]
  // Line endings are part of the alphabet, not a detail. A classic-Mac file has
  // no `\n` at all, which made the whole file read as one line and every rule
  // in it ours; and a file with no terminator at the end had the block
  // concatenated onto its last rule. Both shipped and both were found here.
  const r = rand()
  if (r < 0.15) text = text.replace(/\n/g, '\r\n')
  else if (r < 0.3) text = text.replace(/\n/g, '\r')
  else if (r < 0.65) {
    // Mixed line by line, which converting the whole file at once cannot
    // produce — and a file that mixes endings is ordinary: a CRLF checkout with
    // one line appended by a Unix script. Three defects hid behind the uniform
    // alphabet. The block took its ending from the file's *first* terminator,
    // which in a mixed file is arbitrary; a `\r` written in front of a surviving
    // `\n` re-read as one CRLF, so `sync` twice gave two different files; and
    // the checker normalised CRLF before composing, so it picked a different
    // ending than the writer and reported drift `sync` would not clear.
    text = text.replace(/\n/g, () => {
      const p = rand()
      return p < 0.34 ? '\n' : p < 0.67 ? '\r\n' : '\r'
    })
  }
  if (rand() < 0.25) text = text.replace(/(\r\n|\n|\r)$/, '')
  return text
}

/**
 * A leading byte-order mark, which is the only place a BOM can be.
 *
 * Kept out of `makeFile` because the rule-preservation test does its own line
 * bookkeeping and a mark in front of a marker belongs to neither side of it.
 */
function withBom(seed: number, text: string): string {
  return lcg(seed * 7919)() < 0.2 ? '﻿' + text : text
}

/** Lines as the tool sees them: `\r\n`, `\n` and a lone `\r` all end one. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/)
}

/** The file with `drop` line indices removed, terminators preserved. */
function joinKept(text: string, drop: Set<number>): string {
  const parts = text.split(/(\r\n|\n|\r)/)
  let out = ''
  let line = 0
  for (let i = 0; i < parts.length; i += 2) {
    if (!drop.has(line)) out += parts[i] + (parts[i + 1] ?? '')
    line++
  }
  return out
}

/** Which of `RULES` git ignores, given the file on disk. */
function ignored(dir: string): string[] {
  try {
    // The machine's *global* excludes file is off. Without this the oracle
    // answered from whatever the developer happens to ignore globally — `dist/`
    // was reported ignored by a fixture that never mentioned it — so the test
    // was both wrong here and unreproducible anywhere else.
    const out = execFileSync(
      'git',
      ['-C', dir, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--stdin'],
      { input: RULES.join('\n') + '\n', encoding: 'utf8' },
    )
    return out.split('\n').filter(Boolean)
  } catch (err) {
    // Exit 1 means "none ignored", which is an answer, not a failure.
    const e = err as { status?: number; stdout?: string }
    if (e.status === 1) return (e.stdout ?? '').split('\n').filter(Boolean)
    throw err
  }
}

const TIMEOUT = 180_000

describe('.gitignore holds the same invariants as a root file', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitignore-prop-'))
    execFileSync('git', ['-C', dir, 'init', '-q'])
    file = join(dir, '.gitignore')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const SEEDS = Array.from({ length: 800 }, (_, i) => i + 1)

  it(
    'never stops honouring a rule the user wrote outside our block',
    async () => {
      for (const seed of SEEDS) {
        const original = makeFile(seed)
        writeFileSync(file, original)

        // Which rules git honours *because of a line outside every block of
        // ours*. Those are the user's, and no number of syncs may drop one.
        // Ours: every line of a complete block, and every marker line whatever
        // it pairs with. Leaving unpaired markers in the baseline meant the
        // baseline file still carried them — and since they begin with `#`,
        // git read them as comments, so the two files were not comparable.
        const ownedLines = new Set<number>()
        for (const r of blockRegions(original, START_MARKER, END_MARKER)) {
          const from = splitLines(original.slice(0, r.start)).length - 1
          const to = splitLines(original.slice(0, r.end)).length - 1
          for (let i = from; i <= to; i++) ownedLines.add(i)
        }
        for (const [i, line] of splitLines(original).entries()) {
          if (line.startsWith(START_MARKER) || line.startsWith(END_MARKER)) ownedLines.add(i)
        }
        writeFileSync(file, joinKept(original, ownedLines))
        const theirs = new Set(ignored(dir))
        writeFileSync(file, original)

        // git does not treat a lone `\r` as a line separator, so it reads a
        // classic-Mac `.gitignore` as a single line and honours nothing in it —
        // before or after this tool touches it. Asking git about those files
        // compares against a state it never had. Their bytes are still checked
        // below, which is all that can honestly be promised for a file git
        // cannot read.
        const crOnly = original.includes('\r') && !original.includes('\n')

        for (let pass = 0; pass < 3; pass++) {
          await updateGitignore(dir)
          const now = new Set(ignored(dir))
          for (const rule of crOnly ? [] : theirs) {
            expect(
              now.has(rule),
              `pass ${pass}: stopped ignoring ${rule}\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(readFileSync(file, 'utf8'))}`,
            ).toBe(true)
          }
        }

        // And every line of theirs is still there, the same number of times.
        // Git's answer can be preserved by accident — a duplicated rule gives
        // the same result — so the file itself is checked as well.
        const ownedNow = new Set<number>()
        const finalText = readFileSync(file, 'utf8')
        for (const r of blockRegions(finalText, START_MARKER, END_MARKER)) {
          const from = splitLines(finalText.slice(0, r.start)).length - 1
          const to = splitLines(finalText.slice(0, r.end)).length - 1
          for (let i = from; i <= to; i++) ownedNow.add(i)
        }
        const survived = splitLines(finalText).filter((_, i) => !ownedNow.has(i))
        // Marker lines excluded: a marker that pairs with nothing sits outside
        // every *region*, so `blockRegions` does not call it owned — but it is
        // still a line this tool wrote, and taking it back is not losing
        // anything of the user's.
        const wrote = splitLines(original)
          .filter((_, i) => !ownedLines.has(i))
          .filter((l) => l.trim() !== '')
          .filter((l) => !l.startsWith(START_MARKER) && !l.startsWith(END_MARKER))
        for (const line of new Set(wrote)) {
          expect(
            survived.filter((l) => l === line).length,
            `lost or duplicated ${JSON.stringify(line)}\nfrom ${JSON.stringify(original)}`,
          ).toBe(wrote.filter((l) => l === line).length)
        }
      }
    },
    TIMEOUT,
  )

  it(
    'converges on exactly one current block from any damage, in one write',
    async () => {
      // Unconditional, and in *one* pass. Our block here is a constant, so it is
      // rebuilt rather than maintained and there is no shape this file can be in
      // that a single `sync` does not resolve — no torn, severed or unreducible
      // state, because none of that machinery applies to a block with nothing
      // per-project inside it. Every earlier version could only promise
      // convergence for some inputs, and the exceptions were where the defects
      // lived.
      for (const seed of SEEDS) {
        const original = withBom(seed, makeFile(seed))
        writeFileSync(file, original)

        await updateGitignore(dir)
        const once = readFileSync(file, 'utf8')

        // The seam, asserted directly rather than left for a reviewer to trip
        // over: after `sync` writes, the reader every surface shares must be
        // satisfied. A BOM'd file was already correct and `gitignoreNeedsRebuild`
        // said otherwise — so `sync --check`, `doctor` and `status` all reported
        // drift while `sync` replied "unchanged". Drift no command could clear.
        expect(
          gitignoreNeedsRebuild(once),
          `seed ${seed}: sync wrote, and the check still wants a rebuild\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(once)}`,
        ).toBe('')
        expect(
          blockRegions(once, START_MARKER, END_MARKER).length,
          `seed ${seed}: one write left ${blockRegions(once, START_MARKER, END_MARKER).length} blocks\nfrom ${JSON.stringify(original)}`,
        ).toBe(1)
        expect(
          orphanMarkers(once, START_MARKER, END_MARKER).length,
          `seed ${seed}: a stray marker survived`,
        ).toBe(0)

        await updateGitignore(dir)
        expect(readFileSync(file, 'utf8'), `seed ${seed}: not a fixed point`).toBe(once)
      }
    },
    TIMEOUT,
  )

  it(
    'leaves our own rules in force, as git reads them and not as we spell them',
    async () => {
      // The promise this file exists to keep, asked of the only authority on it.
      //
      // Every other test here compares text, and text was never the question:
      // git ends a line at `\n` and nowhere else, so on a file with no `\n` in it
      // the entire block — markers, comments and all sixteen rules — was one line
      // beginning with `#`. A comment. `.env` was ignored by nothing, `sync`
      // printed "✓ Updated", and `doctor` and `sync --check` were green because
      // the characters were all present and in the right order. 1017 of 4000
      // generated files were in that state.
      const MUST_IGNORE = [
        '.env',
        '.opencastle/logs/run.txt',
        '.opencastle/runs/a',
        '.opencastle/x.db',
        '.opencastle.removed/a',
      ]
      for (const seed of SEEDS) {
        const original = withBom(seed, makeFile(seed))
        writeFileSync(file, original)
        await updateGitignore(dir)

        let out = ''
        try {
          out = execFileSync(
            'git',
            ['-C', dir, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--stdin'],
            { input: MUST_IGNORE.join('\n') + '\n', encoding: 'utf8' },
          )
        } catch (err) {
          const e = err as { status?: number; stdout?: string }
          if (e.status === 1) out = e.stdout ?? ''
          else throw err
        }
        const ignoring = new Set(out.split('\n').filter(Boolean))
        const inert = MUST_IGNORE.filter((p) => !ignoring.has(p))
        expect(
          inert,
          `seed ${seed}: git does not ignore ${inert.join(', ')}\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(readFileSync(file, 'utf8'))}`,
        ).toEqual([])
      }
    },
    TIMEOUT,
  )

  it(
    'leaves nothing of ours behind, and the preview says what the action does',
    async () => {
      for (const seed of SEEDS) {
        writeFileSync(file, withBom(seed, makeFile(seed)))
        await updateGitignore(dir)

        // The preview and the action, from the same state — these have diverged
        // before, and the preview is what the user is asked to approve.
        const predicted = await predictGitignoreStrip(dir)
        await removeGitignoreBlock(dir)
        const actual = !existsSync(file) ? 'deleted' : 'stripped'
        if (predicted !== 'absent') {
          expect(predicted, `seed ${seed}: preview said ${predicted}, action did ${actual}`).toBe(
            actual,
          )
        }

        const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
        // Markers at column 0 only: we write them there and nowhere else, so an
        // indented one is a line of the user's and stays.
        for (const line of left.split('\n')) {
          expect(
            line === START_MARKER || line === END_MARKER,
            `seed ${seed}: a marker of ours survived`,
          ).toBe(false)
        }
      }
    },
    TIMEOUT,
  )
})
