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
    'keeps every line the user wrote outside our block, once each',
    async () => {
      for (const seed of SEEDS) {
        const original = makeFile(seed)
        writeFileSync(file, original)

        // Ours: every line of a complete block, and every marker line whatever
        // it pairs with.
        const ownedLines = new Set<number>()
        for (const r of blockRegions(original, START_MARKER, END_MARKER)) {
          const from = splitLines(original.slice(0, r.start)).length - 1
          const to = splitLines(original.slice(0, r.end)).length - 1
          for (let i = from; i <= to; i++) ownedLines.add(i)
        }
        for (const [i, line] of splitLines(original).entries()) {
          if (line.startsWith(START_MARKER) || line.startsWith(END_MARKER)) ownedLines.add(i)
        }

        // This test used to also ask git which rules survived, against a baseline
        // built by deleting our lines — "what their file would do if we were not
        // in it". That baseline turned out to be unachievable, in both directions
        // at once, and the mixed-ending alphabet made it say so:
        //
        //   their-rule\r  <our block>  other-rule\n
        //
        // Git ends a line only at `\n`, so with our block deleted those two are a
        // single welded line, and with our block present they are two. Inserting
        // anything between two welded lines unwelds them; nothing can be inserted
        // that does not. So "their lines behave as if we were absent" cannot be
        // held, and holding it in one direction broke it in the other — the fix
        // that stopped a live rule going dead also revived a dead `!keep.txt`,
        // which un-ignores a file the project had been ignoring.
        //
        // What can be promised is monotone and is what a user actually relies on:
        // no sync stops honouring what the file was honouring before it ran. That
        // is the test below, with `check-ignore -v` for attribution. What is left
        // here is the textual half, which needs no oracle.
        for (let pass = 0; pass < 3; pass++) await updateGitignore(dir)

        // Every line of theirs is still there, the same number of times.
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
    'never moves where a line of theirs begins, as git counts lines',
    async () => {
      // The property the other tests could not see, because both obvious
      // baselines are wrong. Deleting our lines first promotes whatever sat above
      // our block to be the last line, and git strips a trailing `\r` from a last
      // line — so a rule that was welded and dead in the real file looks live in
      // the model. Not deleting them credits the user with rules sitting inside
      // our own block, which we replace by design.
      //
      // `check-ignore -v` reports the line number that matched, so attribution is
      // exact: a probe counts as theirs only when the line responsible is one no
      // line of ours overlaps. What it caught: their `\r`-terminated rule and the
      // rule below it were separated by our block, which was supplying the `\n`
      // git needed. Replacing the block joined them into one dead pattern —
      // `secrets/prod.key\rbuild` — and a live rule went silently inert.
      const ignoredBy = (): Map<string, number> => {
        let out = ''
        try {
          out = execFileSync(
            'git',
            ['-C', dir, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '-v', '--stdin'],
            { input: RULES.join('\n') + '\n', encoding: 'utf8' },
          )
        } catch (err) {
          const e = err as { status?: number; stdout?: string }
          if (e.status === 1) out = e.stdout ?? ''
          else throw err
        }
        const hits = new Map<string, number>()
        for (const row of out.split('\n').filter(Boolean)) {
          const tab = row.lastIndexOf('\t')
          if (tab === -1) continue
          const m = /^(.*):(\d+):/.exec(row.slice(0, tab))
          if (m) hits.set(row.slice(tab + 1), Number(m[2]))
        }
        return hits
      }

      /** Git line numbers (1-based) that no line of ours overlaps. */
      const unambiguous = (text: string): Set<number> => {
        const owned = new Set<number>()
        for (const r of blockRegions(text, START_MARKER, END_MARKER)) {
          const from = splitLines(text.slice(0, r.start)).length - 1
          const to = splitLines(text.slice(0, r.end)).length - 1
          for (let i = from; i <= to; i++) owned.add(i)
        }
        for (const [i, line] of splitLines(text).entries()) {
          if (line.startsWith(START_MARKER) || line.startsWith(END_MARKER)) owned.add(i)
        }
        const ranges: Array<[number, number]> = []
        const re = /\r\n|\n|\r/g
        let at = 0
        let idx = 0
        for (let m = re.exec(text); m !== null; m = re.exec(text)) {
          if (owned.has(idx)) ranges.push([at, m.index + m[0].length])
          at = m.index + m[0].length
          idx++
        }
        if (owned.has(idx)) ranges.push([at, text.length])

        const ok = new Set<number>()
        let start = 0
        let gitLine = 1
        for (let i = 0; i <= text.length; i++) {
          if (i === text.length || text[i] === '\n') {
            const end = i === text.length ? i : i + 1
            if (end > start && !ranges.some(([a, b]) => a < end && b > start)) ok.add(gitLine)
            start = end
            gitLine++
            if (i === text.length) break
          }
        }
        return ok
      }

      for (const seed of SEEDS) {
        const original = makeFile(seed)
        writeFileSync(file, original)
        const before = ignoredBy()
        const theirLines = unambiguous(original)
        const theirs = [...before]
          .filter(([, ln]) => theirLines.has(ln))
          .map(([probe]) => probe)

        await updateGitignore(dir)
        const after = new Set(ignoredBy().keys())
        const lost = theirs.filter((p) => !after.has(p))
        expect(
          lost,
          `seed ${seed}: git stopped ignoring ${lost.join(', ')}\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(readFileSync(file, 'utf8'))}`,
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
