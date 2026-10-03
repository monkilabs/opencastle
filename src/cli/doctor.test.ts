import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runDoctorCheck, checkMcpFromPaths } from './doctor.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import type { DoctorCheck } from './types.js'

// ── Test helper ───────────────────────────────────────────────

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'doctor-test-')))
}

// ── runDoctorCheck ────────────────────────────────────────────

describe('runDoctorCheck — file checks', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when file exists', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Instructions')
    const check: DoctorCheck = { label: 'Root file', path: 'CLAUDE.md', type: 'file' }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(true)
    expect(result.label).toBe('Root file')
  })

  it('fails when file does not exist', async () => {
    const check: DoctorCheck = { label: 'Root file', path: 'CLAUDE.md', type: 'file' }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('CLAUDE.md not found')
  })

  it('passes for nested path when file exists', async () => {
    mkdirSync(join(tmpDir, '.github'), { recursive: true })
    writeFileSync(join(tmpDir, '.github', 'copilot-instructions.md'), '# Instructions')
    const check: DoctorCheck = { label: 'Copilot instructions', path: '.github/copilot-instructions.md', type: 'file' }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(true)
  })
})

describe('runDoctorCheck — dir checks', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('fails when directory does not exist', async () => {
    const check: DoctorCheck = { label: 'Skills', path: '.claude/skills/', type: 'dir' }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('.claude/skills/ not found')
  })

  it('passes when directory exists (no countContents)', async () => {
    mkdirSync(join(tmpDir, '.claude', 'skills'), { recursive: true })
    const check: DoctorCheck = { label: 'Skills', path: '.claude/skills/', type: 'dir' }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(true)
  })

  it('fails when dir exists but no files match countFilter', async () => {
    mkdirSync(join(tmpDir, '.github', 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, '.github', 'agents', 'notes.txt'), 'not an agent')
    const check: DoctorCheck = {
      label: 'Agent definitions',
      path: '.github/agents/',
      type: 'dir',
      countContents: true,
      countFilter: '.agent.md',
    }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('No files found')
  })

  it('passes and reports count when files match countFilter', async () => {
    mkdirSync(join(tmpDir, '.github', 'agents'), { recursive: true })
    writeFileSync(join(tmpDir, '.github', 'agents', 'developer.agent.md'), '# Developer')
    writeFileSync(join(tmpDir, '.github', 'agents', 'reviewer.agent.md'), '# Reviewer')
    const check: DoctorCheck = {
      label: 'Agent definitions',
      path: '.github/agents/',
      type: 'dir',
      countContents: true,
      countFilter: '.agent.md',
    }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(true)
    expect(result.detail).toBe('2 file(s)')
  })

  it('counts all files when no countFilter specified', async () => {
    mkdirSync(join(tmpDir, '.claude', 'skills'), { recursive: true })
    writeFileSync(join(tmpDir, '.claude', 'skills', 'git-workflow.md'), '# Skill')
    writeFileSync(join(tmpDir, '.claude', 'skills', 'testing.md'), '# Skill')
    writeFileSync(join(tmpDir, '.claude', 'skills', 'unused.txt'), 'other')
    const check: DoctorCheck = {
      label: 'Skills',
      path: '.claude/skills/',
      type: 'dir',
      countContents: true,
    }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(true)
    expect(result.detail).toBe('3 file(s)')
  })

  it('fails when directory exists but is empty (countContents)', async () => {
    mkdirSync(join(tmpDir, '.github', 'instructions'), { recursive: true })
    const check: DoctorCheck = {
      label: 'Instruction files',
      path: '.github/instructions/',
      type: 'dir',
      countContents: true,
      countFilter: '.md',
    }
    const result = await runDoctorCheck(tmpDir, check)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('No files found')
  })
})

// ── checkMcpFromPaths ─────────────────────────────────────────

describe('checkMcpFromPaths', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns ok when mcp config exists', () => {
    mkdirSync(join(tmpDir, '.vscode'), { recursive: true })
    writeFileSync(join(tmpDir, '.vscode', 'mcp.json'), '{}')
    const result = checkMcpFromPaths(tmpDir, ['.vscode/mcp.json'])
    expect(result.ok).toBe(true)
    expect(result.warning).toBeFalsy()
  })

  it('returns warning when mcp config does not exist', () => {
    const result = checkMcpFromPaths(tmpDir, ['.vscode/mcp.json'])
    expect(result.ok).toBe(true)
    expect(result.warning).toBe(true)
    expect(result.detail).toContain('MCP tools unavailable')
  })

  it('returns ok with no warning when paths is empty', () => {
    const result = checkMcpFromPaths(tmpDir, [])
    expect(result.ok).toBe(true)
    expect(result.warning).toBeFalsy()
  })
})

// ── adapter getDoctorChecks ───────────────────────────────────

describe('vscode adapter getDoctorChecks', () => {
  it('returns expected checks', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    const checks = adapter.getDoctorChecks()
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.find((c) => c.path === '.github/copilot-instructions.md')?.type).toBe('file')
    expect(checks.find((c) => c.path === '.github/agents/')?.countFilter).toBe('.agent.md')
    expect(checks.find((c) => c.path === '.github/instructions/')?.countFilter).toBe('.md')
    expect(checks.find((c) => c.path === '.github/skills/')).toBeDefined()
  })
})

describe('cursor adapter getDoctorChecks', () => {
  it('returns expected checks', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    const checks = adapter.getDoctorChecks()
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.find((c) => c.path === '.cursorrules')?.type).toBe('file')
    expect(checks.find((c) => c.path === '.cursor/rules/agents/')?.countFilter).toBe('.mdc')
    expect(checks.find((c) => c.path === '.agents/skills/')?.type).toBe('dir')
  })
})

describe('claude-code adapter getDoctorChecks', () => {
  it('returns expected checks', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    const checks = adapter.getDoctorChecks()
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.find((c) => c.path === 'CLAUDE.md')?.type).toBe('file')
    expect(checks.find((c) => c.path === '.claude/agents/')).toBeDefined()
    expect(checks.find((c) => c.path === '.claude/skills/')).toBeDefined()
    // claude-code: prompts and workflows share the namespaced commands dir
    expect(checks.find((c) => c.path === '.claude/commands/oc/')).toBeDefined()
    expect(checks.find((c) => c.label === 'Commands directory')).toBeDefined()
  })
})

describe('opencode adapter getDoctorChecks', () => {
  it('returns expected checks', async () => {
    const adapter = await IDE_ADAPTERS['opencode']()
    const checks = adapter.getDoctorChecks()
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.find((c) => c.path === 'AGENTS.md')?.type).toBe('file')
    expect(checks.find((c) => c.path === '.opencode/agents/')).toBeDefined()
    expect(checks.find((c) => c.path === '.agents/skills/')).toBeDefined()
    // opencode: separate prompts and workflows dirs
    expect(checks.find((c) => c.path === '.opencode/prompts/')).toBeDefined()
    expect(checks.find((c) => c.path === '.opencode/workflows/')).toBeDefined()
  })
})

describe('all adapters satisfy getDoctorChecks interface', () => {
  const ideIds = ['vscode', 'cursor', 'claude-code', 'opencode']

  for (const ide of ideIds) {
    it(`${ide}: every check has label, path, and type`, async () => {
      const adapter = await IDE_ADAPTERS[ide]()
      const checks = adapter.getDoctorChecks()
      expect(Array.isArray(checks)).toBe(true)
      for (const c of checks) {
        expect(typeof c.label).toBe('string')
        expect(c.label.length).toBeGreaterThan(0)
        expect(typeof c.path).toBe('string')
        expect(c.path.length).toBeGreaterThan(0)
        expect(['file', 'dir']).toContain(c.type)
      }
    })
  }
})
