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

  it('keeps text below the block when the end marker was lost', () => {
    // A hand edit or a merge resolution can delete the closing marker. Treating
    // "no end marker" as "block runs to EOF" silently ate everything below it.
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
      expect(merged.startsWith(original.endsWith('\n') ? original : `${original}\n`)).toBe(true)

      // And handed back on the way out. A file with no trailing newline gains
      // one — the block has to start on its own line — and that is the only
      // byte this is allowed to change.
      await stripManagedBlockFromFile(file)
      const after = readFileSync(file, 'utf8')
      expect(after).toBe(original.endsWith('\n') ? original : `${original}\n`)
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
    writeFileSync(file, readFileSync(file, 'utf8').replace(BLOCK_END, ''))
  }

  it('rebuilds one block instead of doubling the file', async () => {
    await tear()
    const result = await writeManagedBlock(file, 'second generation')
    expect(result.action).toBe('repaired')

    const text = readFileSync(file, 'utf8')
    expect(text.split(BLOCK_START)).toHaveLength(2)
    expect(text.split(BLOCK_END)).toHaveLength(2)
    expect(text).toContain('second generation')
    expect(text).not.toContain('first generation')
    expect(text).toContain('# Mine')
  })

  it('keeps the torn file recoverable', async () => {
    await tear()
    await writeManagedBlock(file, 'second generation')
    const backup = `${file}.opencastle-backup`
    expect(existsSync(backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toContain('first generation')
  })

  it('is a fixed point — repairing twice changes nothing', async () => {
    await tear()
    await writeManagedBlock(file, 'stable')
    const once = readFileSync(file, 'utf8')
    const second = await writeManagedBlock(file, 'stable')
    expect(second.action).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe(once)
  })
})

/**
 * `hasManagedBlock` was a substring test, and `docs/quickstart.md` shows readers
 * the marker verbatim — so a CLAUDE.md documenting the convention had the
 * generated block written inside its own code fence.
 */
describe('a marker quoted inside a code fence is not a block', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-block-fence-'))
    file = join(dir, 'CLAUDE.md')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends below rather than writing into the fence', async () => {
    const documented = `# Our conventions\n\nOpenCastle writes a block like this:\n\n\`\`\`markdown\n${BLOCK_START}\n...generated...\n${BLOCK_END}\n\`\`\`\n\nDo not edit inside it.\n`
    writeFileSync(file, documented)

    const result = await writeManagedBlock(file, 'generated body')
    expect(result.action).toBe('appended')

    const text = readFileSync(file, 'utf8')
    expect(text.startsWith(documented)).toBe(true)
    expect(text).toContain('generated body')
    // The real block sits after the fenced example, not inside it.
    expect(text.lastIndexOf(BLOCK_START)).toBeGreaterThan(text.indexOf('Do not edit inside it.'))
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
