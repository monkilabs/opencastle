import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  diagnoseManagedFile,
  writeManagedBlock,
  stripManagedBlockFromFile,
  extractManagedBlock,
  hasManagedBlock,
  blockRegions,
  orphanMarkers,
  BLOCK_START,
  BLOCK_END,
} from './managed-block.js'

/**
 * The invariants, checked over files nobody chose.
 *
 * Every managed-block defect in this branch's review history was found by a
 * person constructing a file the hand-written fixtures did not cover — a fence
 * that opened and never closed, a marker pasted into a code sample, a file torn
 * on both sides of the block. Each fix then added a fixture for that exact
 * shape, and the next round found another one.
 *
 * Two searches, because they fail differently. `arrangements` is exhaustive
 * over a three-symbol alphabet: it finds the *shortest* counterexample, on
 * every run, in about a second — the shape that cost the user their prose
 * exists at seven lines, and random sampling needed twelve thousand draws to
 * stumble onto a ten-line instance of it. `makeFile` is a broad random
 * generator over pieces that have each broken this module at some point, and
 * catches what a three-symbol alphabet cannot express.
 *
 * These are deliberately long-running and carry their own timeouts. How much
 * searching is allowed is the whole point, and the default ten seconds is a
 * limit on that rather than on anything else. Every previous round's headline
 * defect was inside the reach of the generator and outside the reach of the
 * bound I had chosen for it, so the bound is now set by what the machine can
 * stand rather than by what makes the suite feel quick — and the numbers here
 * were verified further still (12000 seeds, `arrangements(8)`) before landing.
 */

/** Building blocks that have each, at some point, broken this module. */
const PIECES = [
  '# Heading\n',
  'Some prose.\n',
  '\n',
  '```\n',
  '```sh\n',
  '````md\n',
  '~~~\n',
  '  ```\n',
  'npm test\n',
  '---\n',
  `${BLOCK_START}\n`,
  `${BLOCK_END}\n`,
  `${BLOCK_START}\nquoted body\n${BLOCK_END}\n`,
  `${BLOCK_END}\n${BLOCK_START}\n`,
  '<!-- a comment -->\n',
  'A RULE THE USER WROTE\n',
  // The fingerprints the adopt path matches on. They are byte-for-byte this
  // release's own generated header, so a file can carry one *and* a marker —
  // which is precisely the shape that used to be replaced wholesale.
  '# Project Instructions\n',
  '# Copilot Instructions\n',
  'All conventions, architecture, and project context are embedded below.\n',
  'This file is managed by OpenCastle\n',
  `${BLOCK_START} trailing text\n`,
  `  ${BLOCK_END}\n`,
]

/** Deterministic pseudo-random, so a failure is reproducible from its index. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function makeFile(seed: number): string {
  const rand = lcg(seed)
  // Up to twelve pieces. The shapes that broke this needed seven to ten, and a
  // six-piece cap is why eight thousand seeds once looked clean.
  const count = 1 + Math.floor(rand() * 12)
  let text = ''
  for (let i = 0; i < count; i++) {
    text += PIECES[Math.floor(rand() * PIECES.length)]
  }
  if (rand() < 0.25) text = text.replace(/\n/g, '\r\n')
  if (rand() < 0.3) text = text.replace(/\r?\n$/, '')
  return text
}

/** Every arrangement of a start marker, an end marker and a line of the user's. */
function* arrangements(maxLen: number): Generator<string> {
  const alphabet = [
    `${BLOCK_START}\n`,
    `${BLOCK_END}\n`,
    'USERLINE\n',
    // A legacy fingerprint, so the enumeration can reach the adopt path.
    '# Project Instructions\n',
  ]
  for (let len = 1; len <= maxLen; len++) {
    const total = alphabet.length ** len
    for (let i = 0; i < total; i++) {
      let text = ''
      let k = i
      for (let j = 0; j < len; j++) {
        text += alphabet[k % alphabet.length]
        k = Math.floor(k / alphabet.length)
      }
      yield text
    }
  }
}

const BODY_A = 'generated body A\n\n```bash\nnpm run build\n```\n'
const BODY_B = 'generated body B — a later release\n\n```bash\nnpm run ship\n```\n'

/** How many `line`s sit between a start marker and its end marker. */
function linesInsideBlocks(text: string, line: string): number {
  return blockRegions(text)
    .map((r) => text.slice(r.start, r.end).split('\n').filter((l) => l === line).length)
    .reduce((a, b) => a + b, 0)
}

const TIMEOUT = 300_000

/**
 * How deep the exhaustive enumeration goes, and why it is not as deep as it can be.
 *
 * The alphabet has four symbols, so the case count is `sum(4^n)`: 21,844 at seven
 * and 87,380 at eight. On this machine that is 14s against 56s — but the suite runs
 * files in parallel, which took the eight-deep run to 161s, and on the Pages deploy
 * runner it exceeded ten minutes and failed. A website deploy could not publish
 * because a property test was enumerating 87,380 arrangements.
 *
 * Seven is the checked-in bound because the depth is not where the defects have
 * been. Rounds 15 to 20 each ran this generator far past its bound and found
 * nothing there; every defect in that stretch came from a missing *alphabet* entry
 * — a BOM, a lone `\r`, mixed terminators in one file — which a deeper enumeration
 * of the same four symbols cannot reach. Widening the alphabet is what pays, and it
 * is cheap at seven.
 *
 * The deeper sweep is still one command: `OC_ARRANGEMENT_DEPTH=9 npx vitest run
 * src/cli/managed-block.property.test.ts`, or `npm run test:deep`.
 */
const ARRANGEMENT_DEPTH = Number(process.env.OC_ARRANGEMENT_DEPTH ?? 7)

describe('the managed block holds its invariants over files nobody chose', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-prop-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const SEEDS = Array.from({ length: 1500 }, (_, i) => i + 1)

  it(
    "never draws a line of the user's into a block, over every arrangement",
    async () => {
      // The property that catches capture at the moment it happens, rather than
      // one command later when the next run consumes it.
      //
      // A line already between a marker pair when we arrive is ours — that is
      // the module's one rule — so what must never rise is the *count* of the
      // user's lines sitting inside a block. Cutting a block used to promote a
      // stray start marker beside a stray end marker into a pair around their
      // prose, and the write after that deleted it.
      for (const original of arrangements(ARRANGEMENT_DEPTH)) {
        writeFileSync(file, original)
        const before = linesInsideBlocks(original, 'USERLINE')

        for (let pass = 0; pass < 3; pass++) {
          await writeManagedBlock(file, pass === 1 ? BODY_B : BODY_A)
          const text = readFileSync(file, 'utf8')
          expect(
            linesInsideBlocks(text, 'USERLINE'),
            `pass ${pass}: a free-standing user line was captured\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(text)}`,
          ).toBeLessThanOrEqual(before)
        }

        // And every free-standing one is still there at the end.
        await stripManagedBlockFromFile(file)
        const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
        const freeStanding =
          original.split('\n').filter((l) => l === 'USERLINE').length - before
        expect(
          left.split('\n').filter((l) => l === 'USERLINE').length,
          `lost a free-standing user line from ${JSON.stringify(original)}`,
        ).toBeGreaterThanOrEqual(freeStanding)
      }
    },
    TIMEOUT,
  )

  it(
    'converges on exactly one block, unless the file is torn',
    async () => {
      for (const seed of SEEDS) {
        const original = makeFile(seed)
        writeFileSync(file, original)

        // A severed file — our body present with its markers gone — is written
        // to by nothing until a person resolves it, so there is no block to
        // converge on. What must hold is that the file is left exactly alone.
        if (diagnoseManagedFile(original).state === 'severed') {
          await writeManagedBlock(file, BODY_A)
          expect(
            readFileSync(file, 'utf8'),
            `seed ${seed}: wrote into a severed file`,
          ).toBe(original)
          continue
        }

        await writeManagedBlock(file, BODY_A)
        const afterOne = blockRegions(readFileSync(file, 'utf8')).length
        await writeManagedBlock(file, BODY_A)
        const text = readFileSync(file, 'utf8')

        // A file carrying unpaired markers is not reduced at all: cutting a
        // block there can promote two strays into a pair around the user's own
        // text. It must still never *grow*, and `sync --check` reports it.
        if (orphanMarkers(original).length > 0) {
          expect(
            blockRegions(text).length,
            `seed ${seed}: a torn file grew\n${JSON.stringify(original)}`,
          ).toBeLessThanOrEqual(Math.max(1, blockRegions(original).length))
        } else {
          expect(afterOne, `seed ${seed}: first write exceeded two blocks`).toBeLessThanOrEqual(2)
          expect(blockRegions(text).length, `seed ${seed}: ${JSON.stringify(original)}`).toBe(1)
        }

        expect(hasManagedBlock(text), `seed ${seed}: block is unfindable`).toBe(true)
        expect(extractManagedBlock(text), `seed ${seed}: body not readable back`).toBe(
          BODY_A.trimEnd(),
        )
      }
    },
    TIMEOUT,
  )

  it(
    'is a fixed point, and never gains a block across a content change',
    async () => {
      for (const seed of SEEDS) {
        const original = makeFile(seed)
        if (diagnoseManagedFile(original).state === 'severed') continue
        writeFileSync(file, original)
        await writeManagedBlock(file, BODY_A)
        await writeManagedBlock(file, BODY_A)
        const once = readFileSync(file, 'utf8')

        await writeManagedBlock(file, BODY_A)
        expect(readFileSync(file, 'utf8'), `seed ${seed}: not a fixed point`).toBe(once)

        // The upgrade path. A block the tool failed to recognise used to be
        // left alone here while a second one was appended — two complete
        // instruction sets, with every reporting surface calling it healthy.
        await writeManagedBlock(file, BODY_B)
        const after = readFileSync(file, 'utf8')
        expect(
          blockRegions(after).length,
          `seed ${seed}: upgrade added a block`,
        ).toBeLessThanOrEqual(blockRegions(once).length)
        expect(extractManagedBlock(after), `seed ${seed}: upgrade did not take`).toBe(
          BODY_B.trimEnd(),
        )
      }
    },
    TIMEOUT,
  )

  it(
    'leaves nothing of ours behind on uninstall',
    async () => {
      for (const seed of SEEDS) {
        writeFileSync(file, makeFile(seed))
        await writeManagedBlock(file, BODY_A)
        await writeManagedBlock(file, BODY_B)
        await stripManagedBlockFromFile(file)

        const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
        expect(left, `seed ${seed}: our body survived`).not.toContain('generated body')
        expect(left, `seed ${seed}: our fenced body survived`).not.toContain('npm run ship')
        // Markers at column 0 only. We write them there and nowhere else, so an
        // indented one is the user's text — leaving it is the same rule that
        // leaves everything else of theirs alone.
        for (const line of left.split('\n')) {
          expect(
            line === BLOCK_START || line === BLOCK_END,
            `seed ${seed}: a marker of ours survived`,
          ).toBe(false)
        }
      }
    },
    TIMEOUT,
  )

  it(
    "keeps every line of the user's that is not a marker or a block body",
    async () => {
      for (const seed of SEEDS) {
        const original = makeFile(seed)
        // A file carrying no marker of ours at all, whose first line is one of
        // this tool's old generated headers, is the documented adopt case: a
        // pre-marker release wrote the whole thing, so the whole thing is
        // replaced and a backup written. Excluded here so the property is about
        // the case that matters — a file with a marker in it, which always has
        // a boundary we can read and must therefore never be replaced.
        if (blockRegions(original).length === 0 && orphanMarkers(original).length === 0) continue
        writeFileSync(file, original)
        // Three writes, then the strip. One was not enough: the shape that
        // destroyed the user's prose needed a second command to consume what
        // the first had produced.
        await writeManagedBlock(file, BODY_A)
        await writeManagedBlock(file, BODY_B)
        await writeManagedBlock(file, BODY_A)
        await stripManagedBlockFromFile(file)
        const left = existsSync(file) ? readFileSync(file, 'utf8') : ''

        // Lines the tool is entitled to take: its own markers, and whatever sat
        // between a complete pair. Everything else is the user's and must come
        // back, in order and once each.
        const ours = new Set<number>()
        for (const r of blockRegions(original)) {
          const from = original.slice(0, r.start).split('\n').length - 1
          const to = original.slice(0, r.end).split('\n').length - 1
          for (let i = from; i <= to; i++) ours.add(i)
        }
        for (const at of orphanMarkers(original)) {
          ours.add(original.slice(0, at).split('\n').length - 1)
        }
        const theirs = original
          .split('\n')
          .filter((_, i) => !ours.has(i))
          .filter((l) => l.trim() !== '')
          .map((l) => l.replace(/\r$/, ''))

        // Compared without carriage returns: a line's *terminator* around a
        // removed block is genuinely ambiguous (see `cutBlock`); its content is
        // not. This asserts the content.
        const remaining = left.split('\n').map((l) => l.replace(/\r$/, ''))
        let cursor = 0
        for (const line of theirs) {
          const found = remaining.indexOf(line, cursor)
          expect(
            found,
            `seed ${seed}: lost or reordered ${JSON.stringify(line)}\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(left)}`,
          ).toBeGreaterThanOrEqual(cursor)
          cursor = found + 1
        }

        // Loss is not the only way to damage a file. An earlier splice
        // *duplicated* the user's paragraphs, and an in-order search cannot see
        // that — it finds every line exactly where it expects one.
        for (const line of new Set(theirs)) {
          expect(
            remaining.filter((l) => l === line).length,
            `seed ${seed}: ${JSON.stringify(line)} duplicated\nfrom ${JSON.stringify(original)}`,
          ).toBe(theirs.filter((l) => l === line).length)
        }
      }
    },
    TIMEOUT,
  )
})
