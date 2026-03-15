import { describe, it, expect, vi } from 'vitest'
import { parse as yamlParse } from 'yaml'
import { parseYaml, validateSpec } from '../run/schema.js'
import {
  buildConvoyYaml,
  applyPatches,
  parseTaskPlan,
  parsePatches,
  deriveSpecEnrichment,
} from './spec-builder.js'
import type { TaskPlan, TaskPlanTask, TaskPatch, SpecEnrichment } from './spec-builder.js'

// ── helpers ────────────────────────────────────────────────────────────────────

function minimalPlan(): TaskPlan {
  return {
    name: 'My Feature',
    tasks: [{ id: 'task-1', prompt: 'Do something useful' }],
  }
}

function fullTask(): TaskPlanTask {
  return {
    id: 'full-task',
    agent: 'ui-expert',
    description: 'A fully-specified task',
    files: ['src/foo.ts', 'src/bar.ts'],
    depends_on: ['other-task'],
    timeout: '15m',
    max_retries: 3,
    review: 'panel',
    gates: ['custom-gate'],
    built_in_gates: { secret_scan: true },
    prompt: 'Implement the feature\n\nWith multiple paragraphs.',
  }
}

// ── buildConvoyYaml ────────────────────────────────────────────────────────────

describe('buildConvoyYaml', () => {
  it('builds valid YAML from a minimal plan', () => {
    const yaml = buildConvoyYaml(minimalPlan())
    expect(typeof yaml).toBe('string')
    expect(yaml.length).toBeGreaterThan(0)
    const parsed = yamlParse(yaml)
    expect(parsed.name).toBe('My Feature')
    expect(Array.isArray(parsed.tasks)).toBe(true)
  })

  it('sets correct defaults when not specified', () => {
    const yaml = buildConvoyYaml(minimalPlan())
    const parsed = yamlParse(yaml)
    expect(parsed.concurrency).toBe(2)
    expect(parsed.on_failure).toBe('stop')
    expect(parsed.version).toBe(1)
    expect(parsed.defaults.timeout).toBe('30m')
    expect(parsed.defaults.max_retries).toBe(1)
    expect(parsed.defaults.review).toBe('fast')
    expect(parsed.defaults.inject_lessons).toBe(true)
    expect(parsed.defaults.track_discovered_issues).toBe(true)
    expect(parsed.defaults.avoid_weak_agents).toBe(true)
  })

  it('uses plan concurrency and on_failure when provided', () => {
    const plan: TaskPlan = { ...minimalPlan(), concurrency: 4, on_failure: 'continue' }
    const parsed = yamlParse(buildConvoyYaml(plan))
    expect(parsed.concurrency).toBe(4)
    expect(parsed.on_failure).toBe('continue')
  })

  it('includes branch when defined', () => {
    const plan: TaskPlan = { ...minimalPlan(), branch: 'feat/my-branch' }
    const parsed = yamlParse(buildConvoyYaml(plan))
    expect(parsed.branch).toBe('feat/my-branch')
  })

  it('omits branch when undefined', () => {
    const parsed = yamlParse(buildConvoyYaml(minimalPlan()))
    expect(parsed.branch).toBeUndefined()
  })

  it('includes gates and gate_retries when defined', () => {
    const plan: TaskPlan = { ...minimalPlan(), gates: ['lint', 'tests'], gate_retries: 2 }
    const parsed = yamlParse(buildConvoyYaml(plan))
    expect(parsed.gates).toEqual(['lint', 'tests'])
    expect(parsed.gate_retries).toBe(2)
  })

  it('omits gates and gate_retries when undefined', () => {
    const parsed = yamlParse(buildConvoyYaml(minimalPlan()))
    expect(parsed.gates).toBeUndefined()
    expect(parsed.gate_retries).toBeUndefined()
  })

  it('handles tasks with all optional fields set', () => {
    const plan: TaskPlan = {
      name: 'My Feature',
      tasks: [
        { id: 'other-task', prompt: 'Other task' },
        fullTask(),
      ],
    }
    const parsed = yamlParse(buildConvoyYaml(plan))
    const task = parsed.tasks[1]
    expect(task.agent).toBe('ui-expert')
    expect(task.description).toBe('A fully-specified task')
    expect(task.files).toEqual(['src/foo.ts', 'src/bar.ts'])
    expect(task.depends_on).toEqual(['other-task'])
    expect(task.timeout).toBe('15m')
    expect(task.max_retries).toBe(3)
    expect(task.review).toBe('panel')
    expect(task.gates).toEqual(['custom-gate'])
    expect(task.built_in_gates).toEqual({ secret_scan: true })
    expect(task.prompt).toBe('Implement the feature\n\nWith multiple paragraphs.')
  })

  it('handles tasks with only required fields (id + prompt)', () => {
    const parsed = yamlParse(buildConvoyYaml(minimalPlan()))
    const task = parsed.tasks[0]
    expect(task.id).toBe('task-1')
    expect(task.prompt).toBe('Do something useful')
    expect(task.agent).toBe('developer')
    expect(task.description).toBe('task-1')
    expect(task.files).toBeUndefined()
    expect(task.depends_on).toBeUndefined()
    expect(task.timeout).toBeUndefined()
    expect(task.max_retries).toBeUndefined()
  })

  it('prepends the comment header with kebab-case file path', () => {
    const yaml = buildConvoyYaml(minimalPlan())
    expect(yaml.startsWith('# .opencastle/convoys/my-feature.convoy.yml\n')).toBe(true)
  })

  it('comment header converts spaces and special chars to kebab-case', () => {
    const plan: TaskPlan = { ...minimalPlan(), name: 'My Big Feature 2' }
    const yaml = buildConvoyYaml(plan)
    expect(yaml.startsWith('# .opencastle/convoys/my-big-feature-2.convoy.yml\n')).toBe(true)
  })

  it('ensures prompt appears last in each task YAML block', () => {
    const plan: TaskPlan = {
      name: 'My Feature',
      tasks: [
        { id: 'other-task', prompt: 'Other task' },
        fullTask(),
      ],
    }
    const yaml = buildConvoyYaml(plan)
    // find last occurrence of prompt: which belongs to the full-task
    const agentIdx = yaml.lastIndexOf('  agent:')
    const filesIdx = yaml.lastIndexOf('  files:')
    const descIdx = yaml.lastIndexOf('  description:')
    const promptIdx = yaml.lastIndexOf('  prompt:')
    expect(promptIdx).toBeGreaterThan(agentIdx)
    expect(promptIdx).toBeGreaterThan(filesIdx)
    expect(promptIdx).toBeGreaterThan(descIdx)
  })

  it('output can be parsed back and produces a valid spec (round-trip)', () => {
    const plan: TaskPlan = {
      name: 'Round Trip Test',
      concurrency: 3,
      on_failure: 'continue',
      branch: 'feat/round-trip',
      gates: ['custom'],
      gate_retries: 1,
      tasks: [
        { id: 'task-a', prompt: 'First task' },
        { id: 'task-b', depends_on: ['task-a'], prompt: 'Second task', agent: 'ui-expert' },
      ],
    }
    const yaml = buildConvoyYaml(plan)
    const spec = parseYaml(yaml)
    const result = validateSpec(spec)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('round-trip with minimal plan passes validateSpec', () => {
    const yaml = buildConvoyYaml(minimalPlan())
    const result = validateSpec(parseYaml(yaml))
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('merges enrichment into defaults and spec', () => {
    const enrichment: SpecEnrichment = {
      guard: { enabled: true },
      circuit_breaker: { threshold: 2, cooldown_ms: 300_000 },
      detect_drift: true,
      built_in_gates: { secret_scan: true, blast_radius: true, browser_test: 'auto' },
      max_concurrent_reviews: 3,
    }
    const yaml = buildConvoyYaml(minimalPlan(), enrichment)
    const parsed = yamlParse(yaml)
    expect(parsed.guard).toEqual({ enabled: true })
    expect(parsed.defaults.circuit_breaker).toEqual({ threshold: 2, cooldown_ms: 300000 })
    expect(parsed.defaults.detect_drift).toBe(true)
    expect(parsed.defaults.built_in_gates.secret_scan).toBe(true)
    expect(parsed.defaults.built_in_gates.browser_test).toBe('auto')
    expect(parsed.defaults.max_concurrent_reviews).toBe(3)
  })

  it('omits enrichment fields when enrichment is not provided', () => {
    const yaml = buildConvoyYaml(minimalPlan())
    const parsed = yamlParse(yaml)
    expect(parsed.guard).toBeUndefined()
    expect(parsed.defaults.circuit_breaker).toBeUndefined()
    expect(parsed.defaults.detect_drift).toBeUndefined()
    expect(parsed.defaults.built_in_gates).toBeUndefined()
    expect(parsed.defaults.max_concurrent_reviews).toBeUndefined()
  })

  it('enriched plan still passes round-trip validation', () => {
    const enrichment = deriveSpecEnrichment({ complexity: 'high', total_tasks: 10, domains: ['frontend', 'api'] })
    const plan: TaskPlan = {
      name: 'Enriched Round Trip',
      branch: 'feat/enriched',
      tasks: [
        { id: 'task-a', prompt: 'First task' },
        { id: 'task-b', depends_on: ['task-a'], prompt: 'Second task' },
      ],
    }
    const yaml = buildConvoyYaml(plan, enrichment)
    const spec = parseYaml(yaml)
    const result = validateSpec(spec)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  // ── complexity effort-scaling integration ────────────────────────────────────

  it('auto-populates timeout, max_retries, review from effort table when complexity is set', () => {
    const plan: TaskPlan = {
      name: 'Effort Test',
      tasks: [{ id: 'task-1', complexity: 3, prompt: 'Do something' }],
    }
    const parsed = yamlParse(buildConvoyYaml(plan))
    const task = parsed.tasks[0]
    expect(task.timeout).toBe('15m')
    expect(task.max_retries).toBe(2)
    expect(task.review).toBe('fast')
  })

  it('does not override explicitly set timeout when complexity is also set', () => {
    const plan: TaskPlan = {
      name: 'Effort Override Test',
      tasks: [{ id: 'task-1', complexity: 3, timeout: '1h', prompt: 'Do something' }],
    }
    const parsed = yamlParse(buildConvoyYaml(plan))
    expect(parsed.tasks[0].timeout).toBe('1h')
  })

  it('does not override explicitly set max_retries when complexity is also set', () => {
    const plan: TaskPlan = {
      name: 'Effort Override Test',
      tasks: [{ id: 'task-1', complexity: 5, max_retries: 5, prompt: 'Do something' }],
    }
    const parsed = yamlParse(buildConvoyYaml(plan))
    expect(parsed.tasks[0].max_retries).toBe(5)
  })

  it('does not override explicitly set review when complexity is also set', () => {
    const plan: TaskPlan = {
      name: 'Effort Override Test',
      tasks: [{ id: 'task-1', complexity: 8, review: 'panel', prompt: 'Do something' }],
    }
    const parsed = yamlParse(buildConvoyYaml(plan))
    expect(parsed.tasks[0].review).toBe('panel')
  })

  it('works unchanged (backward compatible) when complexity is not set', () => {
    const parsed = yamlParse(buildConvoyYaml(minimalPlan()))
    const task = parsed.tasks[0]
    expect(task.timeout).toBeUndefined()
    expect(task.max_retries).toBeUndefined()
    expect(task.review).toBeUndefined()
  })

  it('uses complexity-13 profile for epic tasks', () => {
    const plan: TaskPlan = {
      name: 'Epic Test',
      tasks: [{ id: 'task-1', complexity: 13, prompt: 'Epic task' }],
    }
    const parsed = yamlParse(buildConvoyYaml(plan))
    const task = parsed.tasks[0]
    expect(task.timeout).toBe('45m')
    expect(task.max_retries).toBe(3)
    expect(task.review).toBe('panel')
  })
})

// ── applyPatches ──────────────────────────────────────────────────────────────

describe('applyPatches', () => {
  it('patches a task-level field (prompt)', () => {
    const plan = minimalPlan()
    const patched = applyPatches(plan, [
      { task_id: 'task-1', field: 'prompt', value: 'Updated prompt' },
    ])
    expect(patched.tasks[0].prompt).toBe('Updated prompt')
  })

  it('patches task depends_on', () => {
    const plan: TaskPlan = {
      name: 'Test',
      tasks: [
        { id: 'task-1', prompt: 'First' },
        { id: 'task-2', prompt: 'Second' },
      ],
    }
    const patched = applyPatches(plan, [
      { task_id: 'task-2', field: 'depends_on', value: ['task-1'] },
    ])
    expect(patched.tasks[1].depends_on).toEqual(['task-1'])
  })

  it('patches a top-level field using _plan task_id', () => {
    const plan = minimalPlan()
    const patched = applyPatches(plan, [
      { task_id: '_plan', field: 'concurrency', value: 5 },
    ])
    expect(patched.concurrency).toBe(5)
  })

  it('patches a top-level string field (_plan)', () => {
    const plan = minimalPlan()
    const patched = applyPatches(plan, [
      { task_id: '_plan', field: 'branch', value: 'feat/patched-branch' },
    ])
    expect(patched.branch).toBe('feat/patched-branch')
  })

  it('leaves task unchanged when task id does not exist', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plan = minimalPlan()
    const patched = applyPatches(plan, [
      { task_id: 'nonexistent', field: 'prompt', value: 'x' },
    ])
    expect(patched.tasks[0].prompt).toBe('Do something useful')
    warnSpy.mockRestore()
  })

  it('returns a new object (original plan unchanged)', () => {
    const plan = minimalPlan()
    const patched = applyPatches(plan, [
      { task_id: 'task-1', field: 'prompt', value: 'New prompt' },
    ])
    expect(patched).not.toBe(plan)
    expect(plan.tasks[0].prompt).toBe('Do something useful')
  })

  it('applies multiple patches in order', () => {
    const plan: TaskPlan = {
      name: 'Test',
      tasks: [
        { id: 'task-1', prompt: 'First' },
        { id: 'task-2', prompt: 'Second' },
      ],
    }
    const patches: TaskPatch[] = [
      { task_id: 'task-1', field: 'prompt', value: 'Patched first' },
      { task_id: 'task-2', field: 'agent', value: 'ui-expert' },
      { task_id: '_plan', field: 'on_failure', value: 'continue' },
    ]
    const patched = applyPatches(plan, patches)
    expect(patched.tasks[0].prompt).toBe('Patched first')
    expect(patched.tasks[1].agent).toBe('ui-expert')
    expect(patched.on_failure).toBe('continue')
  })

  it('warns when patch targets unknown task_id', () => {
    const plan: TaskPlan = {
      name: 'test',
      tasks: [{ id: 'task-1', prompt: 'do something' }],
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = applyPatches(plan, [
      { task_id: 'nonexistent', field: 'prompt', value: 'new prompt' },
    ])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent')
    )
    // Original task unchanged
    expect(result.tasks[0].prompt).toBe('do something')
    warnSpy.mockRestore()
  })

  it('applies valid patches and warns for invalid ones', () => {
    const plan: TaskPlan = {
      name: 'test',
      tasks: [
        { id: 'task-1', prompt: 'original' },
        { id: 'task-2', prompt: 'original2' },
      ],
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = applyPatches(plan, [
      { task_id: 'task-1', field: 'prompt', value: 'updated' },
      { task_id: 'ghost', field: 'prompt', value: 'nope' },
    ])
    expect(result.tasks[0].prompt).toBe('updated')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'))
    warnSpy.mockRestore()
  })

  it('does not warn when all patches target valid tasks', () => {
    const plan: TaskPlan = {
      name: 'test',
      tasks: [{ id: 'task-1', prompt: 'original' }],
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyPatches(plan, [
      { task_id: 'task-1', field: 'prompt', value: 'updated' },
    ])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ── parseTaskPlan ──────────────────────────────────────────────────────────────

describe('parseTaskPlan', () => {
  it('parses a valid plan successfully', () => {
    const json = JSON.stringify({
      name: 'My Plan',
      tasks: [{ id: 'task-1', prompt: 'Do the thing' }],
    })
    const result = parseTaskPlan(json)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('My Plan')
    expect(result!.tasks).toHaveLength(1)
  })

  it('parses a plan with all optional fields', () => {
    const json = JSON.stringify({
      name: 'Full Plan',
      branch: 'feat/full',
      concurrency: 3,
      on_failure: 'continue',
      gates: ['lint'],
      gate_retries: 2,
      tasks: [{ id: 't1', prompt: 'prompt', agent: 'developer', files: ['a.ts'] }],
    })
    const result = parseTaskPlan(json)
    expect(result).not.toBeNull()
    expect(result!.branch).toBe('feat/full')
    expect(result!.concurrency).toBe(3)
  })

  it('returns null for empty string', () => {
    expect(parseTaskPlan('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseTaskPlan('{not valid json')).toBeNull()
  })

  it('returns null when name is missing', () => {
    const json = JSON.stringify({ tasks: [{ id: 't1', prompt: 'p' }] })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null when name is not a string', () => {
    const json = JSON.stringify({ name: 42, tasks: [{ id: 't1', prompt: 'p' }] })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null for empty tasks array', () => {
    const json = JSON.stringify({ name: 'Test', tasks: [] })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null when tasks is missing', () => {
    const json = JSON.stringify({ name: 'Test' })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null for task missing id', () => {
    const json = JSON.stringify({ name: 'Test', tasks: [{ prompt: 'p' }] })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null for task missing prompt', () => {
    const json = JSON.stringify({ name: 'Test', tasks: [{ id: 't1' }] })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null for task with non-string id', () => {
    const json = JSON.stringify({ name: 'Test', tasks: [{ id: 1, prompt: 'p' }] })
    expect(parseTaskPlan(json)).toBeNull()
  })

  it('returns null when JSON is surrounded by text', () => {
    const json = JSON.stringify({ name: 'Test', tasks: [{ id: 't1', prompt: 'p' }] })
    const wrapped = `Here is the plan:\n${json}\nHope this helps!`
    expect(parseTaskPlan(wrapped)).toBeNull()
  })

  it('returns null when trailing garbage present', () => {
    const json = JSON.stringify({ name: 'Test', tasks: [{ id: 't1', prompt: 'p' }] })
    const withTrailing = json + '\n```\nSome extra text'
    expect(parseTaskPlan(withTrailing)).toBeNull()
  })

  it('returns null for duplicate task IDs', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plan = JSON.stringify({
      name: 'test',
      tasks: [
        { id: 'setup', prompt: 'Do setup' },
        { id: 'setup', prompt: 'Do setup again' },
      ],
    })
    expect(parseTaskPlan(plan)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('setup'))
    warnSpy.mockRestore()
  })

  it('returns null for invalid depends_on reference', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plan = JSON.stringify({
      name: 'test',
      tasks: [
        { id: 'a', prompt: 'Do A' },
        { id: 'b', prompt: 'Do B', depends_on: ['nonexistent'] },
      ],
    })
    expect(parseTaskPlan(plan)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
    warnSpy.mockRestore()
  })

  it('returns null for dependency cycle', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plan = JSON.stringify({
      name: 'test',
      tasks: [
        { id: 'a', prompt: 'Do A', depends_on: ['b'] },
        { id: 'b', prompt: 'Do B', depends_on: ['a'] },
      ],
    })
    expect(parseTaskPlan(plan)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cycle'))
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
    const result = parseTaskPlan(plan)
    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(3)
  })
})

// ── parsePatches ──────────────────────────────────────────────────────────────

describe('parsePatches', () => {
  it('parses a valid patches array successfully', () => {
    const json = JSON.stringify([
      { task_id: 'task-1', field: 'prompt', value: 'New prompt' },
      { task_id: '_plan', field: 'concurrency', value: 3 },
    ])
    const result = parsePatches(json)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
    expect(result![0].task_id).toBe('task-1')
    expect(result![1].value).toBe(3)
  })

  it('parses empty array', () => {
    const result = parsePatches('[]')
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(0)
  })

  it('returns null for non-array JSON', () => {
    expect(parsePatches(JSON.stringify({ task_id: 't1', field: 'f', value: 'v' }))).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parsePatches('{bad')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parsePatches('')).toBeNull()
  })

  it('returns null for patch missing task_id', () => {
    const json = JSON.stringify([{ field: 'prompt', value: 'x' }])
    expect(parsePatches(json)).toBeNull()
  })

  it('returns null for patch missing field', () => {
    const json = JSON.stringify([{ task_id: 'task-1', value: 'x' }])
    expect(parsePatches(json)).toBeNull()
  })

  it('returns null for patch missing value', () => {
    const json = JSON.stringify([{ task_id: 'task-1', field: 'prompt' }])
    expect(parsePatches(json)).toBeNull()
  })

  it('returns null when any patch in the array is invalid', () => {
    const json = JSON.stringify([
      { task_id: 'task-1', field: 'prompt', value: 'ok' },
      { task_id: 'task-2', field: 'prompt' }, // missing value
    ])
    expect(parsePatches(json)).toBeNull()
  })
})

// ── deriveSpecEnrichment ───────────────────────────────────────────────────────

describe('deriveSpecEnrichment', () => {
  it('returns no circuit_breaker for low complexity', () => {
    const result = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['frontend'] })
    expect(result.circuit_breaker).toBeUndefined()
  })

  it('returns circuit_breaker threshold=3 for medium complexity', () => {
    const result = deriveSpecEnrichment({ complexity: 'medium', total_tasks: 6, domains: ['frontend'] })
    expect(result.circuit_breaker).toEqual({ threshold: 3, cooldown_ms: 300_000 })
  })

  it('returns circuit_breaker threshold=2 for high complexity', () => {
    const result = deriveSpecEnrichment({ complexity: 'high', total_tasks: 12, domains: ['frontend'] })
    expect(result.circuit_breaker).toEqual({ threshold: 2, cooldown_ms: 300_000 })
  })

  it('enables detect_drift for medium/high, not low', () => {
    expect(deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: [] }).detect_drift).toBeUndefined()
    expect(deriveSpecEnrichment({ complexity: 'medium', total_tasks: 6, domains: [] }).detect_drift).toBe(true)
    expect(deriveSpecEnrichment({ complexity: 'high', total_tasks: 12, domains: [] }).detect_drift).toBe(true)
  })

  it('enables guard for medium/high, not low', () => {
    expect(deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: [] }).guard).toBeUndefined()
    expect(deriveSpecEnrichment({ complexity: 'medium', total_tasks: 6, domains: [] }).guard).toEqual({ enabled: true })
    expect(deriveSpecEnrichment({ complexity: 'high', total_tasks: 12, domains: [] }).guard).toEqual({ enabled: true })
  })

  it('always includes secret_scan and blast_radius gates', () => {
    const result = deriveSpecEnrichment({ complexity: 'low', total_tasks: 2, domains: [] })
    expect(result.built_in_gates?.secret_scan).toBe(true)
    expect(result.built_in_gates?.blast_radius).toBe(true)
  })

  it('adds browser_test gate for frontend/ui domains', () => {
    const frontend = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['frontend'] })
    expect(frontend.built_in_gates?.browser_test).toBe('auto')
    const ui = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['UI'] })
    expect(ui.built_in_gates?.browser_test).toBe('auto')
    const backend = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['backend'] })
    expect(backend.built_in_gates?.browser_test).toBeUndefined()
  })

  it('adds regression_test gate for testing domain or >5 tasks', () => {
    const testing = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['testing'] })
    expect(testing.built_in_gates?.regression_test).toBe('auto')
    const manyTasks = deriveSpecEnrichment({ complexity: 'medium', total_tasks: 7, domains: [] })
    expect(manyTasks.built_in_gates?.regression_test).toBe('auto')
    const fewTasks = deriveSpecEnrichment({ complexity: 'low', total_tasks: 4, domains: [] })
    expect(fewTasks.built_in_gates?.regression_test).toBeUndefined()
  })

  it('adds dependency_audit for database/api/backend domains', () => {
    const db = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['database'] })
    expect(db.built_in_gates?.dependency_audit).toBe('auto')
    const api = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['api'] })
    expect(api.built_in_gates?.dependency_audit).toBe('auto')
    const backend = deriveSpecEnrichment({ complexity: 'low', total_tasks: 3, domains: ['Backend'] })
    expect(backend.built_in_gates?.dependency_audit).toBe('auto')
  })

  it('scales max_concurrent_reviews with task count', () => {
    const few = deriveSpecEnrichment({ complexity: 'low', total_tasks: 4, domains: [] })
    expect(few.max_concurrent_reviews).toBe(2)
    const many = deriveSpecEnrichment({ complexity: 'high', total_tasks: 10, domains: [] })
    expect(many.max_concurrent_reviews).toBe(3)
  })
})
