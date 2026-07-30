import {
  mkdtempSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseFormula,
  substituteVariables,
  validateTemplate,
  FormulaValidationError,
} from './formula.js'
import type { FormulaTemplate } from './formula.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBase(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'formula-test-')))
}

/**
 * Minimal valid TaskSpec content for use in formula `spec:` sections.
 * After substitution, this must pass parseTaskSpecText validation.
 */
const MINIMAL_SPEC = {
  name: 'Test convoy',
  version: 1,
  tasks: [{ id: 'task-1', prompt: 'Do the thing' }],
}

function writeFormula(dir: string, content: string): string {
  const path = join(dir, 'formula.convoy.yml')
  writeFileSync(path, content)
  return path
}

let tmpDir: string

beforeEach(() => {
  tmpDir = makeBase()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── parseFormula ──────────────────────────────────────────────────────────────

describe('parseFormula', () => {
  it('reads a formula file and returns a FormulaTemplate', () => {
    const path = writeFormula(
      tmpDir,
      [
        'name: My Formula',
        'description: A test formula',
        'variables:',
        '  app_name:',
        '    description: App name',
        '    required: true',
        'spec:',
        '  name: Test convoy',
        '  version: 1',
        '  tasks:',
        '    - id: task-1',
        '      prompt: Do the thing',
      ].join('\n'),
    )

    const template = parseFormula(path)
    expect(template.name).toBe('My Formula')
    expect(template.description).toBe('A test formula')
    expect(template.variables['app_name']).toMatchObject({ required: true })
    expect(template.spec).toBeTruthy()
  })

  it('throws when file does not exist', () => {
    expect(() => parseFormula(join(tmpDir, 'missing.yml'))).toThrow(
      /Cannot read formula file/,
    )
  })

  it('throws on invalid YAML', () => {
    const path = writeFormula(tmpDir, ': {{{')
    expect(() => parseFormula(path)).toThrow(/Formula YAML parse error/)
  })

  it('throws when name field is missing', () => {
    const path = writeFormula(
      tmpDir,
      'spec:\n  name: Test convoy\n  version: 1\n  tasks:\n    - id: t1\n      prompt: p\n',
    )
    expect(() => parseFormula(path)).toThrow(/must have a "name" field/)
  })

  it('throws when spec field is missing', () => {
    const path = writeFormula(tmpDir, 'name: My Formula\n')
    expect(() => parseFormula(path)).toThrow(/must have a "spec" field/)
  })

  it('returns empty variables when no variables section', () => {
    const path = writeFormula(
      tmpDir,
      'name: Simple\nspec:\n  name: Test\n  version: 1\n  tasks:\n    - id: t1\n      prompt: p\n',
    )
    const template = parseFormula(path)
    expect(template.variables).toEqual({})
  })

  it('parses optional flag and default value', () => {
    const path = writeFormula(
      tmpDir,
      [
        'name: With defaults',
        'variables:',
        '  env:',
        '    required: false',
        '    default: staging',
        'spec:',
        '  name: Test',
        '  version: 1',
        '  tasks:',
        '    - id: t1',
        '      prompt: p',
      ].join('\n'),
    )
    const template = parseFormula(path)
    expect(template.variables['env']).toMatchObject({ required: false, default: 'staging' })
  })
})

// ── substituteVariables ───────────────────────────────────────────────────────

describe('substituteVariables', () => {
  function makeTemplate(overrides: Partial<FormulaTemplate> = {}): FormulaTemplate {
    return {
      name: 'Test Formula',
      variables: {},
      spec: MINIMAL_SPEC,
      ...overrides,
    }
  }

  it('substitutes a plain variable', () => {
    const template = makeTemplate({
      variables: { feature: { required: true } },
      spec: {
        name: '{{feature}}',
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'Build {{feature}}' }],
      },
    })
    const result = substituteVariables(template, { feature: 'auth' })
    expect(result.name).toBe('auth')
  })

  it('applies kebab filter', () => {
    const template = makeTemplate({
      variables: { feature: { required: true } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: '{{feature | kebab}}' }],
      },
    })
    const result = substituteVariables(template, { feature: 'MyFeature Name' })
    expect(result.tasks![0].prompt).toContain('my-feature-name')
  })

  it('applies snake filter', () => {
    const template = makeTemplate({
      variables: { feature: { required: true } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: '{{feature | snake}}' }],
      },
    })
    const result = substituteVariables(template, { feature: 'MyFeature Name' })
    expect(result.tasks![0].prompt).toContain('my_feature_name')
  })

  it('applies upper filter', () => {
    const template = makeTemplate({
      variables: { feature: { required: true } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: '{{feature | upper}}' }],
      },
    })
    const result = substituteVariables(template, { feature: 'my feature' })
    expect(result.tasks![0].prompt).toContain('MY_FEATURE')
  })

  it('throws FormulaValidationError for missing required variable', () => {
    const template = makeTemplate({
      variables: { required_var: { required: true } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: '{{required_var}}' }],
      },
    })
    expect(() => substituteVariables(template, {})).toThrow(FormulaValidationError)
  })

  it('includes missing variable name in FormulaValidationError', () => {
    const template = makeTemplate({
      variables: { missing_var: { required: true } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: '{{missing_var}}' }],
      },
    })
    let err: FormulaValidationError | undefined
    try {
      substituteVariables(template, {})
    } catch (e) {
      if (e instanceof FormulaValidationError) err = e
    }
    expect(err).toBeDefined()
    expect(err!.missingVariables).toContain('missing_var')
  })

  it('collects all missing required variables', () => {
    const template = makeTemplate({
      variables: {
        var_a: { required: true },
        var_b: { required: true },
      },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: '{{var_a}} and {{var_b}}' }],
      },
    })
    let err: FormulaValidationError | undefined
    try {
      substituteVariables(template, {})
    } catch (e) {
      if (e instanceof FormulaValidationError) err = e
    }
    expect(err!.missingVariables).toEqual(expect.arrayContaining(['var_a', 'var_b']))
  })

  it('uses default value for optional variable without provided value', () => {
    const template = makeTemplate({
      variables: { env: { required: false, default: 'production' } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'Deploy to {{env}}' }],
      },
    })
    const result = substituteVariables(template, {})
    expect(result.tasks![0].prompt).toContain('production')
  })

  it('uses empty string for optional variable with no default', () => {
    const template = makeTemplate({
      variables: { opt: { required: false } },
      spec: {
        name: 'test-task',
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'prefix-{{opt}}-suffix' }],
      },
    })
    const result = substituteVariables(template, {})
    expect(result.tasks![0].prompt).toContain('prefix--suffix')
  })

  it('returns a valid TaskSpec', () => {
    const template = makeTemplate({
      variables: { app: { required: true } },
      spec: {
        name: 'Deploy {{app}}',
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'Deploy {{app}}' }],
      },
    })
    const result = substituteVariables(template, { app: 'myapp' })
    expect(result).toMatchObject({ name: expect.any(String) })
    expect(Array.isArray(result.tasks)).toBe(true)
  })
})

// ── validateTemplate ──────────────────────────────────────────────────────────

describe('validateTemplate', () => {
  function makeTemplate(overrides: Partial<FormulaTemplate> = {}): FormulaTemplate {
    return {
      name: 'Valid Template',
      variables: {},
      spec: MINIMAL_SPEC,
      ...overrides,
    }
  }

  it('returns valid for a correct template', () => {
    const result = validateTemplate(makeTemplate())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns error when name is missing', () => {
    const template = makeTemplate({ name: '' })
    const result = validateTemplate(template)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('"name"'))).toBe(true)
  })

  it('returns error when spec is null', () => {
    const template = makeTemplate({ spec: null as unknown as unknown })
    const result = validateTemplate(template)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('"spec"'))).toBe(true)
  })

  it('returns error for invalid variable identifier', () => {
    const template = makeTemplate({
      variables: { 'invalid-name': { required: false } },
    })
    const result = validateTemplate(template)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('invalid-name'))).toBe(true)
  })

  it('allows valid variable identifiers', () => {
    const template = makeTemplate({
      variables: {
        app_name: { required: true },
        env2: { required: false },
        MY_VAR: { required: false },
      },
    })
    const result = validateTemplate(template)
    expect(result.valid).toBe(true)
  })

  it('writes a warning for undeclared placeholder', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const template = makeTemplate({
      variables: {},
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'Do {{undeclared_var}}' }],
      },
    })
    validateTemplate(template)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('undeclared_var'))
    stderrSpy.mockRestore()
  })

  it('does not warn for declared placeholders', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const template = makeTemplate({
      variables: { declared_var: { required: true } },
      spec: {
        name: 'test',
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'Do {{declared_var}}' }],
      },
    })
    validateTemplate(template)
    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})

// ── Filter helpers ────────────────────────────────────────────────────────────

describe('filter conversions via substituteVariables', () => {
  function makeFilterTemplate(filter: string): FormulaTemplate {
    return {
      name: 'Filter Test',
      variables: { val: { required: true } },
      spec: {
        name: `{{val | ${filter}}}`,
        version: 1,
        tasks: [{ id: 'task-1', prompt: 'x' }],
      },
    }
  }

  it('kebab: converts spaces and underscores to hyphens, lowercases', () => {
    const result = substituteVariables(makeFilterTemplate('kebab'), { val: 'Hello World_Test' })
    expect(result.name).toBe('hello-world-test')
  })

  it('snake: converts spaces and hyphens to underscores, lowercases', () => {
    const result = substituteVariables(makeFilterTemplate('snake'), { val: 'Hello World-Test' })
    expect(result.name).toBe('hello_world_test')
  })

  it('upper: converts to uppercase with underscores', () => {
    const result = substituteVariables(makeFilterTemplate('upper'), { val: 'hello world' })
    expect(result.name).toBe('HELLO_WORLD')
  })
})
