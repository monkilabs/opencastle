import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as yamlParse } from 'yaml'
import type { AgentAdapter, ExecuteOptions, Task } from './convoy/spec-types.js'

/**
 * The planner, end to end, against a stub adapter: what it asks, how often, with
 * what authority, and what it does with the answers. No agent CLI is started —
 * the adapter is an object, and the CLI entry's adapter lookup, confirmation
 * prompt and run module are replaced.
 */

vi.mock('./run.js', () => ({ runSpec: vi.fn(async () => 0), exitWith: vi.fn() }))
vi.mock('./run/adapters/index.js', () => ({
  resolveAdapter: vi.fn(),
  cleanupAdapters: vi.fn(async () => {}),
}))
vi.mock('./prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompt.js')>()),
  confirm: vi.fn(),
  closePrompts: vi.fn(),
}))

const { planConvoy, hashPrd, deriveComplexityPath, planTask, renderPlan, default: pipeline } = await import('./pipeline.js')
const runModule = await import('./run.js')
const adapters = await import('./run/adapters/index.js')
const promptModule = await import('./prompt.js')

const pkgRoot = resolve(import.meta.dirname, '..', '..')

// ── The stub runtime ────────────────────────────────────────────────────────

const PRD = `# Dark Mode — PRD

## Overview

PRD-MARKER Add a dark mode toggle.

## Goals

1. A toggle switches the theme.

## Task Breakdown

Phase 1 — Theme:
  - Tokens: Files: src/theme.ts
Phase 2 — UI (depends on Phase 1):
  - Toggle: Files: src/toggle.ts
Phase 3 — Docs:
  - Docs: Files: docs/theme.md
Phase 4 — Tests (depends on Phase 2):
  - Tests: Files: test/theme.test.ts
`

const fence = (value: unknown): string => '```json\n' + JSON.stringify(value, null, 2) + '\n```'

const SINGLE = {
  original_prompt: 'add dark mode',
  total_tasks: 2,
  total_phases: 2,
  domains: ['frontend'],
  complexity: 'medium',
  recommended_strategy: 'single',
  convoy_groups: [{ name: 'all', description: 'All', phases: [1, 2], depends_on: [] }],
  task_complexity: [{ workstream: 'Tokens', phase: 1, complexity: 2, rationale: 'small' }],
}

const CHAIN = {
  ...SINGLE,
  total_tasks: 12,
  total_phases: 4,
  complexity: 'high',
  recommended_strategy: 'chain',
  convoy_groups: [
    { name: 'theme', description: 'Theme', phases: [1], depends_on: [] },
    { name: 'docs', description: 'Docs', phases: [3], depends_on: [] },
    { name: 'ui', description: 'UI and tests', phases: [2, 4], depends_on: ['theme', 'docs'] },
  ],
}

const PLAN = {
  name: 'Dark mode',
  tasks: [
    { id: 'theme', agent: 'developer', files: ['src/theme.ts'], complexity: 2, prompt: 'Add tokens to src/theme.ts.' },
    { id: 'toggle', agent: 'ui-ux-expert', files: ['src/toggle.ts'], depends_on: ['theme'], prompt: 'Add the toggle.' },
  ],
}

type Answer = string | ((prompt: string, nth: number) => string | Promise<string>)

interface Call {
  template: string
  permissionMode?: string
  cwd?: string
  prompt: string
  effort?: string
  lean?: boolean
}

/** An answer that never comes: the session runs until it is stopped. */
const never = (): Promise<string> => new Promise(() => {})

function stubAdapter(answers: Record<string, Answer> = {}): { adapter: AgentAdapter; calls: Call[]; killed: string[] } {
  const calls: Call[] = []
  const killed: string[] = []
  const stoppers = new Map<string, Array<() => void>>()
  const seen = new Map<string, number>()
  const defaults: Record<string, Answer> = {
    'convoy-prd': PRD,
    'convoy-prd-fix': PRD,
    'convoy-prd-review': fence({ valid: true }),
    'convoy-assess': fence(SINGLE),
    'convoy-plan': fence(PLAN),
    'convoy-plan-review': fence({ valid: true }),
    'convoy-plan-fix': fence([]),
  }
  const adapter: AgentAdapter = {
    name: 'stub',
    isAvailable: async () => true,
    async execute(task: Task, options?: ExecuteOptions) {
      calls.push({
        template: task.id,
        permissionMode: options?.permissionMode,
        cwd: options?.cwd,
        prompt: task.prompt,
        effort: options?.effort,
        lean: options?.lean,
      })
      const nth = (seen.get(task.id) ?? 0) + 1
      seen.set(task.id, nth)
      const answer = answers[task.id] ?? defaults[task.id]
      // Stopped like a real runtime: the process ends and reports a failure.
      const stopped = new Promise<null>((r) => stoppers.set(task.id, [...(stoppers.get(task.id) ?? []), () => r(null)]))
      const output = await Promise.race([typeof answer === 'function' ? answer(task.prompt, nth) : answer, stopped])
      if (output === null) return { success: false, output: 'stopped', exitCode: 143 }
      return { success: true, output, exitCode: 0 }
    },
    kill(task: Task) {
      killed.push(task.id)
      for (const stop of stoppers.get(task.id) ?? []) stop()
      stoppers.delete(task.id)
    },
  }
  return { adapter, calls, killed }
}

const templates = (calls: Call[]): string[] => calls.map((c) => c.template)
const count = (calls: Call[], template: string): number => calls.filter((c) => c.template === template).length

// ── A scratch project ───────────────────────────────────────────────────────

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-planner-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc' } }),
  )
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(runModule.runSpec).mockClear()
  vi.mocked(runModule.exitWith).mockClear()
  vi.mocked(promptModule.confirm).mockReset()
  rmSync(root, { recursive: true, force: true })
})

function plan(adapter: AgentAdapter, extra: Partial<Parameters<typeof planConvoy>[0]> = {}) {
  return planConvoy({ task: 'add dark mode', adapter, adapterName: 'claude', pkgRoot, projectRoot: root, ...extra })
}

// ── Sessions ────────────────────────────────────────────────────────────────

describe('planConvoy: sessions', () => {
  it('starts five sessions when every answer is good, with no semantic review of the plan', async () => {
    const { adapter, calls } = stubAdapter()
    const outcome = await plan(adapter)
    // The plan from the request is dropped once the size says a PRD is needed;
    // the plan from the PRD is the one kept.
    expect([...templates(calls)].sort()).toEqual([
      'convoy-assess', 'convoy-plan', 'convoy-plan', 'convoy-prd', 'convoy-prd-review',
    ])
    expect(outcome.problems).toEqual([])
  })

  it('runs every planning session read-only, in the project', async () => {
    const { adapter, calls } = stubAdapter({ 'convoy-prd-review': (_p, n) => fence(n === 1 ? { valid: false, issues: ['x'] } : { valid: true }) })
    await plan(adapter, { critic: true })
    expect(calls.length).toBeGreaterThan(4)
    for (const call of calls) {
      expect(call.permissionMode, call.template).toBe('plan')
      expect(call.cwd, call.template).toBe(root)
    }
  })

  it('sends the PRD to convoy-plan once', async () => {
    const { adapter, calls } = stubAdapter()
    await plan(adapter)
    const fromPrd = calls.filter((c) => c.template === 'convoy-plan' && c.prompt.includes('PRD-MARKER'))
    expect(fromPrd).toHaveLength(1)
    expect(fromPrd[0].prompt.match(/PRD-MARKER/g)).toHaveLength(1)
    expect(fromPrd[0].prompt).not.toMatch(/\{\{(goal|context)\}\}/)
  })

  it('plans a small change straight from the request, with no PRD', async () => {
    const { adapter, calls } = stubAdapter({ 'convoy-assess': fence({ ...SINGLE, complexity: 'low' }) })
    const outcome = await plan(adapter)
    // The PRD starts beside the size too; here it finished first, and is not kept.
    expect([...templates(calls)].sort()).toEqual(['convoy-assess', 'convoy-plan', 'convoy-prd'])
    expect(outcome.prdPath).toBeNull()
    expect(existsSync(join(root, '.opencastle', 'prds'))).toBe(false)
    expect(calls.find((c) => c.template === 'convoy-plan')!.prompt).toContain('There is no PRD: this is a small change')
    expect(outcome.problems).toEqual([])
  })

  it('sizes a request and plans it at the same time', async () => {
    let inFlight = 0
    let most = 0
    const overlap = (answer: string) => async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return answer
    }
    const { adapter } = stubAdapter({
      'convoy-assess': overlap(fence({ ...SINGLE, complexity: 'low' })),
      'convoy-plan': overlap(fence(PLAN)),
    })
    await plan(adapter)
    expect(most).toBe(2)
  })

  it('stops the PRD as soon as the size says the change is small', async () => {
    const { adapter, killed } = stubAdapter({
      'convoy-assess': fence({ ...SINGLE, complexity: 'low' }),
      'convoy-prd': never,
    })
    const outcome = await plan(adapter)
    expect(killed).toEqual(['convoy-prd'])
    expect(outcome.prdPath).toBeNull()
    expect(outcome.plan.name).toBe('Dark mode')
  })

  it('stops the plan from the request as soon as the size says a PRD is needed', async () => {
    const { adapter, calls, killed } = stubAdapter({
      'convoy-plan': (prompt) => (prompt.includes('PRD-MARKER') ? fence(PLAN) : never()),
    })
    const outcome = await plan(adapter)
    expect(killed).toEqual(['convoy-plan'])
    expect(outcome.prdPath).not.toBeNull()
    expect(outcome.plan.name).toBe('Dark mode')
    // A stopped session counts, and makes the cost a lower bound.
    expect(outcome.planning?.sessions).toBe(calls.length)
    expect(outcome.planning?.costComplete).toBe(false)
  })

  it('plans from the PRD beside its review, and again from the fixed PRD when the review fails', async () => {
    const fixedPrd = PRD.replace('PRD-MARKER', 'FIXED-MARKER')
    const { adapter, calls, killed } = stubAdapter({
      'convoy-prd-review': (_p, n) => fence({ valid: n > 1, issues: ['US-1: unclear'] }),
      'convoy-prd-fix': fixedPrd,
      // The plan from the request ends at once; the one from the draft PRD
      // runs until it is stopped.
      'convoy-plan': (prompt) => (prompt.includes('PRD-MARKER') ? never() : fence(PLAN)),
    })
    const outcome = await plan(adapter)
    expect(killed).toEqual(['convoy-plan'])
    const last = calls.filter((c) => c.template === 'convoy-plan').at(-1)!
    expect(last.prompt).toContain('FIXED-MARKER')
    expect(outcome.problems).toEqual([])
  })

  it('asks for medium effort for the plan and low for every other step, all lean', async () => {
    const { adapter, calls } = stubAdapter({ 'convoy-prd-review': (_p, n) => fence({ valid: n > 1, issues: ['x'] }) })
    await plan(adapter, { critic: true })
    expect(new Set(calls.map((c) => c.template)).size).toBeGreaterThanOrEqual(6)
    for (const call of calls) {
      expect(call.effort, call.template).toBe(call.template === 'convoy-plan' ? 'medium' : 'low')
      expect(call.lean, call.template).toBe(true)
    }
  })

  it('sizes a larger request once, and does not size its PRD again', async () => {
    const { adapter, calls } = stubAdapter()
    await plan(adapter)
    expect(count(calls, 'convoy-assess')).toBe(1)
    expect(templates(calls).slice(0, 3).sort()).toEqual(['convoy-assess', 'convoy-plan', 'convoy-prd'])
  })

  it('fixes an invalid PRD at most twice, then plans from it anyway', async () => {
    const { adapter, calls } = stubAdapter({ 'convoy-prd-review': fence({ valid: false, issues: ['Overview: thin'] }) })
    const outcome = await plan(adapter)
    expect(count(calls, 'convoy-prd-fix')).toBe(2)
    expect(count(calls, 'convoy-prd-review')).toBe(3)
    // Planned from the request, from the draft beside its review, and from the PRD as fixed.
    expect(count(calls, 'convoy-plan')).toBe(3)
    expect(calls).toHaveLength(10)
    expect(templates(calls).at(-1)).toBe('convoy-plan')
    expect(outcome.problems).toEqual([])
  })

  it('stops fixing the PRD as soon as it passes', async () => {
    const { adapter, calls } = stubAdapter({ 'convoy-prd-review': (_p, n) => fence({ valid: n > 1, issues: ['x'] }) })
    await plan(adapter)
    expect(count(calls, 'convoy-prd-fix')).toBe(1)
    expect(calls).toHaveLength(8)
  })

  it('asks convoy-plan-fix only when the checks fail, and never convoy-plan-review', async () => {
    const bad = { ...PLAN, tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], timeout: 'soon' }] }
    const { adapter, calls } = stubAdapter({
      'convoy-plan': fence(bad),
      'convoy-plan-fix': fence([{ task_id: 'toggle', field: 'timeout', value: '10m' }]),
    })
    const outcome = await plan(adapter)
    expect(count(calls, 'convoy-plan-fix')).toBe(1)
    expect(count(calls, 'convoy-plan-review')).toBe(0)
    expect(calls).toHaveLength(6)
    expect(outcome.problems).toEqual([])
  })

  it('retries an unreadable plan once', async () => {
    // The plan that is kept, from the PRD; the one from the request is dropped
    // as soon as the size is known, whether or not it got to its own retry.
    let fromPrd = 0
    const { adapter, calls } = stubAdapter({
      'convoy-plan': (prompt) =>
        prompt.includes('PRD-MARKER') && fromPrd++ === 0 ? 'Sorry, here you go: {' : fence(PLAN),
    })
    const outcome = await plan(adapter)
    expect(calls.filter((c) => c.template === 'convoy-plan' && c.prompt.includes('PRD-MARKER'))).toHaveLength(2)
    expect(outcome.plan.name).toBe('Dark mode')
  })

  it('keeps the unreadable answer for inspection when the retry fails too', async () => {
    const { adapter } = stubAdapter({ 'convoy-plan': 'not a plan' })
    await expect(plan(adapter)).rejects.toThrow(/could not be read after a retry/)
    expect(readdirSync(join(root, '.opencastle', 'convoys')).some((f) => f.endsWith('.task-plan.json'))).toBe(true)
  })

  it('is bounded in the worst case, and reports what is left', async () => {
    const bad = { ...PLAN, tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], timeout: 'soon' }] }
    let fromFixed = 0
    const { adapter, calls } = stubAdapter({
      'convoy-prd-review': fence({ valid: false, issues: ['x'] }),
      // Only the plan that is kept, from the PRD as fixed, is unreadable once.
      'convoy-plan': (prompt) =>
        prompt.includes('PRD-MARKER') && calls.some((c) => c.template === 'convoy-prd-fix') && fromFixed++ === 0
          ? '```json\n{ "name": "x", "tasks": [\n```'
          : fence(bad),
      'convoy-plan-fix': fence([{ task_id: 'toggle', field: 'timeout', value: 'later' }]),
    })
    const outcome = await plan(adapter, { critic: true })
    // assess ‖ the plan from the request, convoy-prd, convoy-prd-review ‖ the plan
    // from the draft, 2 × (convoy-prd-fix + convoy-prd-review), 2 × convoy-plan (one
    // unreadable), 2 × convoy-plan-fix.
    expect(calls).toHaveLength(13)
    expect(count(calls, 'convoy-plan-review')).toBe(0) // no review of a plan that cannot run
    expect(outcome.problems.join('\n')).toContain('timeout')
  })

  it('sequences a file conflict that survives the fix rounds instead of failing', async () => {
    const clash = {
      name: 'Clash',
      tasks: [
        { id: 'a', prompt: 'a', files: ['src/components/'] },
        { id: 'b', prompt: 'b', files: ['src/components/Hero.tsx'] },
      ],
    }
    const { adapter, calls } = stubAdapter({ 'convoy-plan': fence(clash) })
    const outcome = await plan(adapter)
    expect(count(calls, 'convoy-plan-fix')).toBe(2)
    expect(outcome.problems).toEqual([])
    expect(outcome.plan.tasks[1].depends_on).toEqual(['a'])
  })

  it('reviews the plan only for --yes, and keeps a revision only if it still passes', async () => {
    const { adapter, calls } = stubAdapter({
      'convoy-plan-review': fence({ valid: false, issues: ['toggle: needs the theme docs'] }),
      'convoy-plan-fix': fence([{ task_id: 'toggle', field: 'prompt', value: 'Add the toggle; read docs first.' }]),
    })
    const outcome = await plan(adapter, { critic: true })
    expect(templates(calls).slice(-2)).toEqual(['convoy-plan-review', 'convoy-plan-fix'])
    expect(calls).toHaveLength(7)
    expect(outcome.plan.tasks[1].prompt).toBe('Add the toggle; read docs first.')

    const broken = stubAdapter({
      'convoy-plan-review': fence({ valid: false, issues: ['x'] }),
      'convoy-plan-fix': fence([{ task_id: 'toggle', field: 'depends_on', value: ['ghost'] }]),
    })
    const kept = await plan(broken.adapter, { critic: true })
    expect(kept.plan.tasks[1].depends_on).toEqual(['theme'])
    expect(kept.problems).toEqual([])
  })
})

// ── Chain groups ────────────────────────────────────────────────────────────

describe('planConvoy: groups', () => {
  /** convoy-plan for a group waits until every group's session has started. */
  function groupAnswers() {
    let started = 0
    let most = 0
    let release!: () => void
    const allStarted = new Promise<void>((r) => (release = r))
    const answer = async (prompt: string) => {
      const name = /\*\*Group name:\*\*\s*([a-z-]+)/.exec(prompt)![1]
      started++
      most = Math.max(most, started)
      if (started === 3) release()
      // Planned one after another, the first would wait here for the others,
      // which would never start; the timeout keeps that failure from hanging.
      await Promise.race([allStarted, new Promise((r) => setTimeout(r, 1000))])
      return fence({
        name,
        tasks: [
          { id: 'setup', prompt: `set up ${name}`, files: [`src/${name}/setup.ts`] },
          { id: `work-${name}`, prompt: `work ${name}`, files: [`src/${name}/work.ts`], depends_on: ['setup'] },
        ],
      })
    }
    return { answer, most: () => most }
  }

  it('sizes the PRD beside its review when the work is planned in groups', async () => {
    let inFlight = 0
    let most = 0
    const slow = (answer: string) => async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return answer
    }
    const groups = groupAnswers()
    const { adapter } = stubAdapter({
      'convoy-prd-review': slow(fence({ valid: true })),
      'convoy-assess': slow(fence(CHAIN)),
      'convoy-plan': groups.answer,
    })
    await plan(adapter)
    expect(most).toBe(2)
  })

  it('plans every group at the same time, from its own part of the PRD', async () => {
    const groups = groupAnswers()
    const { adapter, calls } = stubAdapter({ 'convoy-assess': fence(CHAIN), 'convoy-plan': groups.answer })
    await plan(adapter)
    expect(groups.most()).toBe(3)
    expect(calls.filter((c) => c.template === 'convoy-plan' && c.prompt.includes('**Group name:**'))).toHaveLength(3)
    // The request is sized (beside its dropped plan), then the PRD again:
    // groups name the PRD's phases.
    expect(calls).toHaveLength(8)
    const docs = calls.find((c) => c.template === 'convoy-plan' && c.prompt.includes('**Group name:** docs'))!
    expect(docs.prompt).not.toContain('Phase 1 — Theme')
  })

  it('joins the groups into one spec that keeps their dependencies', async () => {
    const groups = groupAnswers()
    const { adapter } = stubAdapter({ 'convoy-assess': fence(CHAIN), 'convoy-plan': groups.answer })
    const outcome = await plan(adapter)
    expect(readdirSync(join(root, '.opencastle', 'convoys')).filter((f) => f.endsWith('.convoy.yml'))).toHaveLength(1)
    const spec = yamlParse(readFileSync(outcome.specPath, 'utf8'))
    expect(spec.name).toBe('Dark Mode')
    expect(spec.depends_on_convoy).toBeUndefined()
    const byId = new Map<string, { depends_on?: string[] }>(spec.tasks.map((t: { id: string }) => [t.id, t]))
    expect(byId.get('ui-setup')!.depends_on).toEqual(['work-theme', 'work-docs'])
    expect(byId.get('setup')!.depends_on).toBeUndefined()
    expect(byId.get('docs-setup')!.depends_on).toBeUndefined()
  })
})

// ── The spec ────────────────────────────────────────────────────────────────

describe('planConvoy: the spec', () => {
  it('is safe and fast by default', async () => {
    const { adapter } = stubAdapter()
    const outcome = await plan(adapter)
    expect(outcome.specPath).toBe(join(root, '.opencastle', 'convoys', 'dark-mode.convoy.yml'))
    const spec = yamlParse(readFileSync(outcome.specPath, 'utf8'))
    expect(spec.branch).toBe('convoy/dark-mode')
    expect(spec.on_failure).toBe('continue')
    expect(spec.adapter).toBe('claude')
    expect(spec.concurrency).toBe(1)
    expect(spec.gates).toEqual(['pnpm run typecheck', 'pnpm run lint', 'pnpm run test'])
    expect(spec.defaults.detect_drift).toBeUndefined()
    expect(spec.defaults.built_in_gates).toBeUndefined()
  })

  it('reduces a glob the planner wrote to a directory', async () => {
    const globbed = { ...PLAN, tasks: [{ ...PLAN.tasks[0], files: ['src/theme/**/*.ts'] }, PLAN.tasks[1]] }
    const { adapter } = stubAdapter({ 'convoy-plan': fence(globbed) })
    const outcome = await plan(adapter)
    expect(outcome.plan.tasks[0].files).toEqual(['src/theme/'])
  })

  it('does not overwrite an earlier spec or PRD with the same title', async () => {
    const first = await plan(stubAdapter().adapter)
    const second = await plan(stubAdapter().adapter)
    expect(second.specPath).not.toBe(first.specPath)
    expect(second.prdPath).not.toBe(first.prdPath)
    expect(yamlParse(readFileSync(second.specPath, 'utf8')).branch).toBe('convoy/dark-mode-2')
  })
})

// ── The complexity cache ────────────────────────────────────────────────────

describe('planConvoy: the complexity cache', () => {
  function writePrd(text: string): string {
    const dir = join(root, '.opencastle', 'prds')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'dark-mode.prd.md')
    writeFileSync(path, text)
    return path
  }

  it('assesses a PRD once, and again when its text changes', async () => {
    const prdPath = writePrd(PRD)
    const first = stubAdapter()
    await plan(first.adapter, { task: undefined, prdPath })
    expect(count(first.calls, 'convoy-assess')).toBe(1)
    expect(count(first.calls, 'convoy-prd')).toBe(0)

    const second = stubAdapter()
    await plan(second.adapter, { task: undefined, prdPath })
    expect(count(second.calls, 'convoy-assess')).toBe(0)

    writePrd(PRD + '\nOne more line.\n')
    const third = stubAdapter()
    await plan(third.adapter, { task: undefined, prdPath })
    expect(count(third.calls, 'convoy-assess')).toBe(1)
  })

  it('ignores an assessment of different text at the same path', async () => {
    const prdPath = writePrd(PRD)
    const stale = { prd_sha256: hashPrd('a different request'), ...CHAIN }
    writeFileSync(deriveComplexityPath(prdPath), JSON.stringify(stale))
    const { adapter, calls } = stubAdapter()
    await plan(adapter, { task: undefined, prdPath })
    expect(count(calls, 'convoy-assess')).toBe(1)
    const cached = JSON.parse(readFileSync(deriveComplexityPath(prdPath), 'utf8'))
    expect(cached.prd_sha256).toBe(hashPrd(PRD))
    expect(cached.recommended_strategy).toBe('single')
  })
})

// ── The command ─────────────────────────────────────────────────────────────

describe('convoy "<task>": show the plan, ask once', () => {
  let stub: ReturnType<typeof stubAdapter>
  let output: string[]

  const resolved = (adapter: AgentAdapter) => ({
    name: 'claude',
    adapter,
    source: 'configured' as const,
    detail: 'Claude Code — configured by opencastle init',
  })

  beforeEach(() => {
    stub = stubAdapter()
    vi.mocked(adapters.resolveAdapter).mockReset().mockResolvedValue(resolved(stub.adapter))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    output = []
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => void output.push(args.join(' ')))
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => void output.push(args.join(' ')))
  })

  const text = (): string => output.join('\n')
  const specFile = (): string => join(root, '.opencastle', 'convoys', 'dark-mode.convoy.yml')
  const runArgs = (extra: Record<string, unknown> = {}) => ({
    spec: specFile(), dryRun: false, adapter: null, concurrency: null, verbose: false, help: false, ...extra,
  })

  it('prints the plan as a table, then the spec, then asks', async () => {
    vi.mocked(promptModule.confirm).mockImplementation(async () => {
      expect(text()).toMatch(/TASK\s+AGENT\s+DEPENDS ON\s+FILES/)
      expect(text()).toMatch(/theme\s+developer\s+–\s+src\/theme\.ts/)
      expect(text()).toMatch(/toggle\s+ui-ux-expert\s+theme\s+src\/toggle\.ts/)
      expect(text()).toContain('.opencastle/convoys/dark-mode.convoy.yml')
      return true
    })
    await planTask({ args: ['--adapter', 'claude'], pkgRoot }, 'add dark mode')
    expect(promptModule.confirm).toHaveBeenCalledWith('Run it?', true, 'refuse')
    // The run gets the spec by its path, on the runtime the planner chose.
    expect(runModule.runSpec).toHaveBeenCalledWith(runArgs({ adapter: 'claude' }), { runtime: resolved(stub.adapter) })
    expect(runModule.exitWith).toHaveBeenCalledWith(0)
  })

  it('says which runtime it plans on, once, and why', async () => {
    vi.mocked(promptModule.confirm).mockResolvedValue(false)
    await planTask({ args: [], pkgRoot }, 'add dark mode')
    expect(text().match(/Claude Code — configured by opencastle init/g)).toHaveLength(1)
  })

  it('runs without asking with --yes, after the review', async () => {
    await planTask({ args: ['--yes'], pkgRoot }, 'add dark mode')
    expect(promptModule.confirm).not.toHaveBeenCalled()
    expect(runModule.runSpec).toHaveBeenCalledWith(runArgs(), { runtime: resolved(stub.adapter) })
    expect(count(stub.calls, 'convoy-plan-review')).toBe(1)
  })

  it('carries --concurrency through to the run', async () => {
    await planTask({ args: ['-y', '-c', '2'], pkgRoot }, 'add dark mode')
    expect(runModule.runSpec).toHaveBeenCalledWith(runArgs({ concurrency: 2 }), { runtime: resolved(stub.adapter) })
  })

  it('exits with the code the run ended with', async () => {
    vi.mocked(runModule.runSpec).mockResolvedValueOnce(130)
    await planTask({ args: ['--yes'], pkgRoot }, 'add dark mode')
    expect(runModule.exitWith).toHaveBeenCalledWith(130)
  })

  it('does not run when nobody answers, and says how to run it later', async () => {
    // What confirm(…, 'refuse') returns on a closed stdin.
    vi.mocked(promptModule.confirm).mockResolvedValue(false)
    await planTask({ args: [], pkgRoot }, 'add dark mode')
    expect(runModule.runSpec).not.toHaveBeenCalled()
    expect(text()).toContain('opencastle convoy run .opencastle/convoys/dark-mode.convoy.yml')
  })

  it('plans, shows and writes the spec with --dry-run, and does not run or ask', async () => {
    await planTask({ args: ['--dry-run', '--yes'], pkgRoot }, 'add dark mode')
    expect(existsSync(specFile())).toBe(true)
    expect(text()).toMatch(/TASK\s+AGENT/)
    expect(promptModule.confirm).not.toHaveBeenCalled()
    expect(runModule.runSpec).not.toHaveBeenCalled()
    expect(count(stub.calls, 'convoy-plan-review')).toBe(0)
    expect(text()).toContain('opencastle convoy run .opencastle/convoys/dark-mode.convoy.yml')
  })

  it('resolves the runtime once for the whole plan', async () => {
    vi.mocked(promptModule.confirm).mockResolvedValue(false)
    await planTask({ args: [], pkgRoot }, 'add dark mode')
    expect(adapters.resolveAdapter).toHaveBeenCalledTimes(1)
    expect(adapters.resolveAdapter).toHaveBeenCalledWith({ projectRoot: root, explicit: null })
    expect(stub.calls.length).toBe(5)
  })

  it('stops before planning when no runtime can be found', async () => {
    vi.mocked(adapters.resolveAdapter).mockRejectedValue(new Error('No agent CLI found on PATH.'))
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    await expect(planTask({ args: [], pkgRoot }, 'add dark mode')).rejects.toThrow('exit 1')
    expect(text()).toContain('No agent CLI found on PATH.')
    expect(stub.calls).toHaveLength(0)
  })

  it('re-plans from a PRD with convoy plan --prd, without writing a new one', async () => {
    const prd = join(root, 'my.prd.md')
    writeFileSync(prd, PRD)
    vi.mocked(promptModule.confirm).mockResolvedValue(false)
    await pipeline({ args: ['--prd', 'my.prd.md'], pkgRoot })
    expect(count(stub.calls, 'convoy-prd')).toBe(0)
    expect(existsSync(specFile())).toBe(true)
  })

  it('does not offer to run a plan that fails its checks', async () => {
    const bad = { ...PLAN, tasks: [PLAN.tasks[0], { ...PLAN.tasks[1], timeout: 'soon' }] }
    stub = stubAdapter({ 'convoy-plan': fence(bad) })
    vi.mocked(adapters.resolveAdapter).mockResolvedValue(resolved(stub.adapter))
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    await expect(planTask({ args: ['--yes'], pkgRoot }, 'add dark mode')).rejects.toThrow('exit 1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(runModule.runSpec).not.toHaveBeenCalled()
  })

  it.each([['--skip-validation'], ['--complexity'], ['--output-prd'], ['--output-spec'], ['--dryRun'], ['-t'], ['--text']])(
    'no longer accepts %s',
    async (flag) => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`)
      }) as typeof process.exit)
      await expect(planTask({ args: [flag, 'value'], pkgRoot }, 'x')).rejects.toThrow('exit 1')
      expect(stub.calls).toHaveLength(0)
    },
  )

  it('keeps --prd for convoy plan, and refuses it beside a task', async () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    await expect(planTask({ args: ['--prd', 'my.prd.md'], pkgRoot }, 'x')).rejects.toThrow('exit 1')
    expect(stub.calls).toHaveLength(0)
  })
})

describe('the plan says what planning spent', () => {
  const base = {
    plan: { name: 'Tags', tasks: [{ id: 'tags', agent: 'developer', files: ['src/notes.js'], prompt: 'x', depends_on: [] }] },
    settings: { branch: 'convoy/tags', adapter: 'claude', gates: ['npm test'] },
    specPath: join(tmpdir(), 'tags.convoy.yml'),
  } as unknown as Parameters<typeof renderPlan>[0]

  it('gives time, sessions, tokens and cost as the runtime reported them', () => {
    const rows = renderPlan({ ...base, planning: { sessions: 4, ms: 161_000, tokens: 812_000, costUsd: 0.84, costComplete: true } })
    expect(rows.join('\n')).toContain('in 2m 41s · 4 sessions · 812K tokens · $0.84')
  })

  it('marks the cost a lower bound when a session reported none', () => {
    const rows = renderPlan({ ...base, planning: { sessions: 2, ms: 9_000, tokens: 1_200, costUsd: 0.1, costComplete: false } })
    expect(rows.join('\n')).toContain('$0.10+ (not every session reported a cost)')
  })

  it('counts the sessions planConvoy ran', async () => {
    const { adapter, calls } = stubAdapter()
    const outcome = await plan(adapter)
    expect(outcome.planning?.sessions).toBe(5)
    expect(calls).toHaveLength(5)
  })
})
