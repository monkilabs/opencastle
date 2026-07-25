import { readFile } from 'node:fs/promises'
import { parse as yamlParse } from 'yaml'
import type { TaskSpec, ValidationResult } from '../convoy/spec-types.js'

/**
 * Parse a YAML string into a JS object.
 * Uses the `yaml` npm package for full YAML 1.2 compliance.
 */
export function parseYaml(text: string): Record<string, unknown> {
  const result = yamlParse(text)
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('YAML must be a mapping at the top level')
  }
  return result as Record<string, unknown>
}

// ── Schema validation ──────────────────────────────────────────────

const VALID_ON_FAILURE = ['continue', 'stop']
const TIMEOUT_RE = /^(\d+)(s|m|h)$/

/**
 * Parse a timeout string into milliseconds.
 */
export function parseTimeout(timeout: string): number {
  const m = String(timeout).match(TIMEOUT_RE)
  if (!m) return NaN
  const num = parseInt(m[1], 10)
  const unit = m[2]
  if (unit === 's') return num * 1000
  if (unit === 'm') return num * 60 * 1000
  if (unit === 'h') return num * 60 * 60 * 1000
  return NaN
}

interface RawSpec {
  name?: string
  concurrency?: number | string
  on_failure?: string
  adapter?: string
  tasks?: RawTask[]
  version?: number
  defaults?: {
    timeout?: string
    model?: string
    max_retries?: number
    agent?: string
    adapter?: string
    mcp_servers?: unknown[]
    mcp_approve_all?: unknown
    mcp_server_approval_timeout?: unknown
    built_in_gates?: unknown
    browser_test?: unknown
    review?: unknown
    reviewer_model?: unknown
    review_budget?: unknown
    on_review_budget_exceeded?: unknown
    max_concurrent_reviews?: unknown
    review_heuristics?: unknown
    max_swarm_concurrency?: unknown
  }
  gates?: string[]
  gate_retries?: number
  branch?: string
  depends_on_convoy?: string[]
  guard?: unknown
}

interface RawTask {
  id?: string
  prompt?: string
  agent?: string
  timeout?: string
  depends_on?: string[]
  files?: string[]
  description?: string
  model?: string
  max_retries?: number
  adapter?: string
  built_in_gates?: unknown
  browser_test?: unknown
  review?: string
}

/**
 * Validate a browser_test config object for the given prefix.
 */
function validateBrowserTestConfig(value: unknown, prefix: string, errors: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`\`${prefix}\` must be an object`)
    return
  }
  const bt = value as Record<string, unknown>
  if (bt.urls === undefined) {
    errors.push(`\`${prefix}.urls\` is required`)
  } else if (!Array.isArray(bt.urls) || (bt.urls as unknown[]).length === 0) {
    errors.push(`\`${prefix}.urls\` must be a non-empty array`)
  } else if (!(bt.urls as unknown[]).every((u) => typeof u === 'string')) {
    errors.push(`\`${prefix}.urls\` must be an array of strings`)
  }
  if (bt.check_console_errors !== undefined && typeof bt.check_console_errors !== 'boolean') {
    errors.push(`\`${prefix}.check_console_errors\` must be a boolean`)
  }
  if (bt.visual_diff_threshold !== undefined) {
    const vdt = Number(bt.visual_diff_threshold)
    if (!Number.isFinite(vdt) || vdt < 0 || vdt > 1) {
      errors.push(`\`${prefix}.visual_diff_threshold\` must be a number between 0 and 1`)
    }
  }
  if (bt.a11y !== undefined && typeof bt.a11y !== 'boolean') {
    errors.push(`\`${prefix}.a11y\` must be a boolean`)
  }
  const validSeverities = ['critical', 'serious', 'moderate', 'minor']
  if (bt.severity_threshold !== undefined && !validSeverities.includes(bt.severity_threshold as string)) {
    errors.push(`\`${prefix}.severity_threshold\` must be one of: ${validSeverities.join(', ')}`)
  }
  if (bt.baselines_dir !== undefined && typeof bt.baselines_dir !== 'string') {
    errors.push(`\`${prefix}.baselines_dir\` must be a string`)
  }
}

/**
 * Validate a parsed spec object.
 */
/**
 * Keys an earlier build honoured and this one does not.
 *
 * Silently accepting them is worse than rejecting them: the spec looks valid, the
 * run proceeds, and the behaviour the author asked for never happens. Rejecting
 * them outright would break specs that are otherwise fine, so they warn.
 */
const RETIRED_DEFAULTS: Record<string, string> = {
  compaction: 'context compaction was removed; the adapter manages its own context',
  inject_lessons: 'lessons are read from .opencastle/LESSONS-LEARNED.md by the agent itself',
  snippets: 'snippets were folded into skills',
}

export function validateSpec(spec: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['Spec must be a YAML object'], warnings }
  }

  const s = spec as RawSpec

  // Name
  if (!s.name || typeof s.name !== 'string') {
    errors.push('`name` is required and must be a string')
  }

  // Concurrency
  if (s.concurrency !== undefined) {
    if (s.concurrency === 'auto') {
      // valid swarm mode
    } else {
      const c = Number(s.concurrency)
      if (!Number.isInteger(c) || c < 1 || c > 50) {
        errors.push('`concurrency` must be an integer between 1 and 50, or "auto"')
      }
    }
  }

  // on_failure
  if (s.on_failure !== undefined) {
    if (!VALID_ON_FAILURE.includes(s.on_failure as string)) {
      errors.push(
        `\`on_failure\` must be one of: ${VALID_ON_FAILURE.join(', ')}`
      )
    }
  }

  // adapter
  if (s.adapter !== undefined && typeof s.adapter !== 'string') {
    errors.push('`adapter` must be a string')
  }

  // version
  if (s.version !== undefined) {
    if (typeof s.version !== 'number' || !Number.isInteger(s.version) || (s.version !== 1 && s.version !== 2)) {
      errors.push('`version` must be 1 or 2')
    }
  }

  // depends_on_convoy
  if (s.depends_on_convoy !== undefined) {
    if (
      !Array.isArray(s.depends_on_convoy) ||
      !(s.depends_on_convoy as unknown[]).every((c) => typeof c === 'string')
    ) {
      errors.push('`depends_on_convoy` must be an array of strings')
    }
  }

  // defaults
  if (s.defaults !== undefined) {
    if (!s.defaults || typeof s.defaults !== 'object' || Array.isArray(s.defaults)) {
      errors.push('`defaults` must be an object')
    } else {
      const d = s.defaults as Record<string, unknown>
      for (const [key, why] of Object.entries(RETIRED_DEFAULTS)) {
        if (d[key] !== undefined) warnings.push(`\`defaults.${key}\` is ignored — ${why}`)
      }
      if (d.timeout !== undefined && isNaN(parseTimeout(d.timeout as string))) {
        errors.push(
          '`defaults.timeout` must be in format: <number><s|m|h> (e.g. "10m")'
        )
      }
      if (d.model !== undefined && typeof d.model !== 'string') {
        errors.push('`defaults.model` must be a string')
      }
      if (d.max_retries !== undefined) {
        const mr = Number(d.max_retries)
        if (!Number.isInteger(mr) || mr < 0) {
          errors.push('`defaults.max_retries` must be a non-negative integer')
        }
      }
      if (d.agent !== undefined && typeof d.agent !== 'string') {
        errors.push('`defaults.agent` must be a string')
      }
      if (d.adapter !== undefined && typeof d.adapter !== 'string') {
        errors.push('`defaults.adapter` must be a string')
      }

      // MCP servers validation (Phase 19.7)
      if (d.mcp_servers !== undefined) {
        if (!Array.isArray(d.mcp_servers)) {
          errors.push('`defaults.mcp_servers` must be an array')
        } else {
          for (let j = 0; j < (d.mcp_servers as unknown[]).length; j++) {
            const server = (d.mcp_servers as unknown[])[j]
            const sp = `defaults.mcp_servers[${j}]`
            if (!server || typeof server !== 'object' || Array.isArray(server)) {
              errors.push(`\`${sp}\` must be an object`)
              continue
            }
            const srv = server as Record<string, unknown>
            if (!srv.name || typeof srv.name !== 'string') {
              errors.push(`\`${sp}.name\` is required and must be a string`)
            }
            if (!srv.type || typeof srv.type !== 'string') {
              errors.push(`\`${sp}.type\` is required and must be a string`)
            }
            if (srv.local !== undefined && typeof srv.local !== 'boolean') {
              errors.push(`\`${sp}.local\` must be a boolean`)
            }
            if (srv.command !== undefined && typeof srv.command !== 'string') {
              errors.push(`\`${sp}.command\` must be a string`)
            }
            if (srv.args !== undefined) {
              if (!Array.isArray(srv.args) || !(srv.args as unknown[]).every(a => typeof a === 'string')) {
                errors.push(`\`${sp}.args\` must be an array of strings`)
              }
            }
            if (srv.url !== undefined && typeof srv.url !== 'string') {
              errors.push(`\`${sp}.url\` must be a string`)
            }
            if (srv.config !== undefined) {
              if (!srv.config || typeof srv.config !== 'object' || Array.isArray(srv.config)) {
                errors.push(`\`${sp}.config\` must be an object`)
              }
            }
          }
        }
      }

      // mcp_approve_all validation
      if (d.mcp_approve_all !== undefined && typeof d.mcp_approve_all !== 'boolean') {
        errors.push('`defaults.mcp_approve_all` must be a boolean')
      }

      // mcp_server_approval_timeout validation
      if (d.mcp_server_approval_timeout !== undefined) {
        const t = Number(d.mcp_server_approval_timeout)
        if (!Number.isFinite(t) || t <= 0) {
          errors.push('`defaults.mcp_server_approval_timeout` must be a number greater than 0')
        }
      }

      // built_in_gates validation
      if (d.built_in_gates !== undefined) {
        if (!d.built_in_gates || typeof d.built_in_gates !== 'object' || Array.isArray(d.built_in_gates)) {
          errors.push('`defaults.built_in_gates` must be an object')
        } else {
          const bg = d.built_in_gates as Record<string, unknown>
          const boolOrAutoFields = ['secret_scan', 'blast_radius', 'dependency_audit', 'regression_test', 'browser_test'] as const
          // tdd_check can be boolean or object (TDDGateConfig)
          if (bg.tdd_check !== undefined && typeof bg.tdd_check !== 'boolean' && (typeof bg.tdd_check !== 'object' || Array.isArray(bg.tdd_check) || bg.tdd_check === null)) {
            errors.push('`defaults.built_in_gates.tdd_check` must be a boolean or an object')
          }
          for (const field of boolOrAutoFields) {
            if (bg[field] !== undefined && typeof bg[field] !== 'boolean' && bg[field] !== 'auto') {
              errors.push(`\`defaults.built_in_gates.${field}\` must be a boolean or "auto"`)
            }
          }
          if (bg.gate_timeout !== undefined) {
            const gt = Number(bg.gate_timeout)
            if (!Number.isFinite(gt) || gt <= 0) {
              errors.push('`defaults.built_in_gates.gate_timeout` must be a number greater than 0')
            }
          }
        }
      }

      // browser_test config validation
      if (d.browser_test !== undefined) {
        validateBrowserTestConfig(d.browser_test, 'defaults.browser_test', errors)
      }

      // review_stages validation (Phase 40 — two-stage review toggle)
      if (d.review_stages !== undefined && typeof d.review_stages !== 'boolean') {
        errors.push('`defaults.review_stages` must be a boolean')
      }

      // review validation
      const VALID_REVIEW = ['auto', 'fast', 'panel', 'none']
      if (d.review !== undefined && !VALID_REVIEW.includes(d.review as string)) {
        errors.push('`defaults.review` must be one of: ' + VALID_REVIEW.join(', '))
      }
      if (d.reviewer_model !== undefined && typeof d.reviewer_model !== 'string') {
        errors.push('`defaults.reviewer_model` must be a string')
      }
      if (d.review_budget !== undefined) {
        const rb = Number(d.review_budget)
        if (!Number.isInteger(rb) || rb < 1) {
          errors.push('`defaults.review_budget` must be a positive integer')
        }
      }
      const VALID_BUDGET_EXCEEDED = ['skip', 'downgrade', 'stop']
      if (
        d.on_review_budget_exceeded !== undefined &&
        !VALID_BUDGET_EXCEEDED.includes(d.on_review_budget_exceeded as string)
      ) {
        errors.push(
          '`defaults.on_review_budget_exceeded` must be one of: ' + VALID_BUDGET_EXCEEDED.join(', '),
        )
      }
      if (d.max_concurrent_reviews !== undefined) {
        const mcr = Number(d.max_concurrent_reviews)
        if (!Number.isInteger(mcr) || mcr < 1) {
          errors.push('`defaults.max_concurrent_reviews` must be a positive integer')
        }
      }
      if (d.review_heuristics !== undefined) {
        if (
          !d.review_heuristics ||
          typeof d.review_heuristics !== 'object' ||
          Array.isArray(d.review_heuristics)
        ) {
          errors.push('`defaults.review_heuristics` must be an object')
        } else {
          const rh = d.review_heuristics as Record<string, unknown>
          for (const field of ['panel_paths', 'panel_agents', 'auto_pass_agents'] as const) {
            if (rh[field] !== undefined) {
              if (
                !Array.isArray(rh[field]) ||
                !(rh[field] as unknown[]).every((v) => typeof v === 'string')
              ) {
                errors.push(
                  `\`defaults.review_heuristics.${field}\` must be an array of strings`,
                )
              }
            }
          }
          if (rh.auto_pass_max_lines !== undefined) {
            const apl = Number(rh.auto_pass_max_lines)
            if (!Number.isInteger(apl) || apl < 1) {
              errors.push('`defaults.review_heuristics.auto_pass_max_lines` must be a positive integer')
            }
          }
          if (rh.auto_pass_max_files !== undefined) {
            const apf = Number(rh.auto_pass_max_files)
            if (!Number.isInteger(apf) || apf < 1) {
              errors.push('`defaults.review_heuristics.auto_pass_max_files` must be a positive integer')
            }
          }
        }
      }
      if (d.max_swarm_concurrency !== undefined) {
        const msc = Number(d.max_swarm_concurrency)
        if (!Number.isInteger(msc) || msc < 1 || msc > 50) {
          errors.push('`defaults.max_swarm_concurrency` must be an integer between 1 and 50')
        }
      }
    }
  }

  // gates
  if (s.gates !== undefined) {
    if (
      !Array.isArray(s.gates) ||
      !(s.gates as unknown[]).every((g) => typeof g === 'string')
    ) {
      errors.push('`gates` must be an array of strings')
    }
  }

  // gate_retries
  if (s.gate_retries !== undefined) {
    const gr = Number(s.gate_retries)
    if (!Number.isInteger(gr) || gr < 0) {
      errors.push('`gate_retries` must be a non-negative integer')
    }
  }

  // branch
  if (s.branch !== undefined && typeof s.branch !== 'string') {
    errors.push('`branch` must be a string')
  }

  // guard config validation
  if (s.guard !== undefined) {
    const g = s.guard as Record<string, unknown>
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      errors.push('`guard` must be an object')
    } else {
      if (g.enabled !== undefined && typeof g.enabled !== 'boolean') {
        errors.push('`guard.enabled` must be a boolean')
      }
      if (g.agent !== undefined && typeof g.agent !== 'string') {
        errors.push('`guard.agent` must be a string')
      }
      if (g.checks !== undefined) {
        if (!Array.isArray(g.checks)) {
          errors.push('`guard.checks` must be an array of non-empty strings')
        } else if (!(g.checks as unknown[]).every((c) => typeof c === 'string' && c.length > 0)) {
          errors.push('`guard.checks` must be an array of non-empty strings')
        }
      }
    }
  }

  // Tasks: required unless this is a version:2 pipeline spec with depends_on_convoy
  const isPipeline =
    s.version === 2 &&
    Array.isArray(s.depends_on_convoy) &&
    (s.depends_on_convoy as unknown[]).length > 0

  if (!isPipeline) {
    if (!s.tasks || !Array.isArray(s.tasks) || s.tasks.length === 0) {
      errors.push('`tasks` is required and must be a non-empty array')
      return { valid: false, errors, warnings }
    }
  } else if (s.tasks !== undefined && (!Array.isArray(s.tasks) || s.tasks.length === 0)) {
    // Pipeline spec may omit tasks entirely, but if present they must be non-empty
    errors.push('`tasks`, when provided, must be a non-empty array')
    return { valid: false, errors, warnings }
  }

  // Skip per-task validation when pipeline spec has no tasks
  if (isPipeline && !s.tasks) {
    return { valid: errors.length === 0, errors, warnings }
  }

  const taskIds = new Set<string>()
  const tasks = s.tasks as RawTask[]

  for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]
      const prefix = `tasks[${i}]`

      if (!task || typeof task !== 'object') {
        errors.push(`${prefix}: must be an object`)
      continue
    }

    // id
    if (!task.id || typeof task.id !== 'string') {
      errors.push(`${prefix}: \`id\` is required and must be a string`)
    } else if (taskIds.has(task.id)) {
      errors.push(`${prefix}: duplicate task id "${task.id}"`)
    } else {
      taskIds.add(task.id)
    }

    // prompt
    if (!task.prompt || typeof task.prompt !== 'string') {
      errors.push(`${prefix}: \`prompt\` is required and must be a string`)
    }

    // timeout
    if (task.timeout !== undefined) {
      if (isNaN(parseTimeout(task.timeout as string))) {
        errors.push(
          `${prefix}: \`timeout\` must be in format: <number><s|m|h> (e.g. "10m")`
        )
      }
    }

    // depends_on
    if (task.depends_on !== undefined) {
      if (!Array.isArray(task.depends_on)) {
        errors.push(`${prefix}: \`depends_on\` must be an array`)
      } else {
        for (const dep of task.depends_on as string[]) {
          if (!taskIds.has(dep) && !tasks.some((t) => t && t.id === dep)) {
            errors.push(
              `${prefix}: \`depends_on\` references unknown task "${dep}"`
            )
          }
        }
      }
    }

    // files
    if (task.files !== undefined && !Array.isArray(task.files)) {
      errors.push(`${prefix}: \`files\` must be an array`)
    }

    // model
    if (task.model !== undefined && typeof task.model !== 'string') {
      errors.push(`${prefix}: \`model\` must be a string`)
    }

    // max_retries
    if (task.max_retries !== undefined) {
      const mr = Number(task.max_retries)
      if (!Number.isInteger(mr) || mr < 0) {
        errors.push(
          `${prefix}: \`max_retries\` must be a non-negative integer`
        )
      }
    }

    // adapter
    if (task.adapter !== undefined && typeof task.adapter !== 'string') {
      errors.push(`${prefix}: \`adapter\` must be a string`)
    }

    // built_in_gates (task-level)
    if (task.built_in_gates !== undefined) {
      if (!task.built_in_gates || typeof task.built_in_gates !== 'object' || Array.isArray(task.built_in_gates)) {
        errors.push(`${prefix}: \`built_in_gates\` must be an object`)
      } else {
        const bg = task.built_in_gates as Record<string, unknown>
        const boolOrAutoFields = ['secret_scan', 'blast_radius', 'dependency_audit', 'regression_test', 'browser_test'] as const
        for (const field of boolOrAutoFields) {
          if (bg[field] !== undefined && typeof bg[field] !== 'boolean' && bg[field] !== 'auto') {
            errors.push(`${prefix}: \`built_in_gates.${field}\` must be a boolean or "auto"`)
          }
        }
        if (bg.gate_timeout !== undefined) {
          const gt = Number(bg.gate_timeout)
          if (!Number.isFinite(gt) || gt <= 0) {
            errors.push(`${prefix}: \`built_in_gates.gate_timeout\` must be a number greater than 0`)
          }
        }
      }
    }

    // browser_test (task-level)
    if (task.browser_test !== undefined) {
      validateBrowserTestConfig(task.browser_test, `${prefix}.browser_test`, errors)
    }

    // review (task-level)
    if (task.review !== undefined) {
      const VALID_TASK_REVIEW = ['auto', 'fast', 'panel', 'none']
      if (!VALID_TASK_REVIEW.includes(task.review as string)) {
        errors.push(`${prefix}: \`review\` must be one of: ${VALID_TASK_REVIEW.join(', ')}`)
      }
    }
  }

  // DAG cycle detection
  if (errors.length === 0) {
    const cycleErr = detectCycles(tasks as Array<{ id: string; depends_on?: string[] }>)
    if (cycleErr) errors.push(cycleErr)
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Detect cycles in the task dependency graph using DFS.
 */
function detectCycles(tasks: Array<{ id: string; depends_on?: string[] }>): string | null {
  const adj = new Map<string, string[]>()
  for (const t of tasks) {
    adj.set(t.id, t.depends_on || [])
  }

  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const id of adj.keys()) color.set(id, WHITE)

  function dfs(node: string, path: string[]): string[] | null {
    color.set(node, GRAY)
    path.push(node)

    for (const dep of adj.get(node) || []) {
      if (color.get(dep) === GRAY) {
        const cycleStart = path.indexOf(dep)
        return [...path.slice(cycleStart), dep]
      }
      if (color.get(dep) === WHITE) {
        const result = dfs(dep, path)
        if (result) return result
      }
    }

    color.set(node, BLACK)
    path.pop()
    return null
  }

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE) {
      const cycle = dfs(id, [])
      if (cycle) {
        return `Circular dependency detected: ${cycle.join(' → ')}`
      }
    }
  }
  return null
}

/**
 * Apply default values to a parsed spec.
 */
export function applyDefaults(spec: Record<string, unknown>): TaskSpec {
  const s = spec as Record<string, unknown>
  s.concurrency = s.concurrency === 'auto' ? 'auto' : (s.concurrency !== undefined ? Number(s.concurrency) : 1)
  s.on_failure = (s.on_failure as string) || 'continue'
  // Leave adapter empty so run.ts can auto-detect the best available CLI
  s.adapter = (s.adapter as string) || ''
  s.gate_retries = s.gate_retries !== undefined ? Number(s.gate_retries) : 0

  const tasks = (s.tasks as Array<Record<string, unknown>> | undefined) ?? []
  const d =
    s.version === 1 && s.defaults
      ? (s.defaults as Record<string, unknown>)
      : {}
  for (const task of tasks) {
    task.agent =
      (task.agent as string) || (d.agent as string | undefined) || 'developer'
    task.timeout =
      (task.timeout as string) ||
      (d.timeout as string | undefined) ||
      '30m'
    task.depends_on = (task.depends_on as string[]) || []
    task.files = (task.files as string[]) || []
    task.description = (task.description as string) || (task.id as string)
    // model: task-level overrides defaults (no hardcoded fallback)
    if (task.model === undefined && d.model !== undefined) {
      task.model = d.model
    }
    // max_retries: task-level overrides defaults, fallback to 1
    if (task.max_retries === undefined) {
      task.max_retries =
        d.max_retries !== undefined ? Number(d.max_retries) : 1
    }
    // adapter: task-level overrides defaults, no hardcoded fallback (convoy-level is used at runtime)
    if (task.adapter === undefined && d.adapter !== undefined) {
      task.adapter = d.adapter
    }
    // review: task-level overrides defaults
    if (task.review === undefined && d.review !== undefined) {
      task.review = d.review
    }
  }

  return s as unknown as TaskSpec
}

/**
 * Returns true if the spec uses the Convoy Engine enhanced format (version: 1 or 2).
 */
export function isConvoySpec(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object') return false
  const v = (spec as Record<string, unknown>).version
  return v === 1 || v === 2
}

/**
 * Returns true if the spec is a pipeline spec (version: 2 + non-empty depends_on_convoy).
 */
export function isPipelineSpec(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object') return false
  const s = spec as Record<string, unknown>
  return (
    s.version === 2 &&
    Array.isArray(s.depends_on_convoy) &&
    (s.depends_on_convoy as unknown[]).length > 0
  )
}

/**
 * Parse, validate, and return a typed task spec from a YAML string.
 * @throws If the text is empty, cannot be parsed, or spec is invalid
 */
export function parseTaskSpecText(text: string): TaskSpec {
  if (!text.trim()) {
    throw new Error('Task spec file is empty')
  }

  let spec: Record<string, unknown>
  try {
    spec = parseYaml(text)
  } catch (err: unknown) {
    throw new Error(`YAML parse error: ${(err as Error).message}`)
  }

  const { valid, errors, warnings } = validateSpec(spec)
  if (!valid) {
    throw new Error(`Invalid task spec:\n  • ${errors.join('\n  • ')}`)
  }
  for (const warning of warnings ?? []) {
    console.warn(`  ⚠ ${warning}`)
  }

  return applyDefaults(spec)
}

/**
 * Read, parse, validate, and return a typed task spec from a YAML file.
 * @throws If file cannot be read, parsed, or spec is invalid
 */
export async function parseTaskSpec(filePath: string): Promise<TaskSpec> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (err: unknown) {
    const e = err as Error & { code?: string }
    if (e.code === 'ENOENT') {
      throw new Error(`Task spec file not found: ${filePath}`)
    }
    throw new Error(`Cannot read task spec file: ${e.message}`)
  }

  return parseTaskSpecText(text)
}
