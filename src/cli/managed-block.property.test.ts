import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  writeManagedBlock,
  stripManagedBlockFromFile,
  extractManagedBlock,
  hasManagedBlock,
  ownedRegions,
  blockRegions,
  orphanMarkers,
  BLOCK_START,
  BLOCK_END,
} from './managed-block.js'

/**
 * The invariants, checked over generated files rather than chosen ones.
 *
 * Every managed-block defect in this branch's review history was found by a
 * person constructing a file the hand-written fixtures did not cover — a fence
 * that opened and never closed, a marker pasted into a code sample, a file
 * whose last line had no newline. Each fix then added a fixture for that exact
 * shape, and the next round found another.
 *
 * These are the properties themselves. The generator below is deliberately
 * hostile: fences of both delimiters and several lengths, indented fences,
 * markers loose in prose, complete blocks already present, CRLF, and files with
 * and without a trailing newline. If a shape breaks an invariant, the assertion
 * prints the file that did it.
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
  '<!-- a comment -->\n',
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
  const count = 1 + Math.floor(rand() * 6)
  let text = ''
  for (let i = 0; i < count; i++) {
    text += PIECES[Math.floor(rand() * PIECES.length)]
  }
  if (rand() < 0.25) text = text.replace(/\n/g, '\r\n')
  if (rand() < 0.3) text = text.replace(/\r?\n$/, '')
  return text
}

const BODY_A = 'generated body A\n\n```bash\nnpm run build\n```\n'
const BODY_B = 'generated body B — a later release\n\n```bash\nnpm run ship\n```\n'

describe('the managed block holds its invariants over generated files', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-prop-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1)

  it('converges on exactly one block, whatever the file looked like', async () => {
    for (const seed of SEEDS) {
      const original = makeFile(seed)
      writeFileSync(file, original)

      // Two writes, not one. A file carrying stray markers on both sides of a
      // block needs a pass to normalise: removing a block can leave a stray
      // start marker adjacent to a stray end marker, and that pair reads as a
      // block on the next scan. The tool does not chase that in a loop — a loop
      // would delete whatever sat between the two strays, which is the user's.
      // It settles on the following pass instead, and `sync --check` reports
      // the file as drifted until it does, so nothing is silently doubled.
      await writeManagedBlock(file, BODY_A)
      const afterOne = blockRegions(readFileSync(file, 'utf8')).length
      await writeManagedBlock(file, BODY_A)
      const text = readFileSync(file, 'utf8')

      expect(afterOne, `seed ${seed}: first write already exceeded two blocks`).toBeLessThanOrEqual(2)
      expect(blockRegions(text).length, `seed ${seed}: ${JSON.stringify(original)}`).toBe(1)
      // The writer and every reader must agree that it is there. A disowned
      // block — one the writer maintained and `hasManagedBlock` denied — is how
      // `sync --check` came to report drift no command could clear.
      expect(hasManagedBlock(text), `seed ${seed}: block is unfindable`).toBe(true)
      expect(ownedRegions(text).length, `seed ${seed}: ownership disagrees`).toBe(1)
      expect(extractManagedBlock(text), `seed ${seed}: body not readable back`).toBe(BODY_A.trimEnd())
    }
  })

  it('is a fixed point, and stays one block across a content change', async () => {
    for (const seed of SEEDS) {
      writeFileSync(file, makeFile(seed))
      await writeManagedBlock(file, BODY_A)
      await writeManagedBlock(file, BODY_A)
      const once = readFileSync(file, 'utf8')

      await writeManagedBlock(file, BODY_A)
      expect(readFileSync(file, 'utf8'), `seed ${seed}: not a fixed point`).toBe(once)

      // The upgrade path. A block the tool failed to recognise used to be left
      // alone here while a second one was appended — two complete instruction
      // sets, with every reporting surface calling the project healthy.
      await writeManagedBlock(file, BODY_B)
      const after = readFileSync(file, 'utf8')
      expect(blockRegions(after).length, `seed ${seed}: upgrade doubled the block`).toBe(1)
      expect(extractManagedBlock(after), `seed ${seed}: upgrade did not take`).toBe(BODY_B.trimEnd())
    }
  })

  it('leaves nothing of ours behind on uninstall', async () => {
    for (const seed of SEEDS) {
      writeFileSync(file, makeFile(seed))
      await writeManagedBlock(file, BODY_A)
      await writeManagedBlock(file, BODY_B)
      await stripManagedBlockFromFile(file)

      const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
      expect(left, `seed ${seed}: our body survived`).not.toContain('generated body')
      expect(left, `seed ${seed}: our fenced body survived`).not.toContain('npm run ship')
      expect(left, `seed ${seed}: a marker survived`).not.toContain(BLOCK_START)
      expect(left, `seed ${seed}: a marker survived`).not.toContain(BLOCK_END)
    }
  })

  it("keeps every line of the user's that is not a marker or a block body", async () => {
    for (const seed of SEEDS) {
      const original = makeFile(seed)
      writeFileSync(file, original)
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
      // removed block is genuinely ambiguous (see `cutBlock`), its content is
      // not. This asserts the content.
      const remaining = left.split('\n').map((l) => l.replace(/\r$/, ''))
      let cursor = 0
      for (const raw of theirs) {
        const line = raw.replace(/\r$/, '')
        const found = remaining.indexOf(line, cursor)
        expect(
          found,
          `seed ${seed}: lost or reordered ${JSON.stringify(line)}\nfrom ${JSON.stringify(original)}\ngot ${JSON.stringify(left)}`,
        ).toBeGreaterThanOrEqual(cursor)
        cursor = found + 1
      }
    }
  })
})
