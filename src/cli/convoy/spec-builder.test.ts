import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as yamlParse } from 'yaml'
import { parseYaml, validateSpec } from '../run/schema.js'
import {
  buildConvoyYaml,
  applyPatches,
  parseTaskPlan,
  parseTaskPlanWithReason,
  parsePatches,
  detectPackageManager,
  detectGates,
  planConcurrency,
  normalizePlanFiles,
  checkPlan,
  sequenceConflicts,
  mergeGroupPlans,
  slugify,
  MAX_PLANNED_CONCURRENCY,
} from './spec-builder.js'
import type { TaskPlan, TaskPlanTask, TaskPatch, SpecSettings } from './spec-builder.js'

// ── helpers ────────────────────────────────────────────────────────────────────

const SETTINGS: SpecSettings = { adapter: 'claude', branch: 'convoy/my-feature', gates: [] }

function minimalPlan(): TaskPlan {
  return {
    name: 'My Feature',
    tasks: [{ id: 'task-1', prompt: 'Do something useful' }],
  }
}

function fullTask(): TaskPlanTask {
  return {
    id: 'full-task',
    agent: 'ui-ux-expert',
    description: 'A fully-specified task',
    files: ['src/foo.ts', 'src/bar.ts'],
    depends_on: ['other-task'],
    timeout: '15m',
    max_retries: 3,
    review: 'panel',
    prompt: 'Implement the feature\n\nWith multiple paragraphs.',
  }
}

function build(plan: TaskPlan, settings: SpecSettings = SETTINGS): Record<string, any> {
  return yamlParse(buildConvoyYaml(plan, settings))
}

const tmpDirs: string[] = []
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-spec-builder-'))
  tmpDirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

// ── buildConvoyYaml ────────────────────────────────────────────────────────────

describe('buildConvoyYaml', () => {
  it('builds a spec the runner accepts from a minimal plan', () => {
    const yaml = buildConvoyYaml(minimalPlan(), SETTINGS)
    const result = validateSpec(parseYaml(yaml))
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('is safe by default: own branch, continue on failure, the runtime recorded', () => {
    const parsed = build(minimalPlan())
    expect(parsed.version).toBe(1)
    expect(parsed.branch).toBe('convoy/my-feature')
    expect(parsed.on_failure).toBe('continue')
    expect(parsed.adapter).toBe('claude')
  })

  it('switches on nothing that re-runs work per task', () => {
    const parsed = build({ ...minimalPlan(), tasks: [{ id: 't', complexity: 13, prompt: 'Epic' }] })
    expect(parsed.defaults.detect_drift).toBeUndefined()
    expect(parsed.defaults.built_in_gates).toBeUndefined()
    expect(parsed.guard).toBeUndefined()
    expect(parsed.tasks[0].gates).toBeUndefined()
    expect(parsed.tasks[0].built_in_gates).toBeUndefined()
  })

  it('runs the project checks once at the end, with one fix attempt', () => {
    const parsed = build(minimalPlan(), { ...SETTINGS, gates: ['pnpm run lint', 'pnpm run test'] })
    expect(parsed.gates).toEqual(['pnpm run lint', 'pnpm run test'])
    expect(parsed.gate_retries).toBe(1)
  })

  it('omits gates and gate_retries when the project has no checks', () => {
    const parsed = build(minimalPlan())
    expect(parsed.gates).toBeUndefined()
    expect(parsed.gate_retries).toBeUndefined()
  })

  it('sizes concurrency to the plan', () => {
    const wide: TaskPlan = { name: 'w', tasks: ['a', 'b', 'c'].map((id) => ({ id, prompt: id })) }
    expect(build(wide).concurrency).toBe(3)
    expect(build(minimalPlan()).concurrency).toBe(1)
  })

  it('keeps the default timeout, retries and review', () => {
    const parsed = build(minimalPlan())
    expect(parsed.defaults).toEqual({ timeout: '30m', max_retries: 1, review: 'fast' })
  })

  it('handles tasks with all optional fields set', () => {
    const plan: TaskPlan = { name: 'My Feature', tasks: [{ id: 'other-task', prompt: 'Other task' }, fullTask()] }
    const task = build(plan).tasks[1]
    expect(task.agent).toBe('ui-ux-expert')
    expect(task.description).toBe('A fully-specified task')
    expect(task.files).toEqual(['src/foo.ts', 'src/bar.ts'])
    expect(task.depends_on).toEqual(['other-task'])
    expect(task.timeout).toBe('15m')
    expect(task.max_retries).toBe(3)
    expect(task.review).toBe('panel')
    expect(task.prompt).toBe('Implement the feature\n\nWith multiple paragraphs.')
  })

  it('handles tasks with only required fields (id + prompt)', () => {
    const task = build(minimalPlan()).tasks[0]
    expect(task.id).toBe('task-1')
    expect(task.prompt).toBe('Do something useful')
    expect(task.agent).toBe('developer')
    expect(task.description).toBe('task-1')
    expect(task.files).toBeUndefined()
    expect(task.depends_on).toBeUndefined()
    expect(task.timeout).toBeUndefined()
    expect(task.max_retries).toBeUndefined()
  })

  it('starts with a comment saying how to run it', () => {
    const yaml = buildConvoyYaml(minimalPlan(), SETTINGS)
    expect(yaml.startsWith('# Written by `opencastle convoy`.')).toBe(true)
    expect(yaml).toContain('opencastle convoy run <this file>')
  })

  it('ensures prompt appears last in each task YAML block', () => {
    const plan: TaskPlan = { name: 'My Feature', tasks: [{ id: 'other-task', prompt: 'Other task' }, fullTask()] }
    const yaml = buildConvoyYaml(plan, SETTINGS)
    const promptIdx = yaml.lastIndexOf('  prompt:')
    expect(promptIdx).toBeGreaterThan(yaml.lastIndexOf('  agent:'))
    expect(promptIdx).toBeGreaterThan(yaml.lastIndexOf('  files:'))
    expect(promptIdx).toBeGreaterThan(yaml.lastIndexOf('  description:'))
  })

  // ── complexity effort-scaling integration ────────────────────────────────────

  it('auto-populates timeout, max_retries, review from effort table when complexity is set', () => {
    const task = build({ name: 'E', tasks: [{ id: 'task-1', complexity: 3, prompt: 'Do something' }] }).tasks[0]
    expect(task.timeout).toBe('15m')
    expect(task.max_retries).toBe(2)
    expect(task.review).toBe('fast')
  })

  it('does not override explicitly set fields when complexity is also set', () => {
    const tasks: TaskPlanTask[] = [
      { id: 't1', complexity: 3, timeout: '1h', prompt: 'x' },
      { id: 't2', complexity: 5, max_retries: 5, prompt: 'x' },
      { id: 't3', complexity: 8, review: 'panel', prompt: 'x' },
    ]
    const parsed = build({ name: 'E', tasks })
    expect(parsed.tasks[0].timeout).toBe('1h')
    expect(parsed.tasks[1].max_retries).toBe(5)
    expect(parsed.tasks[2].review).toBe('panel')
  })

  it('uses complexity-13 profile for epic tasks', () => {
    const task = build({ name: 'E', tasks: [{ id: 'task-1', complexity: 13, prompt: 'Epic task' }] }).tasks[0]
    expect(task.timeout).toBe('45m')
    expect(task.max_retries).toBe(3)
    expect(task.review).toBe('panel')
  })
})

// ── Project checks ─────────────────────────────────────────────────────────────

describe('detectPackageManager', () => {
  it('reads the packageManager field first', () => {
    const dir = project({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0' }), 'pnpm-lock.yaml': '' })
    expect(detectPackageManager(dir)).toBe('yarn')
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ])('falls back to the lockfile: %s → %s', (lockfile, pm) => {
    expect(detectPackageManager(project({ 'package.json': '{}', [lockfile]: '' }))).toBe(pm)
  })

  it('defaults to npm', () => {
    expect(detectPackageManager(project({}))).toBe('npm')
  })
})

describe('detectGates', () => {
  it('runs typecheck, lint, test and build with the project package manager, cheapest first', () => {
    const dir = project({
      'package.json': JSON.stringify({
        scripts: { build: 'tsc -b', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', dev: 'vite' },
      }),
      'pnpm-lock.yaml': '',
    })
    expect(detectGates(dir)).toEqual(['pnpm run typecheck', 'pnpm run lint', 'pnpm run test', 'pnpm run build'])
  })

  it('accepts type-check as the typecheck script', () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { 'type-check': 'tsc' } }) })
    expect(detectGates(dir)).toEqual(['npm run type-check'])
  })

  it('skips the npm init placeholder and watchers', () => {
    const dir = project({
      'package.json': JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint . --watch' },
      }),
    })
    expect(detectGates(dir)).toEqual([])
  })

  it('returns nothing without a package.json, or with an unreadable one', () => {
    expect(detectGates(project({}))).toEqual([])
    expect(detectGates(project({ 'package.json': '{ nope' }))).toEqual([])
  })
})

// ── planConcurrency ────────────────────────────────────────────────────────────

describe('planConcurrency', () => {
  it('is 1 for a straight chain', () => {
    const plan: TaskPlan = {
      name: 'c',
      tasks: [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b', depends_on: ['a'] },
        { id: 'c', prompt: 'c', depends_on: ['b'] },
      ],
    }
    expect(planConcurrency(plan)).toBe(1)
  })

  it('is the widest level of a diamond', () => {
    const plan: TaskPlan = {
      name: 'd',
      tasks: [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b', depends_on: ['a'] },
        { id: 'c', prompt: 'c', depends_on: ['a'] },
        { id: 'd', prompt: 'd', depends_on: ['b', 'c'] },
      ],
    }
    expect(planConcurrency(plan)).toBe(2)
  })

  it('is capped', () => {
    const plan: TaskPlan = { name: 'w', tasks: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, prompt: 'x' })) }
    expect(planConcurrency(plan)).toBe(MAX_PLANNED_CONCURRENCY)
  })
})

// ── Files ──────────────────────────────────────────────────────────────────────

describe('normalizePlanFiles', () => {
  it('cuts a glob back to the directory before its first wildcard', () => {
    const plan: TaskPlan = {
      name: 'g',
      tasks: [{ id: 't', prompt: 'x', files: ['src/**/*.ts', 'components/*.tsx', 'docs/guide?.md'] }],
    }
    const { plan: out, notes } = normalizePlanFiles(plan)
    expect(out.tasks[0].files).toEqual(['src/', 'components/', 'docs/'])
    expect(notes).toHaveLength(3)
  })

  it('drops a pattern at the project root instead of claiming everything', () => {
    const { plan, notes } = normalizePlanFiles({ name: 'g', tasks: [{ id: 't', prompt: 'x', files: ['*.md', 'README.md'] }] })
    expect(plan.tasks[0].files).toEqual(['README.md'])
    expect(notes[0]).toContain('dropped')
  })

  it('leaves real paths alone, including bracketed route segments, and removes duplicates', () => {
    const files = ['app/[slug]/page.tsx', 'src/a.ts', 'src/a.ts']
    const { plan, notes } = normalizePlanFiles({ name: 'g', tasks: [{ id: 't', prompt: 'x', files }] })
    expect(plan.tasks[0].files).toEqual(['app/[slug]/page.tsx', 'src/a.ts'])
    expect(notes).toEqual([])
  })
})

// ── checkPlan ──────────────────────────────────────────────────────────────────

describe('checkPlan', () => {
  it('passes a sound plan', () => {
    const plan: TaskPlan = {
      name: 'ok',
      tasks: [
        { id: 'a', prompt: 'a', files: ['src/a.ts'] },
        { id: 'b', prompt: 'b', files: ['src/b.ts'] },
        { id: 'c', prompt: 'c', files: ['src/a.ts'], depends_on: ['a'] },
      ],
    }
    expect(checkPlan(plan, SETTINGS)).toEqual([])
  })

  it('reports two tasks that can run together and claim the same file', () => {
    const plan: TaskPlan = {
      name: 'x',
      tasks: [
        { id: 'a', prompt: 'a', files: ['src/components/'] },
        { id: 'b', prompt: 'b', files: ['src/components/Hero.tsx'] },
      ],
    }
    const problems = checkPlan(plan, SETTINGS)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('"a" and "b"')
  })

  it('counts a conflict across phases when nothing orders the two tasks', () => {
    // The engine compares phase by phase: b (phase 1) and c (phase 0) passed.
    // A scheduler that starts work as soon as it is ready can run them together.
    const plan: TaskPlan = {
      name: 'x',
      tasks: [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b', depends_on: ['a'], files: ['src/shared.ts'] },
        { id: 'c', prompt: 'c', files: ['src/shared.ts'] },
      ],
    }
    expect(checkPlan(plan, SETTINGS)).toHaveLength(1)
  })

  it('accepts shared files when one task waits for the other through a third', () => {
    const plan: TaskPlan = {
      name: 'x',
      tasks: [
        { id: 'a', prompt: 'a', files: ['src/shared.ts'] },
        { id: 'b', prompt: 'b', depends_on: ['a'] },
        { id: 'c', prompt: 'c', depends_on: ['b'], files: ['src/shared.ts'] },
      ],
    }
    expect(checkPlan(plan, SETTINGS)).toEqual([])
  })

  it('compares paths without regard to case', () => {
    const plan: TaskPlan = {
      name: 'x',
      tasks: [
        { id: 'a', prompt: 'a', files: ['README.md'] },
        { id: 'b', prompt: 'b', files: ['readme.md'] },
      ],
    }
    expect(checkPlan(plan, SETTINGS)).toHaveLength(1)
  })

  it('reports globs, absolute paths and paths that leave the project', () => {
    const plan: TaskPlan = {
      name: 'x',
      tasks: [{ id: 'a', prompt: 'a', files: ['src/*.ts', '/etc/hosts', 'C:\\x', '../outside.ts'] }],
    }
    const problems = checkPlan(plan, SETTINGS).join('\n')
    expect(problems).toContain('"src/*.ts" is a pattern')
    expect(problems).toContain('"/etc/hosts" must be relative')
    expect(problems).toContain('"C:\\x" must be relative')
    expect(problems).toContain('..')
  })

  it('reports what the runner would reject, such as a bad timeout', () => {
    const problems = checkPlan({ name: 'x', tasks: [{ id: 'a', prompt: 'a', timeout: 'soon' }] }, SETTINGS)
    expect(problems.join('\n')).toContain('Schema:')
  })

  it('reports unknown dependencies and cycles', () => {
    expect(checkPlan({ name: 'x', tasks: [{ id: 'a', prompt: 'a', depends_on: ['ghost'] }] }, SETTINGS)[0]).toContain('ghost')
    const cycle: TaskPlan = {
      name: 'x',
      tasks: [
        { id: 'a', prompt: 'a', depends_on: ['b'] },
        { id: 'b', prompt: 'b', depends_on: ['a'] },
      ],
    }
    expect(checkPlan(cycle, SETTINGS)[0]).toContain('cycle')
  })
})

describe('sequenceConflicts', () => {
  it('makes the later task wait for the earlier, leaving a plan that passes', () => {
    const plan: TaskPlan = {
      name: 'x',
      tasks: [
        { id: 'a', prompt: 'a', files: ['src/components/'] },
        { id: 'b', prompt: 'b', files: ['src/components/Hero.tsx'] },
        { id: 'c', prompt: 'c', files: ['src/components/Card.tsx'] },
        { id: 'd', prompt: 'd', files: ['src/other.ts'] },
      ],
    }
    const { plan: out, added } = sequenceConflicts(plan)
    expect(checkPlan(out, SETTINGS)).toEqual([])
    expect(added.length).toBeGreaterThan(0)
    expect(out.tasks.find((t) => t.id === 'd')!.depends_on ?? []).toEqual([])
    expect(parseTaskPlan(JSON.stringify(out))).not.toBeNull() // still acyclic
    expect(plan.tasks[1].depends_on).toBeUndefined() // input untouched
  })

  it('changes nothing when there is no conflict', () => {
    expect(sequenceConflicts(minimalPlan()).added).toEqual([])
  })
})

// ── mergeGroupPlans ────────────────────────────────────────────────────────────

describe('mergeGroupPlans', () => {
  const group = (name: string, prefix: string): TaskPlan => ({
    name,
    tasks: [
      { id: 'setup', prompt: `set up ${name}`, files: [`${prefix}/setup.ts`] },
      { id: `work-${name}`, prompt: `work ${name}`, files: [`${prefix}/work.ts`], depends_on: ['setup'] },
    ],
  })

  const merged = mergeGroupPlans('Feature', [
    { name: 'theme', depends_on: [], plan: group('theme', 'src/theme') },
    { name: 'docs', depends_on: [], plan: group('docs', 'docs') },
    { name: 'ui', depends_on: ['theme', 'docs'], plan: group('ui', 'src/ui') },
  ])
  const byId = new Map(merged.tasks.map((t) => [t.id, t]))

  it('renames a clashing id within its own group', () => {
    expect([...byId.keys()]).toEqual(['setup', 'work-theme', 'docs-setup', 'work-docs', 'ui-setup', 'work-ui'])
    expect(byId.get('work-docs')!.depends_on).toEqual(['docs-setup'])
  })

  it('makes a group start after the last tasks of the groups it depends on', () => {
    expect(byId.get('ui-setup')!.depends_on).toEqual(['work-theme', 'work-docs'])
    expect(byId.get('work-ui')!.depends_on).toEqual(['ui-setup'])
  })

  it('adds nothing between independent groups, so they run side by side', () => {
    expect(byId.get('setup')!.depends_on).toEqual([])
    expect(byId.get('docs-setup')!.depends_on).toEqual([])
    expect(planConcurrency(merged)).toBe(2)
  })

  it('is one plan that passes the checks and writes plain YAML', () => {
    expect(merged.name).toBe('Feature')
    expect(checkPlan(merged, SETTINGS)).toEqual([])
    expect(buildConvoyYaml(merged, SETTINGS)).not.toMatch(/[&*]a\d/)
  })
})

describe('slugify', () => {
  it('kebab-cases a name', () => {
    expect(slugify('My Big Feature 2!')).toBe('my-big-feature-2')
  })
})

// ── applyPatches ──────────────────────────────────────────────────────────────

describe('applyPatches', () => {
  it('patches a task-level field (prompt)', () => {
    const patched = applyPatches(minimalPlan(), [{ task_id: 'task-1', field: 'prompt', value: 'Updated prompt' }])
    expect(patched.tasks[0].prompt).toBe('Updated prompt')
  })

  it('patches task depends_on', () => {
    const plan: TaskPlan = { name: 'Test', tasks: [{ id: 'task-1', prompt: 'First' }, { id: 'task-2', prompt: 'Second' }] }
    const patched = applyPatches(plan, [{ task_id: 'task-2', field: 'depends_on', value: ['task-1'] }])
    expect(patched.tasks[1].depends_on).toEqual(['task-1'])
  })

  it('renames the plan through _plan', () => {
    const patched = applyPatches(minimalPlan(), [{ task_id: '_plan', field: 'name', value: 'Renamed' }])
    expect(patched.name).toBe('Renamed')
  })

  it('returns a new object (original plan unchanged)', () => {
    const plan = minimalPlan()
    const patched = applyPatches(plan, [{ task_id: 'task-1', field: 'prompt', value: 'New prompt' }])
    expect(patched).not.toBe(plan)
    expect(plan.tasks[0].prompt).toBe('Do something useful')
  })

  it('applies multiple patches in order', () => {
    const plan: TaskPlan = { name: 'Test', tasks: [{ id: 'task-1', prompt: 'First' }, { id: 'task-2', prompt: 'Second' }] }
    const patches: TaskPatch[] = [
      { task_id: 'task-1', field: 'prompt', value: 'Patched first' },
      { task_id: 'task-2', field: 'agent', value: 'ui-ux-expert' },
      { task_id: 'task-2', field: 'agent', value: 'writer' },
    ]
    const patched = applyPatches(plan, patches)
    expect(patched.tasks[0].prompt).toBe('Patched first')
    expect(patched.tasks[1].agent).toBe('writer')
  })

  it('warns about, and skips, a patch for an unknown task', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plan: TaskPlan = { name: 'test', tasks: [{ id: 'task-1', prompt: 'original' }] }
    const result = applyPatches(plan, [
      { task_id: 'task-1', field: 'prompt', value: 'updated' },
      { task_id: 'ghost', field: 'prompt', value: 'nope' },
    ])
    expect(result.tasks[0].prompt).toBe('updated')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'))
    warnSpy.mockRestore()
  })

  it('does not warn when all patches target valid tasks', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyPatches(minimalPlan(), [{ task_id: 'task-1', field: 'prompt', value: 'updated' }])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ── parseTaskPlan ──────────────────────────────────────────────────────────────

describe('parseTaskPlan', () => {
  it('parses a valid plan successfully', () => {
    const result = parseTaskPlan(JSON.stringify({ name: 'My Plan', tasks: [{ id: 'task-1', prompt: 'Do the thing' }] }))
    expect(result!.name).toBe('My Plan')
    expect(result!.tasks).toHaveLength(1)
  })

  it('ignores run settings a planner adds, which the code decides', () => {
    const json = JSON.stringify({ name: 'P', branch: 'main', on_failure: 'stop', tasks: [{ id: 't1', prompt: 'p' }] })
    const plan = parseTaskPlan(json)!
    const parsed = build(plan)
    expect(parsed.branch).toBe(SETTINGS.branch)
    expect(parsed.on_failure).toBe('continue')
  })

  it.each([
    ['empty string', ''],
    ['invalid JSON', '{not valid json'],
    ['missing name', JSON.stringify({ tasks: [{ id: 't1', prompt: 'p' }] })],
    ['non-string name', JSON.stringify({ name: 42, tasks: [{ id: 't1', prompt: 'p' }] })],
    ['empty tasks', JSON.stringify({ name: 'Test', tasks: [] })],
    ['missing tasks', JSON.stringify({ name: 'Test' })],
    ['task missing id', JSON.stringify({ name: 'Test', tasks: [{ prompt: 'p' }] })],
    ['task missing prompt', JSON.stringify({ name: 'Test', tasks: [{ id: 't1' }] })],
    ['non-string id', JSON.stringify({ name: 'Test', tasks: [{ id: 1, prompt: 'p' }] })],
    ['surrounding text', `Here is the plan:\n${JSON.stringify({ name: 'T', tasks: [{ id: 't', prompt: 'p' }] })}\nHope this helps!`],
  ])('returns null for %s', (_label, text) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTaskPlan(text)).toBeNull()
    warnSpy.mockRestore()
  })

  it('names duplicate ids, unknown dependencies and cycles in the reason', () => {
    const dup = parseTaskPlanWithReason(JSON.stringify({ name: 't', tasks: [{ id: 'setup', prompt: 'a' }, { id: 'setup', prompt: 'b' }] }))
    expect(dup.reason).toContain('setup')
    const unknown = parseTaskPlanWithReason(JSON.stringify({ name: 't', tasks: [{ id: 'b', prompt: 'b', depends_on: ['nonexistent'] }] }))
    expect(unknown.reason).toContain('nonexistent')
    const cycle = parseTaskPlanWithReason(
      JSON.stringify({ name: 't', tasks: [{ id: 'a', prompt: 'a', depends_on: ['b'] }, { id: 'b', prompt: 'b', depends_on: ['a'] }] }),
    )
    expect(cycle.reason).toContain('cycle')
  })

  it('reports a truncated answer as truncated', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTaskPlanWithReason('{ "name": "x", "tasks": [').reason).toContain('truncated')
    warnSpy.mockRestore()
  })

  it('accepts valid plan with correct dependencies', () => {
    const plan = JSON.stringify({
      name: 'test',
      tasks: [
        { id: 'a', prompt: 'Do A' },
        { id: 'b', prompt: 'Do B', depends_on: ['a'] },
        { id: 'c', prompt: 'Do C', depends_on: ['a', 'b'] },
      ],
    })
    expect(parseTaskPlan(plan)!.tasks).toHaveLength(3)
  })
})

// ── parsePatches ──────────────────────────────────────────────────────────────

describe('parsePatches', () => {
  it('parses a valid patches array successfully', () => {
    const json = JSON.stringify([
      { task_id: 'task-1', field: 'prompt', value: 'New prompt' },
      { task_id: '_plan', field: 'name', value: 'Renamed' },
    ])
    const result = parsePatches(json)
    expect(result!).toHaveLength(2)
    expect(result![0].task_id).toBe('task-1')
    expect(result![1].value).toBe('Renamed')
  })

  it('parses empty array', () => {
    expect(parsePatches('[]')).toEqual([])
  })

  it.each([
    ['non-array JSON', JSON.stringify({ task_id: 't1', field: 'f', value: 'v' })],
    ['invalid JSON', '{bad'],
    ['empty string', ''],
    ['missing task_id', JSON.stringify([{ field: 'prompt', value: 'x' }])],
    ['missing field', JSON.stringify([{ task_id: 'task-1', value: 'x' }])],
    ['missing value', JSON.stringify([{ task_id: 'task-1', field: 'prompt' }])],
    ['one bad patch among good', JSON.stringify([{ task_id: 'a', field: 'prompt', value: 'ok' }, { task_id: 'b', field: 'prompt' }])],
  ])('returns null for %s', (_label, text) => {
    expect(parsePatches(text)).toBeNull()
  })
})
