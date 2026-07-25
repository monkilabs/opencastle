/**
 * Tests for the detected init flow.
 *
 * The default flow replaced an IDE picker plus nine multiselect screens with
 * detection and a single confirmation, so these cases cover what it infers:
 * which assistants become compile targets, and which integrations come from the
 * repository rather than from a question.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectSelection } from './init.js'
import { detectAssistantConfigs, detectRepoInfo } from './detect.js'

describe('assistant config detection', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-detect-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds nothing in an empty project', () => {
    expect(detectAssistantConfigs(dir)).toEqual([])
  })

  it('detects Claude Code from CLAUDE.md', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n')
    const found = detectAssistantConfigs(dir)
    expect(found).toHaveLength(1)
    expect(found[0].ide).toBe('claude-code')
    expect(found[0].paths).toEqual(['CLAUDE.md'])
  })

  it('collapses several files for one assistant into a single entry', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const found = detectAssistantConfigs(dir)
    expect(found).toHaveLength(1)
    expect(found[0].paths).toEqual(['CLAUDE.md', '.claude'])
  })

  it('detects several assistants at once', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n')
    writeFileSync(join(dir, '.cursorrules'), 'rules\n')
    writeFileSync(join(dir, 'GEMINI.md'), '# Project\n')

    const ides = detectAssistantConfigs(dir).map((a) => a.ide)
    expect(ides).toContain('claude-code')
    expect(ides).toContain('cursor')
    expect(ides).toContain('antigravity')
  })

  it('detects Copilot from its nested instructions file', () => {
    mkdirSync(join(dir, '.github'), { recursive: true })
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '# rules\n')
    expect(detectAssistantConfigs(dir).map((a) => a.ide)).toEqual(['vscode'])
  })
})

describe('detected selection', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-sel-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('makes every already-configured assistant a compile target', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n')
    writeFileSync(join(dir, '.cursorrules'), 'rules\n')
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')

    const repoInfo = await detectRepoInfo(dir)
    const selection = detectSelection(dir, repoInfo)

    expect(selection.ides).toContain('claude-code')
    expect(selection.ides).toContain('cursor')
  })

  it('never repeats an ide', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')

    const repoInfo = await detectRepoInfo(dir)
    const selection = detectSelection(dir, repoInfo)

    expect(selection.ides).toEqual([...new Set(selection.ides)])
  })

  it('falls back to a single target when no assistant config exists', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
    const repoInfo = await detectRepoInfo(dir)
    const selection = detectSelection(dir, repoInfo)
    expect(selection.ides).toHaveLength(1)
  })

  it('picks up integrations from dependencies without asking', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        dependencies: { next: '^15.0.0', '@supabase/supabase-js': '^2.0.0' },
        devDependencies: { vitest: '^2.0.0' },
      }),
    )

    const repoInfo = await detectRepoInfo(dir)
    const selection = detectSelection(dir, repoInfo)

    expect(selection.techTools).toContain('nextjs')
    expect(selection.techTools).toContain('supabase')
    expect(selection.techTools).toContain('vitest')
  })

  it('does not invent integrations that are not in the project', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }))
    const repoInfo = await detectRepoInfo(dir)
    const selection = detectSelection(dir, repoInfo)

    expect(selection.techTools).not.toContain('supabase')
    expect(selection.techTools).not.toContain('sanity')
    expect(selection.techTools).not.toContain('stripe')
  })

  it('keeps tech and team integrations in their own buckets', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { next: '^15.0.0' } }),
    )
    const repoInfo = await detectRepoInfo(dir)
    const selection = detectSelection(dir, repoInfo)

    // Team tools are services, never npm dependencies, so a package.json-only
    // project should produce no team selections.
    expect(selection.teamTools).toEqual([])
    expect(selection.techTools.length).toBeGreaterThan(0)
  })
})
