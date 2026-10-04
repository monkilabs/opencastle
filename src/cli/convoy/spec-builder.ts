import { stringify } from 'yaml'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEffortProfile } from './effort-scaling.js'
import { normalizePath, pathsOverlap } from './partition.js'
import { parseYaml, validateSpec } from '../run/schema.js'

/**
 * The planner's task plan, and the spec built from it.
 *
 * The LLM decides only what it is good at: the tasks, their prompts, who does
 * them, what they touch and what waits for what. Everything that decides how
 * the run behaves — branch, runtime, concurrency, failure policy, the checks —
 * is set here from facts the code can read, so a generated spec is safe and
 * fast without anyone editing it.
 */

/** One task as the planner writes it. */
export interface TaskPlanTask {
  id: string
  agent?: string
  description?: string
  files?: string[]
  depends_on?: string[]
  timeout?: string
  max_retries?: number
  review?: string
  complexity?: 1 | 2 | 3 | 5 | 8 | 13
  prompt: string
}

/** The planner's whole answer. */
export interface TaskPlan {
  name: string
  tasks: TaskPlanTask[]
}

/** A patch to apply to a task plan — output of the convoy-plan-fix prompt */
export interface TaskPatch {
  task_id: string   // task ID to patch, or "_plan" for top-level fields
  field: string     // field name (e.g., "prompt", "files", "depends_on")
  value: unknown    // new value for the field
}

/** What the code, not the planner, decides about a run. */
export interface SpecSettings {
  /** The runtime that planned it; run, resume and retry stay on it. */
  adapter: string
  /** Where the work lands. Never the user's checkout. */
  branch: string
  /** Project checks, run once after every task is merged. */
  gates: string[]
}

/** More agents at once than this costs more in rate limits and machine load than it saves. */
export const MAX_PLANNED_CONCURRENCY = 4

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── Project checks ──────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function readPackageJson(projectRoot: string): Record<string, unknown> | null {
  const path = join(projectRoot, 'package.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * The package manager a project uses: its `packageManager` field (what
 * corepack honours), else its lockfile, else npm.
 */
export function detectPackageManager(projectRoot: string): PackageManager {
  const declared = readPackageJson(projectRoot)?.packageManager
  if (typeof declared === 'string') {
    const name = declared.split('@')[0]
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  }
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(projectRoot, 'bun.lockb')) || existsSync(join(projectRoot, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** Cheapest first, so a type error fails the run before the test suite starts. */
const GATE_SCRIPTS = [['typecheck', 'type-check'], ['lint'], ['test'], ['build']]

/**
 * The project's own checks, from its package.json scripts.
 *
 * They run once, after every task has merged, which is the only point at which
 * they test the combined result. The planner used to choose gates itself and
 * the spec builder added a per-task `npm test` once a plan passed five tasks:
 * the whole suite, once per task, mostly against the same code.
 */
export function detectGates(projectRoot: string): string[] {
  const scripts = readPackageJson(projectRoot)?.scripts
  if (!scripts || typeof scripts !== 'object') return []
  const pm = detectPackageManager(projectRoot)
  const gates: string[] = []
  for (const names of GATE_SCRIPTS) {
    const name = names.find((n) => typeof (scripts as Record<string, unknown>)[n] === 'string')
    if (!name) continue
    const body = (scripts as Record<string, string>)[name]
    // `npm init` writes a test script that always fails, and a watcher never
    // exits; either would fail or hang every run.
    if (/no test specified/.test(body) || /--watch\b/.test(body)) continue
    gates.push(`${pm} run ${name}`)
  }
  return gates
}

// ── Building the spec ───────────────────────────────────────────────────────

/** Topological levels: a task's level is one more than its deepest dependency's. */
function levels(plan: TaskPlan): Map<string, number> {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const memo = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    const known = memo.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0 // a cycle; checkPlan reports it
    seen.add(id)
    const deps = (byId.get(id)?.depends_on ?? []).filter((d) => byId.has(d))
    const level = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, seen))) : 0
    memo.set(id, level)
    return level
  }
  for (const t of plan.tasks) visit(t.id, new Set())
  return memo
}

/**
 * How many tasks to run at once: the widest level of the plan, capped.
 *
 * A fixed 2 left wide plans waiting and gave a straight chain a slot it could
 * never use.
 */
export function planConcurrency(plan: TaskPlan): number {
  const width = new Map<number, number>()
  for (const level of levels(plan).values()) width.set(level, (width.get(level) ?? 0) + 1)
  const widest = Math.max(1, ...width.values())
  return Math.min(widest, MAX_PLANNED_CONCURRENCY)
}

/**
 * Converts a TaskPlan into convoy YAML.
 *
 * Defaults that changed, and why:
 * - `branch: convoy/<slug>`. Without one the engine merged into whatever was
 *   checked out, and resume of a branchless run crashed.
 * - `on_failure: continue`. `stop` switched off every per-task retry and still
 *   let the rest of the wave run; with `continue` a failure blocks only what
 *   depends on it, and resume picks it up.
 * - `adapter`, so a resumed run cannot land on a different runtime.
 * - No `detect_drift`, and no built-in gates: drift asked a fresh session with
 *   no memory to grade work it never saw and re-ran tasks on its guess, and the
 *   built-in gates either repeated the full suite per task or read a diff that
 *   was not committed yet.
 * - `gate_retries: 1` when there are gates: one agent attempt to fix a failing
 *   check on the merged result, rather than a finished run reported red over a
 *   lint error.
 */
export function buildConvoyYaml(plan: TaskPlan, settings: SpecSettings): string {
  const tasks = plan.tasks.map((task) => {
    const t: Record<string, unknown> = {}
    t.id = task.id
    t.agent = task.agent ?? 'developer'
    t.description = task.description ?? task.id
    if (task.timeout !== undefined) t.timeout = task.timeout
    if (task.files && task.files.length > 0) t.files = task.files
    if (task.depends_on && task.depends_on.length > 0) t.depends_on = task.depends_on
    if (task.max_retries !== undefined) t.max_retries = task.max_retries
    if (task.review !== undefined) t.review = task.review
    // The effort table fills in what the planner left out, from its complexity score.
    if (task.complexity !== undefined) {
      const profile = getEffortProfile(task.complexity)
      if (t.timeout === undefined) t.timeout = profile.timeout
      if (t.max_retries === undefined) t.max_retries = profile.max_retries
      if (t.review === undefined) t.review = profile.review
    }
    // prompt last — keeps the long text at the end of each task block
    t.prompt = task.prompt
    return t
  })

  const spec: Record<string, unknown> = {
    name: plan.name,
    version: 1,
    adapter: settings.adapter,
    branch: settings.branch,
    concurrency: planConcurrency(plan),
    on_failure: 'continue',
  }
  if (settings.gates.length > 0) {
    spec.gates = settings.gates
    spec.gate_retries = 1
  }
  spec.defaults = { timeout: '30m', max_retries: 1, review: 'fast' }
  spec.tasks = tasks

  const header =
    '# Written by `npx opencastle convoy`. Edit it if you like, then run it with:\n' +
    '#   npx opencastle convoy run <this file>\n'
  return header + stringify(spec, { lineWidth: 120, defaultKeyType: 'PLAIN', defaultStringType: 'PLAIN' })
}

// ── Files ───────────────────────────────────────────────────────────────────

function isGlob(path: string): boolean {
  return path.includes('*') || path.includes('?')
}

/**
 * Every `files` entry as a concrete path or directory.
 *
 * The engine refuses a glob, and refused it only after the run had been
 * recorded. A glob is reduced to the directory in front of its first wildcard
 * (`src/**\/*.ts` → `src/`), which claims at least what the glob did. One with
 * no directory in front (`*.md`) would claim the whole project, so it is
 * dropped and reported instead.
 */
export function normalizePlanFiles(plan: TaskPlan): { plan: TaskPlan; notes: string[] } {
  const notes: string[] = []
  const tasks = plan.tasks.map((task) => {
    if (!task.files?.length) return task
    const files: string[] = []
    for (const raw of task.files) {
      let path = raw.trim()
      if (isGlob(path)) {
        const segments = path.replace(/\\/g, '/').split('/')
        const fixed = segments.slice(0, segments.findIndex(isGlob))
        if (fixed.length === 0 || fixed.every((s) => s === '' || s === '.')) {
          notes.push(`${task.id}: dropped "${raw}" — a pattern at the project root would claim everything`)
          continue
        }
        path = fixed.join('/') + '/'
        notes.push(`${task.id}: "${raw}" → "${path}"`)
      }
      if (path && !files.includes(path)) files.push(path)
    }
    return { ...task, files }
  })
  return { plan: { ...plan, tasks }, notes }
}

/** For each task, every task it waits for, directly or not. */
function ancestors(plan: TaskPlan): Map<string, Set<string>> {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const memo = new Map<string, Set<string>>()
  const visit = (id: string, path: Set<string>): Set<string> => {
    const known = memo.get(id)
    if (known) return known
    const out = new Set<string>()
    if (path.has(id)) return out // a cycle; checkPlan reports it
    path.add(id)
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue
      out.add(dep)
      for (const a of visit(dep, path)) out.add(a)
    }
    path.delete(id)
    memo.set(id, out)
    return out
  }
  for (const t of plan.tasks) visit(t.id, new Set())
  return memo
}

interface Conflict {
  first: string
  second: string
  paths: string[]
}

/**
 * Pairs of tasks that may run at the same time and claim the same files.
 *
 * "At the same time" means neither waits for the other, directly or through
 * others. That is stricter than the engine's check, which compares tasks
 * phase by phase, and it is the right one for a scheduler that starts a task
 * the moment its dependencies finish: two tasks in different phases can still
 * overlap in time. Compared case-insensitively too, because the spec may run
 * on macOS or Windows.
 */
function conflicts(plan: TaskPlan): Conflict[] {
  const before = ancestors(plan)
  const normalized = new Map<string, string[]>()
  for (const t of plan.tasks) {
    const paths: string[] = []
    for (const f of t.files ?? []) {
      try {
        paths.push(normalizePath(f))
      } catch {
        // Reported by checkPlan.
      }
    }
    normalized.set(t.id, paths)
  }
  const found: Conflict[] = []
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]
      const b = plan.tasks[j]
      if (before.get(a.id)?.has(b.id) || before.get(b.id)?.has(a.id)) continue
      const paths: string[] = []
      for (const pa of normalized.get(a.id) ?? []) {
        for (const pb of normalized.get(b.id) ?? []) {
          if (pathsOverlap(pa, pb) || pathsOverlap(pa.toLowerCase(), pb.toLowerCase())) {
            if (!paths.includes(pa)) paths.push(pa)
          }
        }
      }
      if (paths.length) found.push({ first: a.id, second: b.id, paths })
    }
  }
  return found
}

/**
 * Everything the code can check about a plan before an agent runs it.
 *
 * The schema the runner applies, plus the two rules the engine enforces only
 * once the run has started: no globs, and no two concurrent tasks on the same
 * files. An empty list means the engine will accept the spec.
 */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/

/**
 * Fold a task that only writes tests for one other task into that task.
 *
 * Planners split work into "write the code" and "test the code" even when told
 * not to: three real runs did it every time. Each split is another session,
 * review and merge, and the agent that wrote the code never runs a test against
 * it. A task folds in when every file it owns is a test file, it depends on
 * exactly one task, nothing else claims its files, and that task is not itself
 * test-only. Tasks that waited on it wait on the merged task instead.
 */
export function foldTestOnlyTasks(plan: TaskPlan): { plan: TaskPlan; folded: Array<[string, string]> } {
  const byId = new Map(plan.tasks.map((t) => [t.id, { ...t, files: [...(t.files ?? [])], depends_on: [...(t.depends_on ?? [])] }]))
  const isTestOnly = (t: TaskPlanTask): boolean => (t.files ?? []).length > 0 && (t.files ?? []).every((f) => TEST_PATH.test(f))
  const folded: Array<[string, string]> = []
  // A dependency another dependency already waits on adds nothing: tests that
  // list both a store change and the routes built on it test the routes.
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (!seen.has(d)) {
        seen.add(d)
        ancestors(d, seen)
      }
    }
    return seen
  }
  const direct = (deps: string[]): string[] => deps.filter((d) => !deps.some((o) => o !== d && ancestors(o).has(d)))
  for (const task of plan.tasks) {
    const t = byId.get(task.id)
    if (!t || !isTestOnly(t)) continue
    const deps = direct(t.depends_on)
    if (deps.length !== 1) continue
    const target = byId.get(deps[0])
    if (!target || isTestOnly(target)) continue
    const claimedElsewhere = [...byId.values()].some(
      (o) => o.id !== t.id && o.id !== target.id && (o.files ?? []).some((f) => t.files.includes(f)),
    )
    if (claimedElsewhere) continue
    target.files = [...new Set([...(target.files ?? []), ...t.files])]
    target.prompt = `${target.prompt.trimEnd()}\n\nIn the same session, write the tests for this change:\n${t.prompt.trim()}`
    byId.delete(t.id)
    for (const other of byId.values()) {
      if (other.depends_on.includes(t.id)) {
        other.depends_on = [...new Set(other.depends_on.map((d) => (d === t.id ? target.id : d)))].filter((d) => d !== other.id)
      }
    }
    folded.push([t.id, target.id])
  }
  return { plan: { ...plan, tasks: plan.tasks.filter((t) => byId.has(t.id)).map((t) => byId.get(t.id)!) }, folded }
}

export function checkPlan(plan: TaskPlan, settings: SpecSettings): string[] {
  const problems: string[] = []

  const shape = planShapeProblem(plan as unknown as Record<string, unknown>)
  if (shape) {
    problems.push(`Plan: ${shape}`)
  } else {
    try {
      const { valid, errors } = validateSpec(parseYaml(buildConvoyYaml(plan, settings)))
      if (!valid) problems.push(...errors.map((e) => `Schema: ${e}`))
    } catch (err) {
      problems.push(`Schema: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const task of plan.tasks) {
    for (const f of task.files ?? []) {
      if (isGlob(f)) {
        problems.push(`Task "${task.id}": files entry "${f}" is a pattern — name a file or a directory`)
        continue
      }
      if (/^([A-Za-z]:)?[\\/]/.test(f)) {
        problems.push(`Task "${task.id}": files entry "${f}" must be relative to the project root`)
        continue
      }
      try {
        normalizePath(f)
      } catch (err) {
        problems.push(`Task "${task.id}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  for (const c of conflicts(plan)) {
    problems.push(
      `Tasks "${c.first}" and "${c.second}" can run at the same time but both claim ${c.paths.join(', ')}` +
        ` — give each its own files, or make one depend on the other`,
    )
  }
  return problems
}

/**
 * Make the later of each conflicting pair wait for the earlier.
 *
 * The last resort, after convoy-plan-fix has had its rounds: it costs parallelism,
 * never correctness, and it cannot create a cycle — an edge is only added
 * between two tasks that do not yet wait for each other in either direction.
 */
export function sequenceConflicts(plan: TaskPlan): { plan: TaskPlan; added: Array<[string, string]> } {
  let current: TaskPlan = structuredClone(plan)
  const added: Array<[string, string]> = []
  for (;;) {
    const [next] = conflicts(current)
    if (!next) break
    current = {
      ...current,
      tasks: current.tasks.map((t) =>
        t.id === next.second ? { ...t, depends_on: [...(t.depends_on ?? []), next.first] } : t,
      ),
    }
    added.push([next.second, next.first])
  }
  return { plan: current, added }
}

// ── Joining group plans ─────────────────────────────────────────────────────

export interface GroupPlan {
  name: string
  depends_on: string[]
  plan: TaskPlan
}

/**
 * One plan from the plans written for each group of a large feature.
 *
 * Groups used to become a chain of separate specs run one after another, even
 * when the assessment said two of them were independent. Here a group's first
 * tasks wait for the last tasks of every group it depends on, and nothing else
 * is added: independent groups run side by side under the normal scheduler,
 * and the user gets one spec, one plan to read and one run to resume.
 *
 * Two groups can both name a task `setup`. The later one is renamed
 * `<group>-setup`, with its group's references to it.
 *
 * `groups` must come in dependency order (topologicalSortGroups).
 */
export function mergeGroupPlans(name: string, groups: GroupPlan[]): TaskPlan {
  const taken = new Set<string>()
  const sinks = new Map<string, string[]>()
  const tasks: TaskPlanTask[] = []

  for (const group of groups) {
    const rename = new Map<string, string>()
    for (const t of group.plan.tasks) {
      let id = t.id
      if (taken.has(id)) {
        id = `${group.name}-${t.id}`
        for (let n = 2; taken.has(id); n++) id = `${group.name}-${t.id}-${n}`
      }
      taken.add(id)
      rename.set(t.id, id)
    }

    const upstream = group.depends_on.flatMap((g) => sinks.get(g) ?? [])
    const dependedOn = new Set(group.plan.tasks.flatMap((t) => t.depends_on ?? []))
    for (const t of group.plan.tasks) {
      const own = (t.depends_on ?? []).map((d) => rename.get(d) ?? d)
      // A copy each: a shared array would come out of the YAML writer as an anchor.
      const depends_on = own.length > 0 ? own : [...upstream]
      tasks.push({ ...t, id: rename.get(t.id)!, depends_on })
    }
    sinks.set(
      group.name,
      group.plan.tasks.filter((t) => !dependedOn.has(t.id)).map((t) => rename.get(t.id)!),
    )
  }

  return { name, tasks }
}

// ── Patches and parsing ─────────────────────────────────────────────────────

/**
 * Applies an array of patches to a task plan. Returns a new TaskPlan (immutable).
 */
export function applyPatches(plan: TaskPlan, patches: TaskPatch[]): TaskPlan {
  const clone = structuredClone(plan)
  let skipped = 0
  for (const patch of patches) {
    if (patch.task_id === '_plan') {
      ;(clone as unknown as Record<string, unknown>)[patch.field] = patch.value
    } else {
      const task = clone.tasks.find((t) => t.id === patch.task_id)
      if (task) {
        ;(task as unknown as Record<string, unknown>)[patch.field] = patch.value
      } else {
        console.warn(`  ⚠ applyPatches: patch targets unknown task "${patch.task_id}" — skipping`)
        skipped++
      }
    }
  }
  if (skipped > 0) {
    console.warn(`  ⚠ applyPatches: ${skipped} of ${patches.length} patches skipped (unknown task IDs)`)
  }
  return clone
}

/**
 * Detects whether a JSON string appears to be truncated (output cut off mid-generation).
 * Returns a descriptive reason string, or null if the JSON looks complete.
 */
function detectJsonTruncation(jsonText: string): string | null {
  const trimmed = jsonText.trim()
  if (!trimmed) return 'empty output'

  let braces = 0
  let brackets = 0
  let inString = false
  let prevChar = ''
  for (const ch of trimmed) {
    if (ch === '"' && prevChar !== '\\') {
      inString = !inString
    } else if (!inString) {
      if (ch === '{') braces++
      else if (ch === '}') braces--
      else if (ch === '[') brackets++
      else if (ch === ']') brackets--
    }
    prevChar = ch
  }

  if (braces > 0 || brackets > 0) {
    return `output truncated (${braces} unclosed braces, ${brackets} unclosed brackets) — the LLM likely hit its output token limit`
  }

  return null
}

/**
 * Result of parsing a task plan JSON. Contains either a valid plan or a diagnostic reason.
 */
export interface ParseTaskPlanResult {
  plan: TaskPlan | null
  reason?: string
}

/**
 * Parses a JSON string into a TaskPlan. Returns null if parsing fails or required fields are missing.
 */
export function parseTaskPlan(jsonText: string): TaskPlan | null {
  return parseTaskPlanWithReason(jsonText).plan
}

/**
 * Like parseTaskPlan but returns a diagnostic reason on failure, for the caller
 * to report.
 */
export function parseTaskPlanWithReason(jsonText: string): ParseTaskPlanResult {
  const truncation = detectJsonTruncation(jsonText)
  if (truncation) return { plan: null, reason: truncation }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonText.trim()) as Record<string, unknown>
  } catch (err) {
    return { plan: null, reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const problem = planShapeProblem(parsed)
  if (problem) return { plan: null, reason: problem }
  return { plan: parsed as unknown as TaskPlan }
}

/**
 * What makes an object not a task plan, or null: a name, a non-empty task list,
 * unique ids, a prompt each, dependencies that exist, and no cycle.
 */
function planShapeProblem(parsed: Record<string, unknown> | null): string | null {
  if (!parsed || typeof parsed.name !== 'string') {
    return `missing or invalid top-level "name" field (got ${typeof parsed?.name})`
  }
  if (!Array.isArray(parsed.tasks) || (parsed.tasks as unknown[]).length === 0) {
    return `missing or empty "tasks" array`
  }
  const tasks = parsed.tasks as Array<Record<string, unknown>>
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]
    if (!t || typeof t !== 'object') return `task[${i}] is not an object`
    if (typeof t.id !== 'string') return `task[${i}] missing "id" field`
    if (typeof t.prompt !== 'string') {
      return `task "${t.id}" missing "prompt" field (has keys: ${Object.keys(t).join(', ')})`
    }
    if (t.prompt.length === 0) return `task "${t.id}" has empty "prompt" field`
  }

  const ids = new Set<string>()
  const duplicates: string[] = []
  for (const task of tasks) {
    const id = task.id as string
    if (ids.has(id)) duplicates.push(id)
    ids.add(id)
  }
  if (duplicates.length > 0) return `duplicate task IDs: ${duplicates.join(', ')}`

  for (const task of tasks) {
    if (task.depends_on !== undefined && !Array.isArray(task.depends_on)) {
      return `task "${task.id as string}" has a depends_on that is not a list`
    }
    for (const dep of (task.depends_on as string[] | undefined) ?? []) {
      if (!ids.has(dep)) return `task "${task.id as string}" depends on unknown task "${dep}"`
    }
  }

  // Cycle detection (Kahn's algorithm)
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of ids) {
    inDegree.set(id, 0)
    adj.set(id, [])
  }
  for (const task of tasks) {
    for (const dep of (task.depends_on as string[] | undefined) ?? []) {
      adj.get(dep)!.push(task.id as string)
      inDegree.set(task.id as string, (inDegree.get(task.id as string) ?? 0) + 1)
    }
  }
  const queue = [...ids].filter(id => inDegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()!
    visited++
    for (const next of adj.get(node) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }
  if (visited < ids.size) return 'dependency cycle detected'
  return null
}

/**
 * Parses a JSON string into a TaskPatch[]. Returns null if parsing fails.
 */
export function parsePatches(jsonText: string): TaskPatch[] | null {
  try {
    const parsed = JSON.parse(jsonText.trim())
    if (!Array.isArray(parsed)) return null
    for (const item of parsed as unknown[]) {
      const p = item as Record<string, unknown>
      if (typeof p.task_id !== 'string' || typeof p.field !== 'string' || p.value === undefined) {
        return null
      }
    }
    return parsed as TaskPatch[]
  } catch {
    return null
  }
}
