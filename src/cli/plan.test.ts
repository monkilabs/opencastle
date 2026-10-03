import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  extractJson,
  fillTemplate,
  freePath,
  parseFrontmatter,
  parseValidationResult,
  runPromptStep,
  templatePath,
} from './plan.js'
import type { AgentAdapter, ExecuteOptions, Task } from './convoy/spec-types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')

// ── Templates ───────────────────────────────────────────────────────────────

describe('fillTemplate', () => {
  it('fills a placeholder only where it stands on its own line', () => {
    const body = 'When `{{goal}}` mentions X, do Y.\n\n## Goal\n\n{{goal}}\n\n## PRD\n\n  {{context}}  \n'
    const out = fillTemplate(body, 'GOAL', 'PRD TEXT')
    expect(out).toBe('When `{{goal}}` mentions X, do Y.\n\n## Goal\n\nGOAL\n\n## PRD\n\nPRD TEXT\n')
  })

  it('puts text in as written: no second pass, no replacement patterns', () => {
    const out = fillTemplate('{{goal}}\n{{context}}', 'a {{context}} and $& and $\'', 'C')
    expect(out).toBe("a {{context}} and $& and $'\nC")
  })
})

const PLANNER = {
  'generate-prd': { output: 'prd', context: false },
  'validate-prd': { output: 'validation', context: false },
  'fix-prd': { output: 'prd', context: true },
  'assess-complexity': { output: 'json', context: true },
  'generate-convoy': { output: 'json', context: true },
  'validate-convoy': { output: 'validation', context: false },
  'fix-convoy': { output: 'json', context: true },
} as const

describe('the planner templates', () => {
  it.each(Object.entries(PLANNER))('%s keeps its frontmatter and fills each input once', (name, expected) => {
    const text = readFileSync(templatePath(pkgRoot, name), 'utf8')
    const fm = parseFrontmatter(text)
    expect(Object.keys(fm).sort()).toEqual(['agent', 'description', 'output'])
    expect(fm.output).toBe(expected.output)

    // Exactly one slot per input, and no other mention that a fill could reach.
    expect(text.match(/\{\{goal\}\}/g)).toHaveLength(1)
    expect(text.match(/^[ \t]*\{\{goal\}\}[ \t]*$/gm)).toHaveLength(1)
    expect(text.match(/\{\{context\}\}/g) ?? []).toHaveLength(expected.context ? 1 : 0)
    expect(text.match(/^[ \t]*\{\{context\}\}[ \t]*$/gm) ?? []).toHaveLength(expected.context ? 1 : 0)
    expect(text).not.toMatch(/\{\{(?!goal\}\}|context\}\})/)
  })

  it.each(Object.keys(PLANNER))('%s says what the CLI does with its answer, before the inputs', (name) => {
    const text = readFileSync(templatePath(pkgRoot, name), 'utf8')
    const explained = text.search(/^## What Happens to Your (Answer|Verdict)$/m)
    expect(explained).toBeGreaterThan(0)
    expect(text).toContain('opencastle convoy')
    // Instructions first and inputs last, so the parts every call shares come
    // first and a runtime's prompt cache can reuse them.
    expect(text.indexOf('{{')).toBeGreaterThan(explained)
    expect(text.indexOf('{{')).toBeGreaterThan(text.length * 0.6)
  })
})

// ── Answers ─────────────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('takes the fenced block, up to its last fence', () => {
    expect(extractJson('Here:\n```json\n{"a": "```x```"}\n```\n')).toBe('{"a": "```x```"}')
  })

  it('takes the whole answer when there is no fence', () => {
    expect(extractJson('  {"a": 1}  ')).toBe('{"a": 1}')
  })
})

describe('parseValidationResult', () => {
  it('reads a fenced verdict', () => {
    expect(parseValidationResult('```json\n{"valid": true}\n```')).toEqual({ isValid: true, errors: '' })
    expect(parseValidationResult('```json\n{"valid": false, "issues": ["a", "b"]}\n```')).toEqual({ isValid: false, errors: 'a\nb' })
  })

  it('reads an unfenced verdict', () => {
    expect(parseValidationResult('{"valid": false, "issues": ["x"]}')).toEqual({ isValid: false, errors: 'x' })
  })

  it('falls back to the VALID / INVALID keywords', () => {
    expect(parseValidationResult('VALID').isValid).toBe(true)
    expect(parseValidationResult('INVALID\nIssues:\n- one').errors).toBe('- one')
  })
})

describe('freePath', () => {
  it('adds a number until the name is free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-free-'))
    try {
      expect(freePath(dir, 'x', '.prd.md')).toBe(join(dir, 'x.prd.md'))
      writeFileSync(join(dir, 'x.prd.md'), '')
      writeFileSync(join(dir, 'x-2.prd.md'), '')
      expect(freePath(dir, 'x', '.prd.md')).toBe(join(dir, 'x-3.prd.md'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── The step ────────────────────────────────────────────────────────────────

describe('runPromptStep', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'oc-step-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function adapterAnswering(output: string | (() => Promise<never>), success = true) {
    const seen: Array<{ task: Task; options?: ExecuteOptions }> = []
    const kill = vi.fn()
    const adapter: AgentAdapter = {
      name: 'stub',
      isAvailable: async () => true,
      execute: async (task, options) => {
        seen.push({ task, options })
        if (typeof output === 'function') return output()
        return { success, output, exitCode: success ? 0 : 2 }
      },
      kill,
    }
    return { adapter, seen, kill }
  }

  it('runs read-only, in the project, as the template agent', async () => {
    const { adapter, seen } = adapterAnswering('```json\n{"valid": true}\n```')
    const result = await runPromptStep({ template: 'validate-prd', goalText: '# PRD', adapter, pkgRoot, cwd })
    expect(result.isValid).toBe(true)
    expect(seen[0].options).toMatchObject({ permissionMode: 'plan', cwd })
    expect(seen[0].task.agent).toBe('reviewer')
    expect(seen[0].task.prompt).toContain('# PRD')
  })

  it('writes the plan on the standard tier and checks it on economy, when the runtime has tier models', async () => {
    const { adapter, seen } = adapterAnswering('```json\n{"valid": true}\n```')
    adapter.tierModels = { premium: 'opus', standard: 'sonnet', economy: 'haiku' }
    await runPromptStep({ template: 'validate-prd', goalText: '# PRD', adapter, pkgRoot, cwd })
    await runPromptStep({ template: 'generate-prd', goalText: 'add tags', adapter, pkgRoot, cwd })
    expect(seen[0].options?.model).toBe('haiku')
    expect(seen[1].options?.model).toBe('sonnet')
  })

  it('passes no model when the runtime has none for its tiers', async () => {
    const { adapter, seen } = adapterAnswering('```json\n{"valid": true}\n```')
    await runPromptStep({ template: 'validate-prd', goalText: '# PRD', adapter, pkgRoot, cwd })
    expect(seen[0].options).not.toHaveProperty('model')
  })

  it('names a Team Lead step by its slug', async () => {
    const { adapter, seen } = adapterAnswering('```json\n[]\n```')
    await runPromptStep({ template: 'fix-convoy', goalText: '{}', contextText: '- x', adapter, pkgRoot, cwd })
    expect(seen[0].task.agent).toBe('team-lead')
  })

  it('writes a PRD to a new file under .opencastle/prds', async () => {
    const { adapter } = adapterAnswering('Sure!\n# Dark Mode — PRD\n\n## Overview\n\nText.')
    const first = await runPromptStep({ template: 'generate-prd', goalText: 'dark mode', adapter, pkgRoot, cwd })
    expect(first.outputPath).toBe(join(cwd, '.opencastle', 'prds', 'dark-mode.prd.md'))
    expect(readFileSync(first.outputPath!, 'utf8')).toBe('# Dark Mode — PRD\n\n## Overview\n\nText.\n')
    const second = await runPromptStep({ template: 'generate-prd', goalText: 'dark mode', adapter, pkgRoot, cwd })
    expect(second.outputPath).toBe(join(cwd, '.opencastle', 'prds', 'dark-mode-2.prd.md'))
    expect(existsSync(first.outputPath!)).toBe(true)
  })

  it('reports an adapter failure with its output', async () => {
    const { adapter } = adapterAnswering('auth expired', false)
    await expect(runPromptStep({ template: 'validate-prd', goalText: 'x', adapter, pkgRoot, cwd })).rejects.toThrow(
      /stub failed on validate-prd \(exit code 2\)[\s\S]*auth expired/,
    )
  })

  it('stops a session that runs too long', async () => {
    const { adapter, kill } = adapterAnswering(() => new Promise<never>(() => {}))
    await expect(
      runPromptStep({ template: 'validate-prd', goalText: 'x', adapter, pkgRoot, cwd, timeoutMs: 20 }),
    ).rejects.toThrow(/ran longer than/)
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
