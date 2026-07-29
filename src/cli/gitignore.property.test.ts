import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  updateGitignore,
  removeGitignoreBlock,
  predictGitignoreStrip,
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
const RULES = [
  'node_modules',
  '.env.local',
  'secrets/prod.key',
  'dist/',
  '*.tmp',
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
  return text
}

/** Which of `RULES` git ignores, given the file on disk. */
function ignored(dir: string): string[] {
  try {
    const out = execFileSync('git', ['-C', dir, 'check-ignore', '--stdin'], {
      input: RULES.join('\n') + '\n',
      encoding: 'utf8',
    })
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
        const ownedLines = new Set<number>()
        for (const r of blockRegions(original, START_MARKER, END_MARKER)) {
          const from = original.slice(0, r.start).split('\n').length - 1
          const to = original.slice(0, r.end).split('\n').length - 1
          for (let i = from; i <= to; i++) ownedLines.add(i)
        }
        writeFileSync(
          file,
          original
            .split('\n')
            .filter((_, i) => !ownedLines.has(i))
            .join('\n'),
        )
        const theirs = new Set(ignored(dir))
        writeFileSync(file, original)

        for (let pass = 0; pass < 3; pass++) {
          await updateGitignore(dir)
          const now = new Set(ignored(dir))
          for (const rule of theirs) {
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
          const from = finalText.slice(0, r.start).split('\n').length - 1
          const to = finalText.slice(0, r.end).split('\n').length - 1
          for (let i = from; i <= to; i++) ownedNow.add(i)
        }
        const survived = finalText.split('\n').filter((_, i) => !ownedNow.has(i))
        // Marker lines excluded: a marker that pairs with nothing sits outside
        // every *region*, so `blockRegions` does not call it owned — but it is
        // still a line this tool wrote, and taking it back is not losing
        // anything of the user's.
        const wrote = original
          .split('\n')
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
        const original = makeFile(seed)
        writeFileSync(file, original)

        await updateGitignore(dir)
        const once = readFileSync(file, 'utf8')
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
    'leaves nothing of ours behind, and the preview says what the action does',
    async () => {
      for (const seed of SEEDS) {
        writeFileSync(file, makeFile(seed))
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
