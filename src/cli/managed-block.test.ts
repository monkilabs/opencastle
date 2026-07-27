/**
 * Tests for merging generated content into files the user owns.
 *
 * Root instruction files are the one place the user's writing and the compiler's
 * output share a file. Adapters used to resolve that by skipping the file when it
 * existed, which meant that on the exact repo this tool is pitched at — one that
 * already has a CLAUDE.md — the instructions layer silently never installed, and
 * `update` deleted the file outright.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  writeManagedBlock,
  stripManagedBlock,
  stripManagedBlockFromFile,
  predictStrip,
  hasManagedBlock,
  extractManagedBlock,
  BLOCK_START,
  BLOCK_END,
} from './managed-block.js'

describe('writeManagedBlock', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file when it does not exist', async () => {
    const result = await writeManagedBlock(file, 'generated content')
    expect(result.action).toBe('created')
    expect(result.preservedUserContent).toBe(false)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('generated content')
    expect(hasManagedBlock(text)).toBe(true)
  })

  it('keeps every byte the user wrote when appending', async () => {
    const userContent = '# Acme Web\n\nUse pnpm, never npm.\nNever touch `legacy/`.\n'
    writeFileSync(file, userContent)

    const result = await writeManagedBlock(file, 'generated content')
    expect(result.action).toBe('appended')
    expect(result.preservedUserContent).toBe(true)

    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# Acme Web')
    expect(text).toContain('Use pnpm, never npm.')
    expect(text).toContain('Never touch `legacy/`.')
    expect(text).toContain('generated content')
    // The user's content comes first — their file, their lead.
    expect(text.indexOf('# Acme Web')).toBeLessThan(text.indexOf(BLOCK_START))
  })

  it('replaces only the block on a second write', async () => {
    writeFileSync(file, '# Mine\n\nkeep this\n')
    await writeManagedBlock(file, 'first generation')
    const result = await writeManagedBlock(file, 'second generation')

    expect(result.action).toBe('updated')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# Mine')
    expect(text).toContain('keep this')
    expect(text).toContain('second generation')
    expect(text).not.toContain('first generation')
  })

  it('never accumulates blocks', async () => {
    writeFileSync(file, '# Mine\n')
    for (let i = 0; i < 5; i++) await writeManagedBlock(file, `generation ${i}`)

    const text = readFileSync(file, 'utf8')
    expect(text.split(BLOCK_START)).toHaveLength(2)
    expect(text.split(BLOCK_END)).toHaveLength(2)
  })

  it('is idempotent — same input leaves the file byte-identical', async () => {
    writeFileSync(file, '# Mine\n\nkeep this\n')
    await writeManagedBlock(file, 'stable content')
    const first = readFileSync(file, 'utf8')

    const result = await writeManagedBlock(file, 'stable content')
    expect(result.action).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe(first)
  })

  it('preserves user content added after the block', async () => {
    writeFileSync(file, '# Mine\n')
    await writeManagedBlock(file, 'generated')
    // Someone appends their own notes below the block.
    writeFileSync(file, readFileSync(file, 'utf8') + '\n## My notes\n\nstill here\n')

    await writeManagedBlock(file, 'regenerated')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# Mine')
    expect(text).toContain('## My notes')
    expect(text).toContain('still here')
    expect(text).toContain('regenerated')
  })

  it('reports an empty pre-existing file as having no user content', async () => {
    writeFileSync(file, '   \n\n')
    const result = await writeManagedBlock(file, 'generated')
    expect(result.preservedUserContent).toBe(false)
  })
})

describe('stripManagedBlock', () => {
  it('returns content unchanged when there is no block', () => {
    expect(stripManagedBlock('# Just mine\n')).toBe('# Just mine\n')
  })

  it('removes the block and leaves the surrounding text', () => {
    const text = `# Mine\n\n${BLOCK_START}\ngenerated\n${BLOCK_END}\n\n## Also mine\n`
    const stripped = stripManagedBlock(text)
    expect(stripped).toContain('# Mine')
    expect(stripped).toContain('## Also mine')
    expect(stripped).not.toContain('generated')
  })

  it('keeps text below a marker that opens no block', () => {
    // A start marker with no partner is damage we cannot interpret: it may be
    // our block with its end lost, or a line the user quoted. Only the marker
    // itself is unambiguously ours, so only the marker goes.
    const text = `# Mine\n\n${BLOCK_START}\n\n## Written after\n\nstill mine\n`
    const stripped = stripManagedBlock(text)
    expect(stripped).toContain('# Mine')
    expect(stripped).toContain('## Written after')
    expect(stripped).toContain('still mine')
    expect(stripped).not.toContain(BLOCK_START)
  })
})

/**
 * Everything below covers the three paths that used to unlink a co-owned root
 * file outright: `init` re-run, the orphaned-install overwrite, and `remove --all`.
 */
describe('upgrading an install that predates the markers', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-upgrade-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('adopts a previously generated root file instead of doubling it', async () => {
    // What a release before the markers wrote: no markers, all of it ours.
    writeFileSync(
      file,
      '# Project Instructions\n\nAll conventions, architecture, and project context are embedded below.\n\n## Agents\n\n- retired-agent\n',
    )

    const result = await writeManagedBlock(file, 'fresh generation')
    expect(result.action).toBe('adopted')
    expect(result.preservedUserContent).toBe(false)

    const text = readFileSync(file, 'utf8')
    expect(text).toContain('fresh generation')
    // The stale half must be gone, not stranded above the block.
    expect(text).not.toContain('retired-agent')
    expect(text.split(BLOCK_START)).toHaveLength(2)
  })

  it('recognises the copilot-instructions header too', async () => {
    writeFileSync(
      file,
      '<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. -->\n\n# Copilot Instructions\n\nold body\n',
    )
    const result = await writeManagedBlock(file, 'fresh')
    expect(result.action).toBe('adopted')
    expect(readFileSync(file, 'utf8')).not.toContain('old body')
  })

  it('does not mistake a hand-written file for generated output', async () => {
    writeFileSync(file, '# Acme\n\nUse pnpm. Our architecture is documented in docs/.\n')
    const result = await writeManagedBlock(file, 'fresh')
    expect(result.action).toBe('appended')
    expect(readFileSync(file, 'utf8')).toContain('Use pnpm.')
  })
})

describe('stripManagedBlockFromFile', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-strip-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("keeps the user's prose and removes only the block", async () => {
    writeFileSync(file, '# My Rules\n\nNEVER_TOUCH_PAYMENTS\n')
    await writeManagedBlock(file, 'generated')

    expect(await stripManagedBlockFromFile(file)).toBe('stripped')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('NEVER_TOUCH_PAYMENTS')
    expect(text).not.toContain('generated')
    expect(hasManagedBlock(text)).toBe(false)
  })

  it('deletes the file when nothing of the user\'s remains', async () => {
    await writeManagedBlock(file, 'generated')
    expect(await stripManagedBlockFromFile(file)).toBe('deleted')
    expect(existsSync(file)).toBe(false)
  })

  it('deletes a pre-marker generated file rather than leaving a stale copy', async () => {
    writeFileSync(file, '# Project Instructions\n\nAll conventions, architecture, and project context are embedded below.\n')
    expect(await stripManagedBlockFromFile(file)).toBe('deleted')
    expect(existsSync(file)).toBe(false)
  })

  it('reports absent for a file that was never written', async () => {
    expect(await stripManagedBlockFromFile(join(dir, 'nope.md'))).toBe('absent')
  })

  it('survives strip/write cycles without accumulating anything', async () => {
    const original = '# My Rules\n\nkeep me\n'
    writeFileSync(file, original)
    for (let i = 0; i < 4; i++) {
      await writeManagedBlock(file, `generation ${i}`)
      await stripManagedBlockFromFile(file)
      expect(readFileSync(file, 'utf8'), `cycle ${i} changed the user's half`).toBe(original)
    }
  })
})


/**
 * The promise the code makes in two places — "keep every byte of it", and
 * init's "your content is above the managed block and is never overwritten".
 *
 * The first version of this merge reflowed the user's half: it collapsed runs of
 * three or more newlines, which reaches inside fenced code blocks, and stripped
 * a trailing `---` that the user may have written themselves. Neither is an edit
 * the tool is entitled to make.
 */
describe("the user's half survives a round trip byte for byte", () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-fidelity-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const samples: Array<[string, string]> = [
    ['plain prose', '# Acme\n\nUse pnpm, never npm.\n'],
    ['a run of blank lines', '# Acme\n\n\n\nStill ours.\n'],
    ['blank lines inside a fenced block', '# Acme\n\n```text\nline one\n\n\n\nline two\n```\n'],
    ['a trailing horizontal rule', '# Acme\n\nRules below.\n\n---\n'],
    ['a horizontal rule mid-document', '# Acme\n\n---\n\nMore.\n'],
    ['trailing whitespace on a line', '# Acme\n\nTrailing spaces here:   \nand more.\n'],
    ['CRLF line endings', '# Acme\r\n\r\nWindows wrote this.\r\n'],
    ['no trailing newline', '# Acme\n\nNo newline at end.'],
  ]

  for (const [name, original] of samples) {
    it(`preserves ${name}`, async () => {
      writeFileSync(file, original)
      await writeManagedBlock(file, 'generated body')

      // Still all there, in order, while the block is present.
      const merged = readFileSync(file, 'utf8')
      expect(merged.startsWith(original)).toBe(true)

      // And handed back on the way out, byte for byte — including a file that
      // never ended in a newline, which an earlier version normalised on the way
      // in and could therefore never restore.
      await stripManagedBlockFromFile(file)
      expect(readFileSync(file, 'utf8')).toBe(original)
    })
  }

  it('never writes a separator rule of its own', async () => {
    writeFileSync(file, '# Acme\n\nNo rules here.\n')
    await writeManagedBlock(file, 'generated body')
    const text = readFileSync(file, 'utf8')
    expect((text.match(/^---$/gm) ?? []).length).toBe(0)
  })
})

/**
 * Adoption replaces the file wholesale, so its test must be for what it will
 * NOT touch as much as what it will.
 */
describe('adoption only claims a file that is generated all the way through', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-adopt-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('leaves a generated file the user prepended house rules to', async () => {
    // The realistic upgrade: someone edited their generated CLAUDE.md.
    writeFileSync(
      file,
      '# House Rules\n\nNEVER_TOUCH_PAYMENTS\n\n# Project Instructions\n\nAll conventions, architecture, and project context are embedded below.\n',
    )
    const result = await writeManagedBlock(file, 'fresh')
    expect(result.action).toBe('appended')
    expect(readFileSync(file, 'utf8')).toContain('NEVER_TOUCH_PAYMENTS')
  })

  it('leaves a hand-written file that merely quotes the banner', async () => {
    writeFileSync(
      file,
      '# Acme\n\nNote to the team: this file is managed by OpenCastle, so edit .opencastle/ instead.\n',
    )
    const result = await writeManagedBlock(file, 'fresh')
    expect(result.action).toBe('appended')
    expect(readFileSync(file, 'utf8')).toContain('Note to the team')
  })

  it('does not delete such a file on the way out either', async () => {
    writeFileSync(file, '# House Rules\n\nNEVER_TOUCH_PAYMENTS\n\n# Project Instructions\n\nAll conventions, architecture, and project context are embedded below.\n')
    expect(await stripManagedBlockFromFile(file)).toBe('stripped')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('NEVER_TOUCH_PAYMENTS')
  })
})

/**
 * A lost end marker is the one corruption the merge cannot reason about: with no
 * closing marker, our stale body and the user's own text below it are the same
 * bytes. Inserting a fresh block and leaving the old one produced a permanently
 * doubled file — two full copies of the instructions, the stale half still
 * naming deleted agents, read by the assistant as equally current — which
 * `sync --check` then certified, because it only compares the block.
 */
describe('a file whose end marker was lost', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-torn-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function tear(): Promise<void> {
    writeFileSync(file, '# Mine\n\nkeep me\n')
    await writeManagedBlock(file, 'first generation')
    writeFileSync(file, readFileSync(file, 'utf8').replace(`${BLOCK_END}\n`, ''))
  }

  it('does not treat the orphan as a block to rebuild', async () => {
    // Two readers used to disagree about a torn marker: the writer took
    // everything below it as ours and discarded it, the remover took only the
    // marker line. One deleted line could therefore either weld a stale 20KB
    // body into the file forever or delete prose written below a marker the
    // user had merely quoted. Neither reading is safe, so neither is taken.
    await tear()
    const result = await writeManagedBlock(file, 'second generation')
    expect(result.action).toBe('appended')
    expect(result.orphanMarker, 'the damage was not reported').toBe(true)
  })

  it('does not grow on repeated syncs', async () => {
    await tear()
    await writeManagedBlock(file, 'second generation')
    const once = readFileSync(file, 'utf8')
    await writeManagedBlock(file, 'second generation')
    expect(readFileSync(file, 'utf8')).toBe(once)
    expect(once.split(BLOCK_END)).toHaveLength(2)
  })

  it('takes the marker line and leaves everything else alone', async () => {
    // Three interpretations of a lone marker have shipped and all three
    // destroyed something: the body below it (prose under a quoted marker), the
    // whole span to our block (the user's rules), and — with the orderings
    // reversed — their paragraphs duplicated. Only the marker line is certainly
    // ours, so only the marker line goes.
    await tear()
    const before = readFileSync(file, 'utf8')
    expect(await stripManagedBlockFromFile(file)).toBe('stripped')

    const left = readFileSync(file, 'utf8')
    expect(left, 'the user half must survive').toContain('keep me')
    expect(left, 'the marker is ours').not.toContain(BLOCK_START)
    // The stale body stays: we cannot tell it from their writing, and guessing
    // is what caused the losses. `doctor` names the file instead.
    expect(before).toContain('first generation')
  })

  it('does not duplicate or drop user text, whichever side the marker is on', async () => {
    for (const below of [true, false]) {
      writeFileSync(file, '# Mine\n\nBEFORE\n')
      await writeManagedBlock(file, 'generated')
      const withOrphan = below
        ? `${readFileSync(file, 'utf8')}\nMIDDLE\n\n${BLOCK_START}\n\nAFTER\n`
        : `# Mine\n\nBEFORE\n\n${BLOCK_START}\n\nMIDDLE\n\n${readFileSync(file, 'utf8').slice(readFileSync(file, 'utf8').indexOf(BLOCK_START))}`
      writeFileSync(file, withOrphan)

      await stripManagedBlockFromFile(file)
      const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
      for (const line of ['BEFORE', 'MIDDLE'].concat(below ? ['AFTER'] : [])) {
        const n = left.split(line).length - 1
        expect(n, `${line} appears ${n}× with the marker ${below ? 'below' : 'above'}`).toBe(1)
      }
      expect(left).not.toContain('generated')
    }
  })

  it('agrees with what the preview predicted', async () => {
    await tear()
    const predicted = predictStrip(readFileSync(file, 'utf8'))
    const actual = await stripManagedBlockFromFile(file)
    expect(actual).toBe(predicted.outcome)
  })
})

/**
 * `hasManagedBlock` was a substring test, and `docs/quickstart.md` shows readers
 * the marker verbatim — so a CLAUDE.md documenting the convention had the
 * generated block written inside its own code fence.
 */
describe('a file that quotes the marker', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-fence-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('has the quotation adopted rather than gaining a second block', async () => {
    // The trade recorded in `blockRegions`: four rounds of trying to tell a
    // quoted marker from a real one by reading the surrounding markdown each
    // produced a version that mistook a real block for a quotation and doubled
    // the file. One block per file, always, is the property worth keeping; a
    // documented example being claimed is bounded, visible, and reversible.
    const documented = `# Our conventions\n\nOpenCastle writes a block like this:\n\n\`\`\`markdown\n${BLOCK_START}\n...generated...\n${BLOCK_END}\n\`\`\`\n`
    writeFileSync(file, documented)

    await writeManagedBlock(file, 'generated body')
    const once = readFileSync(file, 'utf8')
    expect(once.split(BLOCK_START)).toHaveLength(2)

    // And it is stable: no growth on subsequent syncs.
    await writeManagedBlock(file, 'generated body')
    expect(readFileSync(file, 'utf8')).toBe(once)
  })

  it('keeps the prose around the quotation', async () => {
    const documented = `# Our conventions\n\nBefore.\n\n\`\`\`markdown\n${BLOCK_START}\nx\n${BLOCK_END}\n\`\`\`\n\nAfter.\n`
    writeFileSync(file, documented)
    await writeManagedBlock(file, 'generated body')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# Our conventions')
    expect(text).toContain('Before.')
    expect(text).toContain('After.')
  })
})

/**
 * The shape a "keep both sides" merge resolution produces — realistic now that
 * generated config is committed. The tool used to maintain only the last block,
 * so the first was never updated again, `sync --check` compared the good one and
 * reported clean, and `remove --all` left a complete set of instructions behind.
 */
describe('a file that ends up with two real blocks', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-dupe-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function duplicate(): Promise<void> {
    writeFileSync(file, '# Mine\n\nkeep me\n')
    await writeManagedBlock(file, 'first generation')
    const text = readFileSync(file, 'utf8')
    const from = text.indexOf(BLOCK_START)
    writeFileSync(file, text + '\n' + text.slice(from))
  }

  it('collapses to one block on the next write', async () => {
    await duplicate()
    expect(readFileSync(file, 'utf8').split(BLOCK_START)).toHaveLength(3)

    await writeManagedBlock(file, 'second generation')
    const text = readFileSync(file, 'utf8')
    expect(text.split(BLOCK_START), 'still doubled').toHaveLength(2)
    expect(text).toContain('second generation')
    expect(text).not.toContain('first generation')
    expect(text).toContain('# Mine')
  })

  it('leaves nothing of ours behind on uninstall', async () => {
    await duplicate()
    await stripManagedBlockFromFile(file)
    const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
    expect(left).not.toContain(BLOCK_START)
    expect(left).not.toContain(BLOCK_END)
    expect(left).not.toContain('first generation')
    expect(left).toContain('keep me')
  })
})

/**
 * The fixture table that matters, run through the merge twice.
 *
 * Every earlier fence test stopped after one write, which is exactly why a
 * heuristic that duplicated on the *second* call shipped. One unclosed fence in
 * the user's prose made the marker we had just written look quoted, so every
 * sync appended another 20KB block, `sync --check` certified it — it compared
 * only the first copy — and `remove --all` left all of it behind. Uninstall did
 * not uninstall.
 */
describe('the merge is a fixed point, whatever the prose looks like', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-fixed-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const prose: Array<[string, string]> = [
    ['no fences', '# House rules\n\nShip fast.\n'],
    ['an unclosed fence', '# House rules\n\n```sh\nmake ship\n\n(that is all)\n'],
    ['a closed fence', '# House rules\n\n```sh\nmake ship\n```\n\nDone.\n'],
    ['two closed fences', '# A\n\n```sh\none\n```\n\n```sh\ntwo\n```\n'],
    ['a tilde fence', '# A\n\n~~~sh\nmake ship\n~~~\n'],
    ['an indented fence', '# A\n\n  ```sh\n  make ship\n  ```\n'],
    ['four backticks wrapping three', '# A\n\n````md\n```sh\nnested\n```\n````\n'],
    ['the marker quoted in a fence', `# A\n\n\`\`\`md\n${BLOCK_START}\nbody\n${BLOCK_END}\n\`\`\`\n`],
    ['the marker quoted, fence unclosed', `# A\n\n\`\`\`md\n${BLOCK_START}\nbody\n`],
    ['CRLF with a fence', '# A\r\n\r\n```sh\r\nmake ship\r\n```\r\n'],
  ]

  // The second axis: prose the user adds *below* the block, and a generated body
  // that itself contains a fence. Every fixture used to have the block last and
  // a fence-free body, so the pairing bug — a dangling fence above pairing with
  // any fence below — could not be reached. Three reviewers found it anyway.
  const BELOW = ['', '\n## Extra\n\n```js\nconsole.log(1)\n```\n', '\n## Extra\n\n```sh\nunclosed\n']
  const BODIES = ['generated body', 'generated body\n\n```bash\nnpm run build\n```\n']

  for (const [name, original] of prose) {
    for (const [bi, below] of BELOW.entries()) {
      for (const [yi, body] of BODIES.entries()) {
        it(`stays one block: ${name}, below#${bi}, body#${yi}`, async () => {
          writeFileSync(file, original)
          await writeManagedBlock(file, body)
          // The user edits underneath, then syncs again, twice.
          if (below) writeFileSync(file, readFileSync(file, 'utf8') + below)
          await writeManagedBlock(file, body)
          const once = readFileSync(file, 'utf8')
          await writeManagedBlock(file, body)

          const text = readFileSync(file, 'utf8')
          expect(text, 'the third write changed the file').toBe(once)
          // Exactly one, always. A file that quotes the marker has its quotation
          // adopted rather than gaining a second block — the documented trade,
          // because the alternative was unbounded growth.
          // One *complete* block. A fixture that already quoted a bare start
          // marker keeps that marker — it is damage, not a block, and removing
          // more than the marker line is not ours to do.
          expect(text.split(BLOCK_END).length - 1, 'not exactly one block').toBe(1)
          expect(hasManagedBlock(text), 'the block it just wrote is unfindable').toBe(true)

          // And uninstalling leaves none of our body behind.
          await stripManagedBlockFromFile(file)
          const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
          expect(left).not.toContain('npm run build\n```')
          expect(left).not.toContain('generated body')
        })
      }
    }
  }

  for (const [name, original] of prose) {
    it(`writes exactly one block into a file with ${name}`, async () => {
      writeFileSync(file, original)

      await writeManagedBlock(file, 'generated body')
      const afterFirst = readFileSync(file, 'utf8')

      const second = await writeManagedBlock(file, 'generated body')
      const afterSecond = readFileSync(file, 'utf8')

      // Byte-identical on the second pass: no growth, ever.
      expect(afterSecond, 'the second write changed the file').toBe(afterFirst)
      expect(second.action).toBe('unchanged')

      // And the user's own text is still all there, in front.
      const quotedMarker = original.includes(BLOCK_START)
      if (!quotedMarker) {
        expect(afterSecond.startsWith(original.endsWith('\n') ? original : `${original}\n`)).toBe(true)
      }
    })

    it(`removes cleanly from a file with ${name}`, async () => {
      writeFileSync(file, original)
      await writeManagedBlock(file, 'generated body')
      await stripManagedBlockFromFile(file)

      // Nothing of ours may survive an uninstall.
      const left = existsSync(file) ? readFileSync(file, 'utf8') : ''
      expect(left).not.toContain('generated body')
      if (!original.includes(BLOCK_START)) {
        expect(left).toBe(original.endsWith('\n') || original === '' ? original : `${original}\n`)
      }
    })
  }
})

/**
 * Two readers of one format is the mistake this codebase keeps making. The
 * writer's idea of "where the block is" and the checker's must never differ.
 */
describe('hasManagedBlock and extractManagedBlock agree', () => {
  const samples = [
    '# Nothing here\n',
    `${BLOCK_START}\nbody\n${BLOCK_END}\n`,
    `# A\n\n\`\`\`md\n${BLOCK_START}\nquoted\n${BLOCK_END}\n\`\`\`\n`,
    `# A\n\n\`\`\`md\n${BLOCK_START}\nquoted\n${BLOCK_END}\n\`\`\`\n\n${BLOCK_START}\nreal\n${BLOCK_END}\n`,
    `# A\n\n\`\`\`sh\nunclosed\n\n${BLOCK_START}\nreal\n${BLOCK_END}\n`,
    `${BLOCK_START}\ntorn, no end marker\n`,
  ]

  for (const [i, sample] of samples.entries()) {
    it(`sample ${i} gets one answer, not two`, () => {
      const has = hasManagedBlock(sample)
      const extracted = extractManagedBlock(sample)
      // The one legitimate difference: a block whose end marker was lost is
      // present but not extractable. Everything else must line up.
      const torn = has && !sample.includes(BLOCK_END)
      if (!torn) expect(extracted !== null).toBe(has)
    })
  }

  it('prefers the real block over one quoted above it', () => {
    const text = `# A\n\n\`\`\`md\n${BLOCK_START}\nQUOTED\n${BLOCK_END}\n\`\`\`\n\n${BLOCK_START}\nREAL\n${BLOCK_END}\n`
    expect(extractManagedBlock(text)).toBe('REAL')
  })
})
