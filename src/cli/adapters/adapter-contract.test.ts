import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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

/**
 * Every reference a compiled file makes leads somewhere, on every target.
 *
 * The source is written in one layout and compiled into seven. A relative link
 * or a folder name that is right in the source was carried into every target
 * unchanged, and 88 links led nowhere: the Team Lead sent each assistant to
 * search `.github/agent-workflows/`, which only a Copilot project has, and the
 * templates linked a `shared-delivery-phase.md` that Claude Code had named
 * `workflow-shared-delivery-phase.md` — and offered as a command of its own.
 */
describe('every compiled reference resolves', () => {
  /** Where an older release wrote the shared phase on its own, per target. */
  const LEGACY_SHARED_PHASE: Record<string, string> = {
    'claude-code': '.claude/commands/oc/workflow-shared-delivery-phase.md',
    opencode: '.opencode/workflows/shared-delivery-phase.md',
    codex: '.codex/workflows/shared-delivery-phase.md',
    antigravity: '.agents/workflows/shared-delivery-phase.md',
    cursor: '.cursor/rules/agent-workflows/shared-delivery-phase.mdc',
    windsurf: '.windsurf/rules/agent-workflows/shared-delivery-phase.md',
    vscode: '.github/agent-workflows/shared-delivery-phase.md',
  }

  function compiledFiles(dir: string): string[] {
    const out: string[] = []
    const walk = (abs: string) => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const path = join(abs, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.mdc?$/.test(entry.name)) out.push(path)
      }
    }
    walk(dir)
    return out
  }

  /** The text a reader follows: code is quoted, not referred to. */
  const prose = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

  for (const ide of Object.keys(LEGACY_SHARED_PHASE)) {
    it(`${ide}: links resolve, the templates are whole, and the Team Lead finds them`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `adapter-links-${ide}-`))
      try {
        const adapter = await IDE_ADAPTERS[ide]()
        const stack = { ides: [ide], techTools: [], teamTools: [] } as unknown as StackConfig
        await adapter.install(pkgRoot, dir, stack, undefined)
        const files = compiledFiles(dir)

        const broken: string[] = []
        for (const file of files) {
          for (const m of prose(readFileSync(file, 'utf8')).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
            if (/^[a-z]+:/i.test(m[1])) continue
            if (!existsSync(resolve(dirname(file), m[1]))) broken.push(`${relative(dir, file)} → ${m[1]}`)
          }
        }
        expect(broken, `${ide} compiled links that lead nowhere`).toEqual([])

        if (ide !== 'vscode') {
          const strays = files.filter((f) => readFileSync(f, 'utf8').includes('.github/agent-workflows/'))
          expect(strays.map((f) => relative(dir, f)), `${ide} names Copilot's folder`).toEqual([])
        }

        const teamLead = files.find((f) => /team-lead\.(agent\.md|mdc|md)$/.test(f))!
        const where = readFileSync(teamLead, 'utf8').match(/Search `([^`]+)`/)![1]
        const folder = resolve(dir, where.replace(/[^/]*\*[^/]*$/, ''))
        expect(existsSync(folder), `${ide}: the Team Lead searches ${where}`).toBe(true)

        const templates = files.filter((f) => /workflow|agent-workflows/.test(relative(dir, f)) && /Workflow:/.test(readFileSync(f, 'utf8')))
        expect(templates.length, `${ide} compiled no templates`).toBe(8)
        for (const t of templates) {
          expect(readFileSync(t, 'utf8'), `${relative(dir, t)} lacks the delivery phase`).toContain('**Do NOT merge**')
        }
        expect(files.filter((f) => f.includes('shared-delivery-phase')).map((f) => relative(dir, f))).toEqual([])

        // A project an older release compiled still has the phase on its own.
        // The next sync removes it and says so.
        const legacy = resolve(dir, LEGACY_SHARED_PHASE[ide])
        writeFileSync(legacy, readFileSync(resolve(pkgRoot, 'src/orchestrator/agent-workflows/shared-delivery-phase.md'), 'utf8'))
        const updated = await adapter.update(pkgRoot, dir, stack)
        expect(existsSync(legacy), `${ide} kept ${LEGACY_SHARED_PHASE[ide]}`).toBe(false)
        expect(updated.deleted ?? []).toContain(LEGACY_SHARED_PHASE[ide])
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })
  }
})
