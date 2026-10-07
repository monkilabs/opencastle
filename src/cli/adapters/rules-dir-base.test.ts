/**
 * Tests for the shared rules-directory adapter used by Cursor and Windsurf.
 *
 * These two adapters were near-identical 400-line files before being folded into
 * one factory; they had no direct tests, only indirect coverage through init.
 * The cases below pin the parts that actually differ between the IDEs — file
 * extension and the frontmatter dialect expressing when a rule applies.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as cursor from './cursor.js'
import * as windsurf from './windsurf.js'
import type { IdeChoice, StackConfig } from '../types.js'

/** Minimal orchestrator source tree: just enough for install() to walk. */
function makePkgRoot(): string {
  const pkgRoot = mkdtempSync(join(tmpdir(), 'rules-pkg-'))
  const src = join(pkgRoot, 'src', 'orchestrator')
  for (const dir of ['instructions', 'agents', 'skills/demo-skill', 'agent-workflows', 'prompts', 'plugins']) {
    mkdirSync(join(src, dir), { recursive: true })
  }
  writeFileSync(
    join(src, 'instructions', 'general.instructions.md'),
    '---\napplyTo: "**"\ndescription: Core rules\n---\n\n# General\n\nAlways do the thing.\n',
  )
  writeFileSync(
    join(src, 'instructions', 'scoped.instructions.md'),
    '---\napplyTo: "src/**/*.ts"\n---\n\n# Scoped\n\nTypeScript only.\n',
  )
  writeFileSync(
    join(src, 'agents', 'developer.agent.md'),
    '---\ndescription: Writes code\n---\n\n# Developer\n\nDo dev work.\n',
  )
  writeFileSync(
    join(src, 'skills', 'demo-skill', 'SKILL.md'),
    '# Demo Skill\n\nSkill body. Details in [REFERENCE.md](./REFERENCE.md), and more in REFERENCE.md.\n',
  )
  writeFileSync(join(src, 'skills', 'demo-skill', 'REFERENCE.md'), '# Reference\n\nExtra detail.\n')
  writeFileSync(join(src, 'agent-workflows', 'bug-fix.md'), '# Bug Fix\n\nTriage then fix.\n')
  writeFileSync(join(src, 'agent-workflows', 'README.md'), '# Index\n\nShould be excluded.\n')
  writeFileSync(join(src, 'prompts', 'generate.prompt.md'), '# Generate\n\nPrompt body.\n')
  return pkgRoot
}

describe.each([
  {
    name: 'cursor',
    adapter: cursor,
    ext: '.mdc',
    configDir: '.cursor',
    rootFile: '.cursorrules',
    mcpPath: '.cursor/mcp.json',
  },
  {
    name: 'windsurf',
    adapter: windsurf,
    ext: '.md',
    configDir: '.windsurf',
    rootFile: '.windsurfrules',
    mcpPath: '.devin/mcp_config.json',
  },
])('$name adapter', ({ adapter, ext, configDir, rootFile, mcpPath }) => {
  // Both read Agent Skills natively, from the cross-assistant location.
  const skillsDir = '.agents/skills'
  let pkgRoot: string
  let projectRoot: string

  beforeEach(() => {
    pkgRoot = makePkgRoot()
    projectRoot = mkdtempSync(join(tmpdir(), 'rules-proj-'))
  })

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  const rules = () => join(projectRoot, configDir, 'rules')
  const skillFile = () => join(projectRoot, skillsDir, 'demo-skill', 'SKILL.md')

  it('writes the root rules file pointing at the rules directory', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const content = readFileSync(join(projectRoot, rootFile), 'utf8')
    expect(content).toContain(`${configDir}/rules/`)
  })

  it('keeps a pre-existing root rules file and merges below it', async () => {
    writeFileSync(join(projectRoot, rootFile), '# House rules\n\nUse pnpm.\n')
    await adapter.install(pkgRoot, projectRoot)

    const content = readFileSync(join(projectRoot, rootFile), 'utf8')
    expect(content).toContain('# House rules')
    expect(content).toContain('Use pnpm.')
    expect(content).toContain(`${configDir}/rules/`)
    expect(content.indexOf('# House rules')).toBeLessThan(content.indexOf('OpenCastle managed'))
  })

  it('does not duplicate the managed block across syncs', async () => {
    writeFileSync(join(projectRoot, rootFile), '# House rules\n')
    await adapter.install(pkgRoot, projectRoot)
    await adapter.update(pkgRoot, projectRoot)

    const content = readFileSync(join(projectRoot, rootFile), 'utf8')
    expect(content.split('>>> OpenCastle managed')).toHaveLength(2)
    expect(content).toContain('# House rules')
  })

  it('converts every source category to the IDE extension', async () => {
    await adapter.install(pkgRoot, projectRoot)
    expect(existsSync(join(rules(), `general${ext}`))).toBe(true)
    expect(existsSync(join(rules(), 'agents', `developer${ext}`))).toBe(true)
    expect(existsSync(skillFile())).toBe(true)
    expect(existsSync(join(rules(), 'agent-workflows', `bug-fix${ext}`))).toBe(true)
    expect(existsSync(join(rules(), 'prompts', `generate${ext}`))).toBe(true)
  })

  it('writes skills as Agent Skills, with every file and no rule copy', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const dir = join(projectRoot, skillsDir, 'demo-skill')
    expect(readdirSync(dir).sort()).toEqual(['REFERENCE.md', 'SKILL.md'])
    // Copied as written: the sibling sits beside it, so its pointer is right as it is.
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('[REFERENCE.md](./REFERENCE.md)')
    expect(existsSync(join(rules(), 'skills'))).toBe(false)
    expect(readFileSync(join(projectRoot, rootFile), 'utf8')).toContain(`Skills are in \`${skillsDir}/\``)
  })

  it('moves skills an earlier release wrote as rules, and leaves no empty folder', async () => {
    mkdirSync(join(rules(), 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(join(rules(), 'skills', `demo-skill${ext}`), 'old rule')
    writeFileSync(join(rules(), 'skills', 'demo-skill', `REFERENCE${ext}`), 'old sibling')
    const result = await adapter.update(pkgRoot, projectRoot)
    expect(existsSync(join(rules(), 'skills'))).toBe(false)
    expect(result.deleted).toContain(`${configDir}/rules/skills/demo-skill${ext}`)
    expect(existsSync(skillFile())).toBe(true)
  })

  it('excludes agent-workflows/README.md', async () => {
    await adapter.install(pkgRoot, projectRoot)
    expect(existsSync(join(rules(), 'agent-workflows', `README${ext}`))).toBe(false)
  })

  it('carries the source description into frontmatter', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const agent = readFileSync(join(rules(), 'agents', `developer${ext}`), 'utf8')
    expect(agent).toContain('description: "Writes code"')
  })

  it('falls back to the first heading when no description is declared', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const workflow = readFileSync(join(rules(), 'agent-workflows', `bug-fix${ext}`), 'utf8')
    // descriptionPrefix wins over the heading for workflows
    expect(workflow).toContain('description: "Workflow: bug-fix"')
  })

  it('preserves the body after the frontmatter', async () => {
    await adapter.install(pkgRoot, projectRoot)
    expect(readFileSync(skillFile(), 'utf8')).toContain('Skill body.')
  })

  it('skips existing files on install but overwrites them on update', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const target = join(rules(), 'agents', `developer${ext}`)
    writeFileSync(target, 'LOCAL EDIT')

    const second = await adapter.install(pkgRoot, projectRoot)
    expect(second.skipped).toContain(target)
    expect(readFileSync(target, 'utf8')).toBe('LOCAL EDIT')

    await adapter.update(pkgRoot, projectRoot)
    expect(readFileSync(target, 'utf8')).not.toBe('LOCAL EDIT')
  })

  it('clears stale generated rules on update', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const stale = join(rules(), `removed-instruction${ext}`)
    writeFileSync(stale, 'stale')
    await adapter.update(pkgRoot, projectRoot)
    expect(existsSync(stale)).toBe(false)
  })

  it('counts what changed, not what it looked at', async () => {
    const first = await adapter.install(pkgRoot, projectRoot)
    expect(first.created.length).toBeGreaterThan(0)

    // An update over an already-correct tree rewrites nothing, so it reports
    // nothing. This used to report every file, because `update` deleted the
    // rules directory first and every file was then genuinely new — which is
    // how "Updated 80 framework files" came to be printed by a sync that
    // changed not one byte.
    const noop = await adapter.update(pkgRoot, projectRoot)
    expect(noop.created).toHaveLength(0)
    expect(noop.copied).toHaveLength(0)
    expect(noop.skipped.length).toBeGreaterThan(0)

    // A file whose bytes differ from its source is rewritten, and counted.
    const target = join(rules(), 'agents', `developer${ext}`)
    writeFileSync(target, 'STALE\n')
    const changed = await adapter.update(pkgRoot, projectRoot)
    expect(changed.copied).toContain(target)
    expect(readFileSync(target, 'utf8')).not.toBe('STALE\n')
  })

  it('lists managed and doctor paths under its own config directory', () => {
    const managed = adapter.getManagedPaths()
    // Co-owned, not framework — `remove --all` may only strip its own block from it.
    expect(managed.merged).toContain(rootFile)
    expect(managed.framework).not.toContain(rootFile)
    expect(managed.customizable).toContain(mcpPath)
    for (const check of adapter.getDoctorChecks()) {
      expect(check.path === rootFile || check.path.startsWith(`${configDir}/`) || check.path === `${skillsDir}/`).toBe(true)
    }
    expect(managed.framework).toContain(`${skillsDir}/`)
  })

  it('generates only files with the IDE extension in the rules root', async () => {
    await adapter.install(pkgRoot, projectRoot)
    const rootEntries = readdirSync(rules(), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
    expect(rootEntries.length).toBeGreaterThan(0)
    for (const name of rootEntries) expect(name.endsWith(ext)).toBe(true)
  })
})

// ── Dialect differences ───────────────────────────────────────────────────────

describe('frontmatter dialects differ per IDE', () => {
  let pkgRoot: string
  let projectRoot: string

  beforeEach(() => {
    pkgRoot = makePkgRoot()
    projectRoot = mkdtempSync(join(tmpdir(), 'rules-proj-'))
  })

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('cursor expresses scope with alwaysApply and globs', async () => {
    await cursor.install(pkgRoot, projectRoot)
    const rules = join(projectRoot, '.cursor', 'rules')

    // applyTo '**' means every file, which is the same as always applying
    expect(readFileSync(join(rules, 'general.mdc'), 'utf8')).toContain('alwaysApply: true')

    // A narrower glob is carried through. Note that instructions are installed
    // with alwaysApply: true regardless, so a scoped instruction ends up with
    // both keys — and Cursor lets alwaysApply win, widening the rule to every
    // file. Pinned here as existing behavior; narrowing it is a semantic change,
    // not part of deduplicating the two adapters.
    const scoped = readFileSync(join(rules, 'scoped.mdc'), 'utf8')
    expect(scoped).toContain('globs: ["src/**/*.ts"]')
    expect(scoped).toContain('alwaysApply: true')

    // agents are description-triggered
    expect(readFileSync(join(rules, 'agents', 'developer.mdc'), 'utf8')).toContain('alwaysApply: false')
  })

  describe('cursor beside a target that writes a root file it also applies', () => {
    const stack = (...ides: IdeChoice[]): StackConfig => ({ ides: ['cursor', ...ides], techTools: [], teamTools: [] })
    const rules = () => join(projectRoot, '.cursor', 'rules')

    it('leaves the instructions to CLAUDE.md, so they load once', async () => {
      await cursor.install(pkgRoot, projectRoot, stack('claude-code'))
      expect(existsSync(join(rules(), 'general.mdc'))).toBe(false)
      // Only the team's lessons: Cursor reads CLAUDE.md, not .claude/rules/,
      // so this is the one place they reach it.
      expect(readdirSync(rules()).filter((f) => f.endsWith('.mdc'))).toEqual(['opencastle-lessons.mdc'])
      // Agents are still Cursor's own.
      expect(existsSync(join(rules(), 'agents', 'developer.mdc'))).toBe(true)
      expect(readFileSync(join(projectRoot, '.cursorrules'), 'utf8')).toContain('instructions are in `CLAUDE.md`, which Cursor also applies')
    })

    it('leaves them to AGENTS.md with Codex or OpenCode', async () => {
      await cursor.install(pkgRoot, projectRoot, stack('opencode'))
      expect(existsSync(join(rules(), 'general.mdc'))).toBe(false)
      expect(readFileSync(join(projectRoot, '.cursorrules'), 'utf8')).toContain('`AGENTS.md`')
    })

    it('writes them as rules on its own, and with a target whose file it does not read', async () => {
      await cursor.install(pkgRoot, projectRoot, stack('windsurf'))
      expect(readFileSync(join(rules(), 'general.mdc'), 'utf8')).toContain('alwaysApply: true')
    })

    it('removes the copies an earlier sync wrote once Claude Code is added', async () => {
      await cursor.install(pkgRoot, projectRoot, stack())
      expect(existsSync(join(rules(), 'general.mdc'))).toBe(true)
      const out = await cursor.update(pkgRoot, projectRoot, stack('claude-code'))
      expect(existsSync(join(rules(), 'general.mdc'))).toBe(false)
      expect(out.deleted).toContain('.cursor/rules/general.mdc')
    })

    it('has doctor check the shared file instead of an instruction rule', () => {
      const labels = (ides?: IdeChoice[]) => cursor.getDoctorChecks(ides).map((c) => `${c.label}:${c.path}`)
      expect(labels(['cursor', 'claude-code'])).toContain('Instructions (in CLAUDE.md):CLAUDE.md')
      expect(labels(['cursor'])).toContain('Instruction rules:.cursor/rules/')
      expect(labels()).toContain('Instruction rules:.cursor/rules/')
    })
  })

  it('windsurf expresses scope with a single trigger enum', async () => {
    await windsurf.install(pkgRoot, projectRoot)
    const rules = join(projectRoot, '.windsurf', 'rules')

    expect(readFileSync(join(rules, 'general.md'), 'utf8')).toContain('trigger: always_on')

    // glob and always_on are mutually exclusive here, unlike Cursor
    const scoped = readFileSync(join(rules, 'scoped.md'), 'utf8')
    expect(scoped).toContain('trigger: glob')
    expect(scoped).toContain('globs: ["src/**/*.ts"]')
    expect(scoped).not.toContain('always_on')

    expect(readFileSync(join(rules, 'agents', 'developer.md'), 'utf8')).toContain('trigger: model_decision')
  })
})
