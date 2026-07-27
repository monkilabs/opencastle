import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { IDE_ADAPTERS } from './index.js'
import { BLOCK_START, BLOCK_END } from '../managed-block.js'
import type { StackConfig } from '../types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..', '..')

/**
 * What every adapter owes its caller, asserted once for all seven.
 *
 * The two worst reporting bugs of this branch were the same shape: a field
 * added to the merge result, wired at one call site, and silently absent at the
 * others — so `sync` said nothing about a collapse on four of seven targets,
 * and nothing about an unreducible file on three. Both were found by reviewers,
 * a round apart, as unrelated bugs.
 */
describe('every adapter reports the same things about a root file', () => {
  const ROOTS: Record<string, string> = {
    'claude-code': 'CLAUDE.md',
    opencode: 'AGENTS.md',
    codex: 'AGENTS.md',
    antigravity: 'GEMINI.md',
    cursor: '.cursorrules',
    windsurf: '.windsurfrules',
    vscode: '.github/copilot-instructions.md',
  }

  for (const [ide, root] of Object.entries(ROOTS)) {
    it(`${ide}: names a collapsed duplicate and an unreducible file`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `adapter-contract-${ide}-`))
      try {
        const adapter = await IDE_ADAPTERS[ide]()
        const stack = { ides: [ide], techTools: [], teamTools: [] } as unknown as StackConfig
        await adapter.install(pkgRoot, dir, stack, undefined)

        const path = resolve(dir, root)
        const text = readFileSync(path, 'utf8')
        const block = text.slice(text.indexOf(BLOCK_START), text.indexOf(BLOCK_END) + BLOCK_END.length)

        // Doubled, no strays: reducible, and the adapter must say it reduced it.
        writeFileSync(path, `${text}\n${block}\n`)
        const collapsed = await adapter.update(pkgRoot, dir, stack)
        expect(collapsed.repaired ?? [], `${ide} did not report the collapse`).toContain(path)

        // Doubled *and* torn: not reducible, and the adapter must say so.
        writeFileSync(path, `${BLOCK_START}\nMINE\n${block}\n${BLOCK_END}\n${block}\n`)
        const damaged = await adapter.update(pkgRoot, dir, stack)
        expect(damaged.damagedRoots ?? [], `${ide} did not report the damage`).toContain(path)
        expect(readFileSync(path, 'utf8'), `${ide} ate the user's line`).toContain('MINE')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
