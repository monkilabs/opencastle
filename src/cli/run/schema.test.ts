import { describe, it, expect } from 'vitest'
import { parseYaml, parseTimeout, validateSpec, applyDefaults, isConvoySpec, isPipelineSpec, parseTaskSpecText } from './schema.js'

// ── parseYaml ──────────────────────────────────────────────────

describe('parseYaml', () => {
  it('parses valid YAML mapping', () => {
    const result = parseYaml('name: test\nvalue: 42')
    expect(result).toEqual({ name: 'test', value: 42 })
  })

  it('throws on scalar top-level value', () => {
    expect(() => parseYaml('hello')).toThrow('YAML must be a mapping')
  })

  it('throws on array top-level value', () => {
    expect(() => parseYaml('- a\n- b')).toThrow('YAML must be a mapping')
  })

  it('throws on empty input', () => {
    expect(() => parseYaml('')).toThrow('YAML must be a mapping')
  })

  it('handles nested objects', () => {
    const result = parseYaml('parent:\n  child: value')
    expect(result).toEqual({ parent: { child: 'value' } })
  })

  it('handles multiline strings', () => {
    const result = parseYaml('text: |\n  line one\n  line two')
    expect(result.text).toContain('line one')
    expect(result.text).toContain('line two')
  })

  it('rejects YAML with dangerous __proto__ key gracefully', () => {
    // yaml npm package handles __proto__ safely by default
    const result = parseYaml('__proto__:\n  polluted: true')
    expect(result).toBeDefined()
    // Verify prototype pollution didn't work
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

// ── parseTimeout ───────────────────────────────────────────────

describe('parseTimeout', () => {
  it('parses seconds', () => {
    expect(parseTimeout('30s')).toBe(30_000)
  })

  it('parses minutes', () => {
    expect(parseTimeout('10m')).toBe(600_000)
  })

  it('parses hours', () => {
    expect(parseTimeout('2h')).toBe(7_200_000)
  })

  it('returns NaN for invalid format', () => {
    expect(parseTimeout('abc')).toBeNaN()
  })

  it('returns NaN for missing unit', () => {
    expect(parseTimeout('10')).toBeNaN()
  })

  it('returns NaN for empty string', () => {
    expect(parseTimeout('')).toBeNaN()
  })

  it('handles single digit', () => {
    expect(parseTimeout('1s')).toBe(1_000)
  })

  it('handles large values', () => {
    expect(parseTimeout('999m')).toBe(999 * 60 * 1000)
  })
})

// ── validateSpec ───────────────────────────────────────────────

describe('validateSpec', () => {
  const validSpec = {
    name: 'test-run',
    tasks: [
      { id: 'task-1', prompt: 'Do something' },
      { id: 'task-2', prompt: 'Do another thing', depends_on: ['task-1'] },
    ],
  }

  it('accepts a valid minimal spec', () => {
    const result = validateSpec(validSpec)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects null input', () => {
    const result = validateSpec(null)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatch(/must be a YAML object/)
  })

  it('rejects non-object input', () => {
    const result = validateSpec('string')
    expect(result.valid).toBe(false)
  })

  it('requires name field', () => {
    const result = validateSpec({ tasks: [{ id: 'a', prompt: 'b' }] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('name'))
  })

  it('requires tasks array', () => {
    const result = validateSpec({ name: 'test' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tasks'))
  })

  it('rejects empty tasks array', () => {
    const result = validateSpec({ name: 'test', tasks: [] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('non-empty'))
  })

  it('rejects tasks without id', () => {
    const result = validateSpec({ name: 'test', tasks: [{ prompt: 'x' }] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('id'))
  })

  it('rejects tasks without prompt', () => {
    const result = validateSpec({ name: 'test', tasks: [{ id: 'a' }] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('prompt'))
  })

  it('rejects duplicate task ids', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [
        { id: 'same', prompt: 'a' },
        { id: 'same', prompt: 'b' },
      ],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('duplicate'))
  })

  it('validates concurrency is a positive integer', () => {
    const result = validateSpec({ ...validSpec, concurrency: -1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('concurrency'))
  })

  it('validates concurrency rejects zero', () => {
    const result = validateSpec({ ...validSpec, concurrency: 0 })
    expect(result.valid).toBe(false)
  })

  it('accepts valid concurrency', () => {
    const result = validateSpec({ ...validSpec, concurrency: 3 })
    expect(result.valid).toBe(true)
  })

  it('validates on_failure values', () => {
    const result = validateSpec({ ...validSpec, on_failure: 'invalid' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('on_failure'))
  })

  it('accepts valid on_failure values', () => {
    expect(validateSpec({ ...validSpec, on_failure: 'continue' }).valid).toBe(true)
    expect(validateSpec({ ...validSpec, on_failure: 'stop' }).valid).toBe(true)
  })

  it('validates adapter is a string', () => {
    const result = validateSpec({ ...validSpec, adapter: 123 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('adapter'))
  })

  it('validates invalid timeout format', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', timeout: 'bad' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('timeout'))
  })

  it('validates depends_on must be an array', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', depends_on: 'task-1' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('depends_on'))
  })

  it('validates depends_on references exist', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', depends_on: ['nonexistent'] }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('unknown task'))
  })

  it('validates files must be an array', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', files: 'not-array' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('files'))
  })

  it('detects simple circular dependency (A→B→A)', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [
        { id: 'a', prompt: 'x', depends_on: ['b'] },
        { id: 'b', prompt: 'y', depends_on: ['a'] },
      ],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('Circular'))
  })

  it('detects 3-node cycle (A→B→C→A)', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [
        { id: 'a', prompt: 'x', depends_on: ['c'] },
        { id: 'b', prompt: 'y', depends_on: ['a'] },
        { id: 'c', prompt: 'z', depends_on: ['b'] },
      ],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('Circular'))
  })

  it('accepts a valid DAG without cycles', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [
        { id: 'a', prompt: 'x' },
        { id: 'b', prompt: 'y', depends_on: ['a'] },
        { id: 'c', prompt: 'z', depends_on: ['a', 'b'] },
      ],
    })
    expect(result.valid).toBe(true)
  })

  it('accepts a self-contained task (no depends_on)', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'solo', prompt: 'do it' }],
    })
    expect(result.valid).toBe(true)
  })

  it('collects multiple errors at once', () => {
    const result = validateSpec({
      tasks: [{ id: 123, timeout: 'bad' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(1)
  })
})

// ── applyDefaults ──────────────────────────────────────────────

describe('applyDefaults', () => {
  it('applies default concurrency', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.concurrency).toBe(1)
  })

  it('applies default on_failure', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.on_failure).toBe('continue')
  })

  it('applies default adapter', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    // Empty string signals run.ts to auto-detect; no hardcoded default here
    expect(spec.adapter).toBe('')
  })

  it('leaves adapter empty when not specified so run.ts can auto-detect', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.adapter).toBe('')
  })

  it('preserves user-specified values', () => {
    const spec = applyDefaults({
      name: 'test',
      concurrency: 3,
      on_failure: 'stop',
      adapter: 'copilot',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.concurrency).toBe(3)
    expect(spec.on_failure).toBe('stop')
    expect(spec.adapter).toBe('copilot')
  })

  it('applies task-level defaults', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    const task = spec.tasks![0]
    expect(task.agent).toBe('developer')
    expect(task.timeout).toBe('30m')
    expect(task.depends_on).toEqual([])
    expect(task.files).toEqual([])
  })

  it('preserves user-specified task values', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{
        id: 'a',
        prompt: 'x',
        agent: 'ui-ux-expert',
        timeout: '15m',
        depends_on: ['b'],
        files: ['src/'],
      }],
    })
    const task = spec.tasks![0]
    expect(task.agent).toBe('ui-ux-expert')
    expect(task.timeout).toBe('15m')
    expect(task.depends_on).toEqual(['b'])
    expect(task.files).toEqual(['src/'])
  })
})

// ── validateSpec — version field ───────────────────────────────

describe('validateSpec — version field', () => {
  const validSpec = {
    name: 'test-run',
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts version 1', () => {
    const result = validateSpec({ ...validSpec, version: 1 })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects version 3', () => {
    const result = validateSpec({ ...validSpec, version: 3 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('version'))
  })

  it('accepts version 2', () => {
    const result = validateSpec({ ...validSpec, version: 2 })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects non-integer version', () => {
    const result = validateSpec({ ...validSpec, version: 1.5 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('version'))
  })

  it('rejects string version', () => {
    const result = validateSpec({ ...validSpec, version: '1' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('version'))
  })

  it('omitting version is valid (legacy spec)', () => {
    const result = validateSpec(validSpec)
    expect(result.valid).toBe(true)
  })
})

// ── validateSpec — defaults block ──────────────────────────────

describe('validateSpec — defaults block', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts a fully specified defaults block', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { timeout: '10m', model: 'gpt-4', max_retries: 2, agent: 'developer' },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts partial defaults block', () => {
    const result = validateSpec({ ...validSpec, defaults: { timeout: '5m' } })
    expect(result.valid).toBe(true)
  })

  it('rejects defaults as a non-object', () => {
    const result = validateSpec({ ...validSpec, defaults: 'invalid' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults'))
  })

  it('rejects defaults as an array', () => {
    const result = validateSpec({ ...validSpec, defaults: ['timeout', '10m'] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults'))
  })

  it('rejects defaults with invalid timeout format', () => {
    const result = validateSpec({ ...validSpec, defaults: { timeout: 'bad' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.stringContaining('defaults.timeout')
    )
  })

  it('rejects defaults with non-string model', () => {
    const result = validateSpec({ ...validSpec, defaults: { model: 42 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.stringContaining('defaults.model')
    )
  })

  it('rejects defaults with negative max_retries', () => {
    const result = validateSpec({ ...validSpec, defaults: { max_retries: -1 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.stringContaining('defaults.max_retries')
    )
  })

  it('rejects defaults with non-integer max_retries', () => {
    const result = validateSpec({ ...validSpec, defaults: { max_retries: 1.5 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.stringContaining('defaults.max_retries')
    )
  })

  it('accepts defaults.max_retries of 0', () => {
    const result = validateSpec({ ...validSpec, defaults: { max_retries: 0 } })
    expect(result.valid).toBe(true)
  })

  it('rejects defaults with non-string agent', () => {
    const result = validateSpec({ ...validSpec, defaults: { agent: 99 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.stringContaining('defaults.agent')
    )
  })
})

// ── validateSpec — gates field ─────────────────────────────────

describe('validateSpec — gates field', () => {
  const validSpec = {
    name: 'test-run',
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts a valid gates array', () => {
    const result = validateSpec({
      ...validSpec,
      gates: ['npm test', 'npx tsc --noEmit'],
    })
    expect(result.valid).toBe(true)
  })

  it('accepts an empty gates array', () => {
    const result = validateSpec({ ...validSpec, gates: [] })
    expect(result.valid).toBe(true)
  })

  it('rejects gates as a string', () => {
    const result = validateSpec({ ...validSpec, gates: 'npm test' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('gates'))
  })

  it('rejects gates with non-string items', () => {
    const result = validateSpec({ ...validSpec, gates: ['npm test', 42] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('gates'))
  })
})

// ── validateSpec — branch field ────────────────────────────────

describe('validateSpec — branch field', () => {
  const validSpec = {
    name: 'test-run',
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts a valid branch string', () => {
    const result = validateSpec({ ...validSpec, branch: 'feat/my-feature' })
    expect(result.valid).toBe(true)
  })

  it('rejects non-string branch', () => {
    const result = validateSpec({ ...validSpec, branch: 123 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('branch'))
  })

  it('rejects boolean branch', () => {
    const result = validateSpec({ ...validSpec, branch: true })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('branch'))
  })
})

// ── validateSpec — per-task adapter ──────────────────────────

describe('validateSpec — per-task adapter', () => {
  it('task.adapter must be a string', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', adapter: 123 }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('adapter'))
  })

  it('task.adapter accepts valid string', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', adapter: 'opencode' }],
    })
    expect(result.valid).toBe(true)
  })
})

// ── validateSpec — per-task model and max_retries ──────────────

describe('validateSpec — per-task model and max_retries', () => {
  it('accepts valid task model string', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', model: 'claude-3.5-sonnet' }],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects non-string task model', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', model: 123 }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('model'))
  })

  it('accepts valid task max_retries', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', max_retries: 3 }],
    })
    expect(result.valid).toBe(true)
  })

  it('accepts zero max_retries', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', max_retries: 0 }],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects negative max_retries', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', max_retries: -1 }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_retries'))
  })

  it('rejects non-integer max_retries', () => {
    const result = validateSpec({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', max_retries: 1.5 }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_retries'))
  })
})

// ── isConvoySpec ───────────────────────────────────────────────

describe('isConvoySpec', () => {
  it('returns true for version 1 spec', () => {
    expect(
      isConvoySpec({ name: 'test', version: 1, tasks: [{ id: 'a', prompt: 'x' }] })
    ).toBe(true)
  })

  it('returns true for version 2 spec', () => {
    expect(
      isConvoySpec({ name: 'test', version: 2, depends_on_convoy: ['other-convoy'] })
    ).toBe(true)
  })

  it('returns false for legacy spec without version', () => {
    expect(
      isConvoySpec({ name: 'test', tasks: [{ id: 'a', prompt: 'x' }] })
    ).toBe(false)
  })

  it('returns false for version 3', () => {
    expect(isConvoySpec({ name: 'test', version: 3 })).toBe(false)
  })

  it('returns false for null input', () => {
    expect(isConvoySpec(null)).toBe(false)
  })

  it('returns false for non-object input', () => {
    expect(isConvoySpec('string')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isConvoySpec(undefined)).toBe(false)
  })
})

// ── applyDefaults — convoy spec (version: 1) ───────────────────

describe('applyDefaults — convoy spec (version: 1)', () => {
  it('merges defaults.agent into tasks when not specified', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { agent: 'ui-ux-expert' },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].agent).toBe('ui-ux-expert')
  })

  it('task-level agent overrides default', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { agent: 'ui-ux-expert' },
      tasks: [{ id: 'a', prompt: 'x', agent: 'developer' }],
    })
    expect(spec.tasks![0].agent).toBe('developer')
  })

  it('merges defaults.timeout into tasks', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { timeout: '15m' },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].timeout).toBe('15m')
  })

  it('task-level timeout overrides defaults.timeout', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { timeout: '15m' },
      tasks: [{ id: 'a', prompt: 'x', timeout: '5m' }],
    })
    expect(spec.tasks![0].timeout).toBe('5m')
  })

  it('merges defaults.model into tasks', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { model: 'gpt-4' },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].model).toBe('gpt-4')
  })

  it('task-level model overrides defaults.model', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { model: 'gpt-4' },
      tasks: [{ id: 'a', prompt: 'x', model: 'claude-3.5-sonnet' }],
    })
    expect(spec.tasks![0].model).toBe('claude-3.5-sonnet')
  })

  it('no model set when no defaults.model and no task model', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].model).toBeUndefined()
  })

  it('merges defaults.max_retries into tasks', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { max_retries: 3 },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].max_retries).toBe(3)
  })

  it('task-level max_retries overrides defaults.max_retries', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { max_retries: 3 },
      tasks: [{ id: 'a', prompt: 'x', max_retries: 0 }],
    })
    expect(spec.tasks![0].max_retries).toBe(0)
  })

  it('propagates version and defaults fields through to spec', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { model: 'gpt-4' },
      gates: ['npm test'],
      branch: 'feat/convoy',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.version).toBe(1)
    expect(spec.gates).toEqual(['npm test'])
    expect(spec.branch).toBe('feat/convoy')
  })

  it('applies defaults.adapter to tasks without explicit adapter', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { adapter: 'opencode' },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].adapter).toBe('opencode')
  })

  it('task-level adapter overrides defaults.adapter', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      defaults: { adapter: 'opencode' },
      tasks: [{ id: 'a', prompt: 'x', adapter: 'claude-code' }],
    })
    expect(spec.tasks![0].adapter).toBe('claude-code')
  })

  it('tasks without adapter remain undefined when no defaults', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].adapter).toBeUndefined()
  })
})

// ── applyDefaults — max_retries default always applied ─────────

describe('applyDefaults — max_retries always applied', () => {
  it('applies max_retries default of 1 for legacy spec', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].max_retries).toBe(1)
  })

  it('applies max_retries default of 1 when version:1 has no defaults block', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks![0].max_retries).toBe(1)
  })

  it('preserves explicit task max_retries in legacy spec', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x', max_retries: 5 }],
    })
    expect(spec.tasks![0].max_retries).toBe(5)
  })
})

// ── backward compatibility ─────────────────────────────────────

describe('backward compatibility — legacy specs', () => {
  it('legacy spec validates identically without version field', () => {
    const result = validateSpec({
      name: 'test-run',
      tasks: [
        { id: 'task-1', prompt: 'Do something' },
        { id: 'task-2', prompt: 'Do another thing', depends_on: ['task-1'] },
      ],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('legacy spec applyDefaults produces same agent/timeout/depends_on/files as before', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    const task = spec.tasks![0]
    expect(task.agent).toBe('developer')
    expect(task.timeout).toBe('30m')
    expect(task.depends_on).toEqual([])
    expect(task.files).toEqual([])
  })

  it('user-specified legacy task values are preserved', () => {
    const spec = applyDefaults({
      name: 'test',
      tasks: [{
        id: 'a',
        prompt: 'x',
        agent: 'ui-ux-expert',
        timeout: '5m',
        depends_on: ['b'],
        files: ['src/'],
      }],
    })
    const task = spec.tasks![0]
    expect(task.agent).toBe('ui-ux-expert')
    expect(task.timeout).toBe('5m')
    expect(task.depends_on).toEqual(['b'])
    expect(task.files).toEqual(['src/'])
  })

  it('defaults block is ignored without version:1', () => {
    // Without version:1, the defaults block should not be merged
    const spec = applyDefaults({
      name: 'test',
      defaults: { agent: 'ui-ux-expert', model: 'gpt-4' },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    // agent falls back to hardcoded 'developer', not defaults.agent
    expect(spec.tasks![0].agent).toBe('developer')
    // model is not set
    expect(spec.tasks![0].model).toBeUndefined()
  })
})

// ── parseTaskSpecText ──────────────────────────────────────────

describe('parseTaskSpecText', () => {
  it('parses a valid YAML string and returns a TaskSpec', () => {
    const yaml = `
name: test-run
tasks:
  - id: task-1
    prompt: Do something
`
    const spec = parseTaskSpecText(yaml)
    expect(spec.name).toBe('test-run')
    expect(spec.tasks).toHaveLength(1)
    expect(spec.tasks![0].id).toBe('task-1')
  })

  it('throws on empty string', () => {
    expect(() => parseTaskSpecText('')).toThrow('empty')
  })

  it('throws on whitespace-only string', () => {
    expect(() => parseTaskSpecText('   \n  ')).toThrow('empty')
  })

  it('throws on invalid YAML', () => {
    expect(() => parseTaskSpecText(': invalid: yaml: {')).toThrow(/YAML parse error/)
  })

  it('throws on invalid spec (missing tasks)', () => {
    expect(() => parseTaskSpecText('name: test')).toThrow(/Invalid task spec/)
  })

  it('applies defaults when parsing', () => {
    const yaml = `
name: test-run
tasks:
  - id: task-1
    prompt: Do something
`
    const spec = parseTaskSpecText(yaml)
    expect(spec.concurrency).toBe(1)
    expect(spec.on_failure).toBe('continue')
    expect(spec.tasks![0].agent).toBe('developer')
    expect(spec.tasks![0].timeout).toBe('30m')
  })

  it('parses a convoy spec (version: 1)', () => {
    const yaml = `
name: convoy-run
version: 1
tasks:
  - id: task-1
    prompt: Do something
`
    const spec = parseTaskSpecText(yaml)
    expect(spec.version).toBe(1)
    expect(isConvoySpec(spec)).toBe(true)
  })
})

// ── validateSpec — depends_on_convoy / pipeline specs ──────────

describe('validateSpec — depends_on_convoy field', () => {
  it('accepts depends_on_convoy as an array of strings', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1', 'phase-2'],
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects depends_on_convoy as a string (not array)', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: 'phase-1',
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('depends_on_convoy'))
  })

  it('rejects depends_on_convoy with non-string elements', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1', 42],
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('depends_on_convoy'))
  })

  it('rejects depends_on_convoy as a non-array object', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: { convoy: 'phase-1' },
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('depends_on_convoy'))
  })

  it('accepts omitting depends_on_convoy entirely (optional field)', () => {
    const result = validateSpec({
      name: 'convoy-run',
      version: 1,
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(result.valid).toBe(true)
  })
})

// ── validateSpec — pipeline spec (v2 tasks-optional) ──────────

describe('validateSpec — pipeline spec (version:2, no tasks)', () => {
  it('pipeline spec with no tasks is valid when depends_on_convoy is set', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1'],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('pipeline spec with tasks AND depends_on_convoy is valid', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1'],
      tasks: [{ id: 'a', prompt: 'do local work' }],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('version:2 without depends_on_convoy still requires tasks', () => {
    const result = validateSpec({
      name: 'convoy-v2',
      version: 2,
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tasks'))
  })

  it('pipeline spec with empty depends_on_convoy still requires tasks', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: [],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tasks'))
  })

  it('pipeline spec with explicitly empty tasks array is invalid', () => {
    const result = validateSpec({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1'],
      tasks: [],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('non-empty'))
  })
})

// ── isPipelineSpec ─────────────────────────────────────────────

describe('isPipelineSpec', () => {
  it('returns true for version:2 spec with non-empty depends_on_convoy', () => {
    expect(
      isPipelineSpec({ name: 'pipeline', version: 2, depends_on_convoy: ['phase-1'] })
    ).toBe(true)
  })

  it('returns true when depends_on_convoy has multiple entries', () => {
    expect(
      isPipelineSpec({ name: 'pipeline', version: 2, depends_on_convoy: ['a', 'b', 'c'] })
    ).toBe(true)
  })

  it('returns false for v1 spec without depends_on_convoy', () => {
    expect(
      isPipelineSpec({ name: 'convoy', version: 1, tasks: [{ id: 'a', prompt: 'x' }] })
    ).toBe(false)
  })

  it('returns false for v1 spec even with depends_on_convoy (wrong version)', () => {
    expect(
      isPipelineSpec({ name: 'convoy', version: 1, depends_on_convoy: ['phase-1'] })
    ).toBe(false)
  })

  it('returns false for version:2 with empty depends_on_convoy', () => {
    expect(
      isPipelineSpec({ name: 'pipeline', version: 2, depends_on_convoy: [] })
    ).toBe(false)
  })

  it('returns false for version:2 without depends_on_convoy', () => {
    expect(
      isPipelineSpec({ name: 'convoy', version: 2, tasks: [{ id: 'a', prompt: 'x' }] })
    ).toBe(false)
  })

  it('returns false for legacy spec (no version)', () => {
    expect(
      isPipelineSpec({ name: 'legacy', tasks: [{ id: 'a', prompt: 'x' }] })
    ).toBe(false)
  })

  it('returns false for null input', () => {
    expect(isPipelineSpec(null)).toBe(false)
  })

  it('returns false for non-object input', () => {
    expect(isPipelineSpec('string')).toBe(false)
  })
})

// ── isConvoySpec — version 1 and 2 ────────────────────────────

describe('isConvoySpec — version 1 and 2', () => {
  it('returns true for version 1 spec', () => {
    expect(isConvoySpec({ version: 1, tasks: [] })).toBe(true)
  })

  it('returns true for version 2 pipeline spec', () => {
    expect(isConvoySpec({ version: 2, depends_on_convoy: ['phase-1'] })).toBe(true)
  })

  it('returns true for version 2 spec with tasks', () => {
    expect(isConvoySpec({ version: 2, tasks: [{ id: 'a', prompt: 'x' }] })).toBe(true)
  })

  it('returns false for legacy spec (no version)', () => {
    expect(isConvoySpec({ name: 'legacy', tasks: [] })).toBe(false)
  })

  it('returns false for version 3', () => {
    expect(isConvoySpec({ version: 3 })).toBe(false)
  })
})

// ── applyDefaults — pipeline spec (version:2, no tasks) ────────

describe('applyDefaults — pipeline spec (version:2, no tasks)', () => {
  it('pipeline spec with no tasks produces empty tasks array', () => {
    const spec = applyDefaults({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1'],
    })
    expect(spec.tasks).toBeUndefined()
    expect(spec.name).toBe('pipeline')
    expect(spec.version).toBe(2)
    expect(spec.depends_on_convoy).toEqual(['phase-1'])
  })

  it('pipeline spec with tasks applies defaults normally', () => {
    const spec = applyDefaults({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1'],
      tasks: [{ id: 'a', prompt: 'x' }],
    })
    expect(spec.tasks).toHaveLength(1)
    expect(spec.tasks![0].agent).toBe('developer')
    expect(spec.tasks![0].timeout).toBe('30m')
  })

  it('preserves depends_on_convoy through applyDefaults', () => {
    const spec = applyDefaults({
      name: 'pipeline',
      version: 2,
      depends_on_convoy: ['phase-1', 'phase-2'],
    })
    expect(spec.depends_on_convoy).toEqual(['phase-1', 'phase-2'])
  })
})

// ── validateSpec — gate_retries field ─────────────────────────

describe('validateSpec — gate_retries field', () => {
  const validSpec = {
    name: 'test',
    tasks: [{ id: 'a', prompt: 'do something' }],
  }

  it('accepts gate_retries as 0', () => {
    const result = validateSpec({ ...validSpec, gate_retries: 0 })
    expect(result.valid).toBe(true)
  })

  it('accepts gate_retries as a positive integer', () => {
    const result = validateSpec({ ...validSpec, gate_retries: 3 })
    expect(result.valid).toBe(true)
  })

  it('rejects gate_retries as negative', () => {
    const result = validateSpec({ ...validSpec, gate_retries: -1 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('gate_retries'))
  })

  it('rejects gate_retries as a float', () => {
    const result = validateSpec({ ...validSpec, gate_retries: 1.5 })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('gate_retries'))
  })

  it('rejects gate_retries as a string', () => {
    const result = validateSpec({ ...validSpec, gate_retries: 'two' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('gate_retries'))
  })
})

// ── applyDefaults — gate_retries default ───────────────────────

describe('applyDefaults — gate_retries default', () => {
  it('defaults gate_retries to 0', () => {
    const spec = applyDefaults({ name: 'test', tasks: [{ id: 'a', prompt: 'p' }] })
    expect(spec.gate_retries).toBe(0)
  })

  it('preserves explicit gate_retries value', () => {
    const spec = applyDefaults({ name: 'test', tasks: [{ id: 'a', prompt: 'p' }], gate_retries: 2 })
    expect(spec.gate_retries).toBe(2)
  })
})

// ── guard config validation ─────────────────────────────────────

describe('guard config', () => {
  const baseSpec = {
    name: 'test-run',
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts a valid guard config', () => {
    const result = validateSpec({
      ...baseSpec,
      guard: { enabled: true, agent: 'reviewer', checks: ['observability', 'cleanup'] },
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts guard with only enabled: false', () => {
    const result = validateSpec({ ...baseSpec, guard: { enabled: false } })
    expect(result.valid).toBe(true)
  })

  it('accepts guard with no fields (all optional)', () => {
    const result = validateSpec({ ...baseSpec, guard: {} })
    expect(result.valid).toBe(true)
  })

  it('rejects guard.enabled that is not a boolean', () => {
    const result = validateSpec({ ...baseSpec, guard: { enabled: 'yes' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('guard.enabled'))
  })

  it('rejects guard.agent that is not a string', () => {
    const result = validateSpec({ ...baseSpec, guard: { agent: 42 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('guard.agent'))
  })

  it('rejects guard.checks that is not an array', () => {
    const result = validateSpec({ ...baseSpec, guard: { checks: 'observability' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('guard.checks'))
  })

  it('rejects guard.checks with empty string entries', () => {
    const result = validateSpec({ ...baseSpec, guard: { checks: ['valid', ''] } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('guard.checks'))
  })
})

// ── review field validation ────────────────────────────────────────────────────

describe('review defaults validation', () => {
  const baseV1Spec = {
    name: 'test',
    version: 1,
    tasks: [{ id: 't1', prompt: 'Do it' }],
  }

  it('accepts valid defaults.review values', () => {
    for (const r of ['auto', 'fast', 'panel', 'none']) {
      const result = validateSpec({ ...baseV1Spec, defaults: { review: r } })
      expect(result.valid).toBe(true)
    }
  })

  it('rejects invalid defaults.review value', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { review: 'always' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults.review'))
  })

  it('accepts defaults.reviewer_model string', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { reviewer_model: 'gpt-4' } })
    expect(result.valid).toBe(true)
  })

  it('rejects defaults.reviewer_model non-string', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { reviewer_model: 42 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults.reviewer_model'))
  })

  it('accepts defaults.review_budget positive integer', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { review_budget: 1000 } })
    expect(result.valid).toBe(true)
  })

  it('rejects defaults.review_budget of 0', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { review_budget: 0 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults.review_budget'))
  })

  it('accepts valid on_review_budget_exceeded values', () => {
    for (const v of ['skip', 'downgrade', 'stop']) {
      const result = validateSpec({ ...baseV1Spec, defaults: { on_review_budget_exceeded: v } })
      expect(result.valid).toBe(true)
    }
  })

  it('rejects invalid on_review_budget_exceeded', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { on_review_budget_exceeded: 'ignore' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults.on_review_budget_exceeded'))
  })

  it('accepts defaults.max_concurrent_reviews positive integer', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { max_concurrent_reviews: 3 } })
    expect(result.valid).toBe(true)
  })

  it('rejects defaults.max_concurrent_reviews of 0', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { max_concurrent_reviews: 0 } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults.max_concurrent_reviews'))
  })

  it('accepts valid review_heuristics object', () => {
    const result = validateSpec({
      ...baseV1Spec,
      defaults: {
        review_heuristics: {
          panel_paths: ['auth/', 'security/'],
          panel_agents: ['security-expert'],
          auto_pass_agents: ['writer'],
          auto_pass_max_lines: 20,
          auto_pass_max_files: 3,
        },
      },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects review_heuristics as non-object', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { review_heuristics: 'fast' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('defaults.review_heuristics'))
  })

  it('rejects review_heuristics.panel_paths with non-string entries', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { review_heuristics: { panel_paths: [1, 2] } } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('review_heuristics.panel_paths'))
  })

  it('rejects review_heuristics.auto_pass_max_lines of 0', () => {
    const result = validateSpec({ ...baseV1Spec, defaults: { review_heuristics: { auto_pass_max_lines: 0 } } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('auto_pass_max_lines'))
  })
})

describe('per-task review field validation', () => {
  const taskBase = { name: 'test', tasks: [{ id: 't1', prompt: 'Do it' }] }

  it('accepts valid per-task review values', () => {
    for (const r of ['auto', 'fast', 'panel', 'none']) {
      const result = validateSpec({ ...taskBase, tasks: [{ id: 't1', prompt: 'Do it', review: r }] })
      expect(result.valid).toBe(true)
    }
  })

  it('rejects invalid per-task review value', () => {
    const result = validateSpec({ ...taskBase, tasks: [{ id: 't1', prompt: 'Do it', review: 'always' }] })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tasks[0]'))
    expect(result.errors).toContainEqual(expect.stringContaining('review'))
  })
})

describe('applyDefaults review merge', () => {
  it('merges defaults.review into tasks when task has no review set', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      tasks: [{ id: 't1', prompt: 'Do it' }],
      defaults: { review: 'panel' },
    })
    expect((spec.tasks![0] as unknown as Record<string, unknown>).review).toBe('panel')
  })

  it('task-level review overrides defaults.review', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      tasks: [{ id: 't1', prompt: 'Do it', review: 'none' }],
      defaults: { review: 'panel' },
    })
    expect((spec.tasks![0] as unknown as Record<string, unknown>).review).toBe('none')
  })

  it('review remains undefined when not set in defaults or task', () => {
    const spec = applyDefaults({
      name: 'test',
      version: 1,
      tasks: [{ id: 't1', prompt: 'Do it' }],
      defaults: {},
    })
    expect((spec.tasks![0] as unknown as Record<string, unknown>).review).toBeUndefined()
  })
})

describe('concurrency: auto (swarm mode)', () => {
  it('accepts concurrency: auto', () => {
    const result = validateSpec({
      name: 'test',
      concurrency: 'auto',
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(true)
  })

  it('accepts concurrency: 1', () => {
    const result = validateSpec({
      name: 'test',
      concurrency: 1,
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects concurrency: 0', () => {
    const result = validateSpec({
      name: 'test',
      concurrency: 0,
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('concurrency')
  })

  it('rejects concurrency: 51', () => {
    const result = validateSpec({
      name: 'test',
      concurrency: 51,
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(false)
  })

  it('rejects concurrency: "invalid"', () => {
    const result = validateSpec({
      name: 'test',
      concurrency: 'invalid',
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(false)
  })
})

describe('defaults.max_swarm_concurrency', () => {
  it('accepts valid max_swarm_concurrency', () => {
    const result = validateSpec({
      name: 'test',
      version: 1,
      defaults: { max_swarm_concurrency: 8 },
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects max_swarm_concurrency: 0', () => {
    const result = validateSpec({
      name: 'test',
      version: 1,
      defaults: { max_swarm_concurrency: 0 },
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('max_swarm_concurrency')
  })

  it('rejects max_swarm_concurrency: 51', () => {
    const result = validateSpec({
      name: 'test',
      version: 1,
      defaults: { max_swarm_concurrency: 51 },
      tasks: [{ id: 't1', prompt: 'do stuff' }],
    })
    expect(result.valid).toBe(false)
  })
})

// ── validateSpec — MCP server config in defaults ──────────────

describe('validateSpec — MCP server config in defaults', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts valid mcp_servers in defaults', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [
          { name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        ],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts mcp_servers with all optional fields', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [
          { name: 'remote', type: 'sse', url: 'https://mcp.example.com', local: false, config: { key: 'val' } },
        ],
      },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts empty mcp_servers array', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_servers: [] },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects mcp_servers as non-array', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_servers: 'not-array' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_servers'))
  })

  it('rejects mcp_server entry without name', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ type: 'stdio' }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('name'))
  })

  it('rejects mcp_server entry without type', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'github' }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('type'))
  })

  it('rejects mcp_server entry with non-string name', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 123, type: 'stdio' }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('name'))
  })

  it('rejects mcp_server entry with non-boolean local', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'stdio', local: 'yes' }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('local'))
  })

  it('rejects mcp_server entry with non-string command', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'stdio', command: 42 }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('command'))
  })

  it('rejects mcp_server entry with non-array args', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'stdio', args: 'not-array' }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('args'))
  })

  it('rejects mcp_server entry with non-string args items', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'stdio', args: [1, 2] }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('args'))
  })

  it('rejects mcp_server entry with non-string url', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'sse', url: 42 }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('url'))
  })

  it('rejects mcp_server entry with non-object config', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'stdio', config: 'not-object' }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('config'))
  })

  it('rejects mcp_server entry with array config', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [{ name: 'x', type: 'stdio', config: [1, 2] }],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('config'))
  })

  it('validates multiple mcp_server entries independently', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: [
          { name: 'valid', type: 'stdio' },
          { name: 123, type: 'stdio' },
        ],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_servers[1].name'))
  })

  it('rejects non-object mcp_server entry', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        mcp_servers: ['not-an-object'],
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_servers[0]'))
  })
})

// ── validateSpec — mcp_approve_all in defaults ────────────────

describe('validateSpec — mcp_approve_all in defaults', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts mcp_approve_all as true', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_approve_all: true },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts mcp_approve_all as false', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_approve_all: false },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects mcp_approve_all as string', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_approve_all: 'yes' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_approve_all'))
  })

  it('rejects mcp_approve_all as number', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_approve_all: 1 },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_approve_all'))
  })
})

// ── validateSpec — mcp_server_approval_timeout in defaults ────

describe('validateSpec — mcp_server_approval_timeout in defaults', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts valid mcp_server_approval_timeout', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_server_approval_timeout: 30 },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects mcp_server_approval_timeout of 0', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_server_approval_timeout: 0 },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_server_approval_timeout'))
  })

  it('rejects negative mcp_server_approval_timeout', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_server_approval_timeout: -5 },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_server_approval_timeout'))
  })

  it('rejects non-number mcp_server_approval_timeout', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { mcp_server_approval_timeout: '30s' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('mcp_server_approval_timeout'))
  })
})

describe('validateSpec — built_in_gates config', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts valid built_in_gates with boolean fields', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { secret_scan: true, blast_radius: false } },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts built_in_gates with "auto" value', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { dependency_audit: 'auto', browser_test: 'auto' } },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects built_in_gates with invalid field value', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { secret_scan: 'yes' } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('built_in_gates.secret_scan'))
  })

  it('rejects built_in_gates that is not an object', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: 'enabled' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('built_in_gates'))
  })

  it('accepts valid gate_timeout', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { gate_timeout: 300 } },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects gate_timeout of 0', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { gate_timeout: 0 } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('gate_timeout'))
  })

  it('accepts tdd_check as boolean', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { tdd_check: true } },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts tdd_check as object', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { tdd_check: { enabled: true, mode: 'block' } } },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects tdd_check with invalid value', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { built_in_gates: { tdd_check: 'yes' } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tdd_check'))
  })
})

describe('validateSpec — review_stages', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts review_stages as true', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { review_stages: true },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts review_stages as false', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { review_stages: false },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects review_stages with non-boolean value', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { review_stages: 'yes' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('review_stages'))
  })
})

describe('validateSpec — browser_test config', () => {
  const validSpec = {
    name: 'test-run',
    version: 1,
    tasks: [{ id: 'task-1', prompt: 'Do something' }],
  }

  it('accepts valid browser_test config in defaults', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        browser_test: { urls: ['http://localhost:3000'] },
      },
    })
    expect(result.valid).toBe(true)
  })

  it('accepts browser_test with all optional fields', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: {
        browser_test: {
          urls: ['http://localhost:3000'],
          check_console_errors: true,
          visual_diff_threshold: 0.1,
          a11y: true,
          severity_threshold: 'serious',
        },
      },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects browser_test with missing urls', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { browser_test: { check_console_errors: true } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('browser_test.urls'))
  })

  it('rejects browser_test with empty urls array', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { browser_test: { urls: [] } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('browser_test.urls'))
  })

  it('rejects browser_test with non-string urls elements', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { browser_test: { urls: [42, 'http://localhost:3000'] } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('browser_test.urls'))
  })

  it('rejects browser_test with invalid severity_threshold', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { browser_test: { urls: ['http://localhost:3000'], severity_threshold: 'fatal' } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('severity_threshold'))
  })

  it('rejects browser_test that is not an object', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { browser_test: 'http://localhost:3000' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('browser_test'))
  })

  it('accepts valid task-level browser_test config', () => {
    const result = validateSpec({
      ...validSpec,
      tasks: [{
        id: 'task-1',
        prompt: 'Do something',
        browser_test: { urls: ['http://localhost:4000'] },
      }],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects invalid task-level browser_test config', () => {
    const result = validateSpec({
      ...validSpec,
      tasks: [{
        id: 'task-1',
        prompt: 'Do something',
        browser_test: { urls: [] },
      }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('browser_test.urls'))
  })

  it('accepts valid task-level built_in_gates', () => {
    const result = validateSpec({
      ...validSpec,
      tasks: [{
        id: 'task-1',
        prompt: 'Do something',
        built_in_gates: { browser_test: true },
      }],
    })
    expect(result.valid).toBe(true)
  })

  it('rejects invalid task-level built_in_gates', () => {
    const result = validateSpec({
      ...validSpec,
      tasks: [{
        id: 'task-1',
        prompt: 'Do something',
        built_in_gates: { browser_test: 'enable' },
      }],
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('built_in_gates.browser_test'))
  })

  it('rejects browser_test with non-string baselines_dir', () => {
    const result = validateSpec({
      ...validSpec,
      defaults: { browser_test: { urls: ['http://localhost:3000'], baselines_dir: 123 } },
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('baselines_dir'))
  })
})
