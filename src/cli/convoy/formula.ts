import { readFileSync } from 'node:fs'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { parseTaskSpecText } from '../run/schema.js'
import type { TaskSpec, ValidationResult } from './spec-types.js'

export interface FormulaTemplate {
  name: string
  description?: string
  variables: Record<string, {
    description?: string
    required: boolean
    default?: string
  }>
  spec: unknown
}

export class FormulaValidationError extends Error {
  readonly missingVariables: string[]
  constructor(missingVariables: string[]) {
    super(`Missing required formula variables: ${missingVariables.join(', ')}`)
    this.name = 'FormulaValidationError'
    this.missingVariables = missingVariables
  }
}

// Matches {{varname}} and {{varname | filter}} with optional whitespace
const PLACEHOLDER_RE = /\{\{(\s*\w+\s*(?:\|\s*\w+\s*)?)\}\}/g

function toKebab(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

function toSnake(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

function toUpper(value: string): string {
  return value
    .replace(/[\s-]+/g, '_')
    .toUpperCase()
}

export function parseFormula(templatePath: string): FormulaTemplate {
  let raw: string
  try {
    raw = readFileSync(templatePath, 'utf8')
  } catch (err: unknown) {
    throw new Error(`Cannot read formula file: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = yamlParse(raw)
  } catch (err: unknown) {
    throw new Error(`Formula YAML parse error: ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Formula file must be a YAML mapping')
  }

  const obj = parsed as Record<string, unknown>

  if (!obj.name || typeof obj.name !== 'string') {
    throw new Error('Formula template must have a "name" field')
  }
  if (obj.spec === undefined || obj.spec === null) {
    throw new Error('Formula template must have a "spec" field')
  }

  const variables: FormulaTemplate['variables'] = {}
  if (obj.variables && typeof obj.variables === 'object' && !Array.isArray(obj.variables)) {
    for (const [key, val] of Object.entries(obj.variables as Record<string, unknown>)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      const v = val as Record<string, unknown>
      variables[key] = {
        description: typeof v.description === 'string' ? v.description : undefined,
        required: v.required === true,
        default: typeof v.default === 'string' ? v.default : undefined,
      }
    }
  }

  return {
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    variables,
    spec: obj.spec,
  }
}

export function substituteVariables(
  template: FormulaTemplate,
  vars: Record<string, string>,
): TaskSpec {
  const specYaml = yamlStringify(template.spec)
  const missing: string[] = []

  const result = specYaml.replace(PLACEHOLDER_RE, (match, inner: string) => {
    const parts = inner.split('|').map((p: string) => p.trim())
    const varName = parts[0]
    const filter = parts[1] ?? null

    let value: string
    if (varName in vars) {
      value = vars[varName]
    } else if (varName in template.variables) {
      const def = template.variables[varName]
      if (def.required) {
        missing.push(varName)
        return match // keep placeholder; collect all missing vars
      }
      value = def.default ?? ''
    } else {
      value = ''
    }

    if (filter === 'kebab') return toKebab(value)
    if (filter === 'snake') return toSnake(value)
    if (filter === 'upper') return toUpper(value)
    return value
  })

  if (missing.length > 0) {
    throw new FormulaValidationError(missing)
  }

  return parseTaskSpecText(result)
}

export function validateTemplate(template: FormulaTemplate): ValidationResult {
  const errors: string[] = []
  const VALID_IDENTIFIER = /^[a-zA-Z0-9_]+$/

  if (!template.name || typeof template.name !== 'string') {
    errors.push('"name" field is required')
  }
  if (template.spec === undefined || template.spec === null) {
    errors.push('"spec" field is required')
  }

  for (const key of Object.keys(template.variables)) {
    if (!VALID_IDENTIFIER.test(key)) {
      errors.push(
        `Variable name "${key}" is not a valid identifier (alphanumeric + underscore only)`,
      )
    }
  }

  // Warn on undeclared {{variable}} placeholders in spec
  if (template.spec !== undefined && template.spec !== null) {
    try {
      const specYaml = yamlStringify(template.spec)
      for (const match of specYaml.matchAll(PLACEHOLDER_RE)) {
        const varName = match[1].split('|')[0].trim()
        if (!(varName in template.variables)) {
          process.stderr.write(
            `Warning: template contains undeclared placeholder "{{${varName}}}"\n`,
          )
        }
      }
    } catch {
      // If stringify fails, skip placeholder checking
    }
  }

  return { valid: errors.length === 0, errors }
}
