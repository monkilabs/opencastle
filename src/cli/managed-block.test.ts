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
  hasManagedBlock,
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

  it('handles a start marker with no end marker', () => {
    const text = `# Mine\n\n${BLOCK_START}\ntruncated`
    expect(stripManagedBlock(text)).toBe('# Mine\n\n')
  })
})
