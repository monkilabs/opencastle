import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Task, TaskSpec, AgentAdapter, ExecuteResult, ExecuteOptions } from './spec-types.js'
import { createConvoyStore, ConvoyArtifactLimitError, type ConvoyStore } from './store.js'
import { acquireEngineLock } from './lock.js'
import { createEventEmitter, ndjsonPathForConvoy, recoverNdjson, type ConvoyEventEmitter } from './events.js'
import {
  createWorktreeManager,
  ensureRootWorktree,
  removeRootWorktree,
  mainRepoRoot,
  currentRef,
  listAllWorktrees,
  worktreesDirFor,
  workerBranchName,
  commitAllIn,
  git,
  BranchInUseError,
  type WorktreeManager,
} from './worktree.js'
import { createMergeQueue, MergeConflictError, type MergeQueue } from './merge.js'
import type {
  TaskRecord, ConvoyStatus, ConvoyTaskStatus, GuardConfig, CircuitBreakerConfig, TaskStep, Hook,
  TaskOutput, TaskInput, TDDGateConfig,
} from './types.js'
import { parseTimeout } from '../run/schema.js'
import { getAdapter } from '../run/adapters/index.js'
import { supportsPermissionMode } from '../run/adapters/permission-modes.js'
import { runShell } from '../run/platform.js'
import { c } from '../prompt.js'
import { tierForAgent } from '../tiers.js'
import { validateFilePartitions, scanSymlinks, scanNewSymlinks, normalizePath, pathsOverlap } from './partition.js'
import {
  scanForSecrets,
  runSecretScanGate,
  runBlastRadiusGate,
  runDependencyAuditGate,
  runRegressionTestGate,
  browserTestGate,
  noOpGate,
} from './gates.js'
import { validateOutput, buildContractInstruction } from './contracts.js'
import {
  defaultReviewer,
  evaluateReviewLevel,
  countChangedLines,
  type DiffStats,
  type ReviewLevel,
  type ReviewResult,
  type ReviewRunner,
  type ReviewContext,
} from './reviewer.js'
import {
  buildSharedContext,
  buildTaskSection,
  composePrompt,
  resolveDependencyResults,
  detectPartitionViolations,
  summarizeTask,
} from './isolation.js'
import { checkTDD, formatTDDFailure, DEFAULT_TDD_CONFIG } from './tdd-gate.js'
import { extractArtifactRefs } from './artifacts.js'
import { calculateCost } from './pricing.js'
import { buildPhases, formatDuration, pickStartable, taskFiles } from './schedule.js'
import { createProgress, firstLine, formatCost, formatTokens, type Progress, type ProgressStream } from './progress.js'
import { redactSecrets } from './redact.js'

export { evaluateReviewLevel }
export type { DiffStats, ReviewLevel, ReviewResult }

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ConvoyEngineOptions {
  spec: TaskSpec
  specYaml: string
  /** The run's agent runtime. A task's own `adapter:` overrides it; `auto` means this one. */
  adapter: AgentAdapter
  basePath?: string
  dbPath?: string
  logsDir?: string
  verbose?: boolean
  pipelineId?: string
  /** Where `.opencastle/` logs and ledgers go. Defaults to the main checkout of `basePath`'s repository. */
  repoRoot?: string
  /** Aborting it stops the run the way Ctrl+C does. */
  signal?: AbortSignal
  /** Stop the run on SIGINT/SIGTERM (default true). */
  handleSignals?: boolean
  /** Where progress is printed (default stdout). */
  output?: ProgressStream
  _worktreeManager?: WorktreeManager
  _mergeQueue?: MergeQueue
  /** Present for older tests: when set, `basePath` is used as the integration checkout. */
  _ensureBranch?: (branchName: string, basePath: string) => Promise<void>
  /**
   * The checkout merges land in.
   * - omitted: the engine creates (or reuses) a worktree of the convoy branch;
   * - a path: that directory, already on the convoy branch;
   * - null: `basePath` itself, already on the branch — tests, and the pipeline,
   *   which manages its own.
   */
  _convoyWorktreeDir?: string | null
  /** Replaces the default reviewer (tests). */
  _reviewRunner?: ReviewRunner
}

export interface ConvoyResult {
  convoyId: string
  status: ConvoyStatus
  summary: { total: number; done: number; failed: number; skipped: number; timedOut: number }
  duration: string
  gateResults?: Array<{ command: string; exitCode: number; passed: boolean; output?: string }>
  cost?: { total_tokens: number; total_cost_usd?: number; estimated?: boolean }
  /** What the caller should exit with: 0 done, 1 failed, 130 interrupted. */
  exitCode?: number
  /** The branch the work landed on. */
  branch?: string
  /** What the branch was cut from. */
  baseRef?: string | null
  /** The convoy's NDJSON event log. */
  logPath?: string
  /** Worker branches kept because their work could not be merged. */
  keptBranches?: Array<{ taskId: string; branch: string }>
}

export interface ConvoyEngine {
  run(): Promise<ConvoyResult>
  resume(convoyId: string): Promise<ConvoyResult>
  /** Reopen failed and skipped tasks; `resume` does this itself, so this is only for callers that preview. */
  retryFailed(convoyId: string, taskIds?: string[]): Promise<void>
  injectTask(convoyId: string, task: {
    id: string
    prompt: string
    agent: string
    phase: number
    timeout_ms?: number
    depends_on?: string[]
    files?: string[]
    max_retries?: number
    provenance?: string
    idempotency_key?: string
    on_exhausted?: 'dlq' | 'skip' | 'stop'
  }): TaskRecord
}

// ── Circuit Breaker ────────────────────────────────────────────────────────────

export interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half-open'
  failures: number
  last_failure_at: string | null
  opened_at: string | null
}

export class CircuitBreakerManager {
  private states: Map<string, CircuitBreakerState> = new Map()
  private threshold: number
  private cooldownMs: number
  private fallbackAgent: string | null

  constructor(config?: CircuitBreakerConfig, initialState?: Record<string, CircuitBreakerState>) {
    this.threshold = config?.threshold ?? 3
    this.cooldownMs = config?.cooldown_ms ?? 300_000
    this.fallbackAgent = config?.fallback_agent ?? null

    if (initialState) {
      for (const [agent, state] of Object.entries(initialState)) {
        this.states.set(agent, state)
      }
    }
  }

  getState(agent: string): CircuitBreakerState {
    return this.states.get(agent) ?? { status: 'closed', failures: 0, last_failure_at: null, opened_at: null }
  }

  recordFailure(agent: string): { tripped: boolean; state: CircuitBreakerState } {
    const state = this.getState(agent)
    const now = new Date().toISOString()

    if (state.status === 'half-open') {
      // Probe failed — back to open, reset cooldown
      state.status = 'open'
      state.opened_at = now
      state.last_failure_at = now
      this.states.set(agent, state)
      return { tripped: true, state }
    }

    state.failures += 1
    state.last_failure_at = now

    if (state.failures >= this.threshold) {
      state.status = 'open'
      state.opened_at = now
      this.states.set(agent, state)
      return { tripped: true, state }
    }

    this.states.set(agent, state)
    return { tripped: false, state }
  }

  recordSuccess(agent: string): CircuitBreakerState {
    const state = this.getState(agent)

    if (state.status === 'half-open') {
      // Probe succeeded — close circuit
      state.status = 'closed'
      state.failures = 0
      state.opened_at = null
    } else if (state.status === 'closed') {
      state.failures = 0
    }

    this.states.set(agent, state)
    return state
  }

  canAssign(agent: string): boolean {
    const state = this.getState(agent)

    if (state.status === 'closed') return true
    if (state.status === 'half-open') return true // allow 1 probe

    // Open — check cooldown
    if (state.opened_at) {
      const elapsed = Date.now() - new Date(state.opened_at).getTime()
      if (elapsed >= this.cooldownMs) {
        state.status = 'half-open'
        this.states.set(agent, state)
        return true
      }
    }

    return false
  }

  get fallback(): string | null {
    return this.fallbackAgent
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.states))
  }
}

// ── Convoy guard ──────────────────────────────────────────────────────────────

export interface ConvoyGuardResult {
  passed: boolean
  warnings: string[]
}

const TERMINAL_TASK_STATUSES = new Set([
  'done', 'failed', 'skipped', 'timed-out', 'gate-failed', 'review-blocked', 'hook-failed', 'disputed',
])

export function runConvoyGuard(
  store: ConvoyStore,
  convoyId: string,
  _wtManager: WorktreeManager,
  ndjsonPath: string,
  guardConfig?: GuardConfig,
): ConvoyGuardResult {
  if (guardConfig?.enabled === false) {
    return { passed: true, warnings: [] }
  }

  const warnings: string[] = []
  const tasks = store.getTasksByConvoy(convoyId)

  const nonTerminal = tasks.filter(t => !TERMINAL_TASK_STATUSES.has(t.status))
  if (nonTerminal.length > 0) {
    warnings.push(
      `Non-terminal tasks: ${nonTerminal.map(t => `${t.id}(${t.status})`).join(', ')}`,
    )
  }

  const completedTasks = tasks.filter(t => t.status === 'done')
  try {
    const content = readFileSync(ndjsonPath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim())
    if (lines.length < completedTasks.length) {
      warnings.push(
        `NDJSON record count (${lines.length}) < completed tasks (${completedTasks.length})`,
      )
    }
  } catch {
    if (completedTasks.length > 0) {
      warnings.push(
        `NDJSON file not found at ${ndjsonPath} but ${completedTasks.length} tasks completed`,
      )
    }
  }

  const retriedTasks = tasks.filter(t => t.retries > 0)
  const events = store.getEvents(convoyId)
  for (const task of retriedTasks) {
    const taskEvents = events.filter(e => e.task_id === task.id && e.type === 'task_started')
    if (taskEvents.length < task.retries) {
      warnings.push(
        `Task ${task.id} has ${task.retries} retries but only ${taskEvents.length} task_started events`,
      )
    }
  }

  const convoy = store.getConvoy(convoyId)
  if (convoy && convoy.total_tokens == null) {
    const totalTokens = tasks.reduce((sum, t) => sum + (t.total_tokens ?? 0), 0)
    if (totalTokens > 0) {
      warnings.push('Convoy total_tokens not persisted despite tasks having token data')
    }
  }

  return { passed: warnings.length === 0, warnings }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

class Semaphore {
  private current = 0
  private queue: Array<() => void> = []
  constructor(private max: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current >= this.max) {
      await new Promise<void>(res => this.queue.push(res))
    }
    this.current++
    try {
      return await fn()
    } finally {
      this.current--
      this.queue.shift()?.()
    }
  }
}

function msToTimeout(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.max(1, Math.round(ms / 1_000))}s`
}

function parseJsonList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function slugify(text: string, max: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
}

/** Six characters that name a convoy's worktrees, derived from its id so resume finds them. */
export function shortConvoyId(convoyId: string): string {
  return createHash('sha1').update(convoyId).digest('hex').slice(0, 6)
}

/** `convoy/<name>-<short id>`: the branch a run works on when its spec names none. */
export function defaultBranchName(specName: string, convoyId: string): string {
  return `convoy/${slugify(specName, 40) || 'run'}-${shortConvoyId(convoyId)}`
}

/** Every task status `resume` turns back into pending. Skipped counts: it was skipped because something failed. */
export const RESUME_RESET_STATUSES: readonly ConvoyTaskStatus[] = [
  'failed', 'timed-out', 'gate-failed', 'review-blocked', 'disputed', 'hook-failed',
  'running', 'assigned', 'skipped', 'wait-for-input',
]

/** Statuses whose reset gives the task its retry budget back. Interrupted tasks keep theirs. */
const FAILED_STATUSES = new Set<string>(['failed', 'timed-out', 'gate-failed', 'review-blocked', 'disputed', 'hook-failed'])

// ── DLQ and dispute ledgers ───────────────────────────────────────────────────

function buildDlqMarkdownEntry(
  dlqId: string,
  task: TaskRecord,
  failureType: string,
  errorOutput: string | null,
): { marker: string; entry: string } {
  const marker = `<!-- dlq:${dlqId} -->`
  const entry = `\n${marker}\n### ${dlqId}\n\n| Field | Value |\n|-------|-------|\n| Task | ${task.id} |\n| Agent | ${task.agent} |\n| Type | ${failureType} |\n| Attempts | ${task.retries + 1} |\n| Date | ${new Date().toISOString()} |\n\n**Error:**\n\`\`\`\n${(errorOutput ?? '(no output)').slice(0, 2000)}\n\`\`\`\n`
  return { marker, entry }
}

function appendLedger(repoRoot: string, file: string, marker: string, entry: string): void {
  const mdPath = join(resolve(repoRoot), '.opencastle', file)
  try {
    if (readFileSync(mdPath, 'utf8').includes(marker)) return
  } catch {
    // File doesn't exist yet — will create
  }
  mkdirSync(dirname(mdPath), { recursive: true })
  appendFileSync(mdPath, entry)
}

/**
 * Marks a convoy 'failed' after an unexpected throw escapes runConvoy, so a
 * crash does not leave the row reading 'running'. Best-effort.
 */
function markConvoyCrashed(
  store: ConvoyStore,
  events: ConvoyEventEmitter | null,
  convoyId: string,
  err: unknown,
): void {
  const reason = err instanceof Error ? err.message : String(err)
  try {
    store.updateConvoyStatus(convoyId, 'failed', { finished_at: new Date().toISOString() })
  } catch { /* store may already be closed — the throw we are handling matters more */ }
  try {
    events?.emit('convoy_failed', { status: 'failed', reason: `engine crashed: ${reason}` }, { convoy_id: convoyId })
  } catch { /* ditto */ }
}

function taskRecordToTask(record: TaskRecord): Task {
  return {
    id: record.id,
    prompt: record.prompt,
    agent: record.agent,
    timeout: msToTimeout(record.timeout_ms),
    depends_on: parseJsonList(record.depends_on),
    files: parseJsonList(record.files),
    description: '',
    model: record.model ?? undefined,
    max_retries: record.max_retries,
    adapter: record.adapter ?? undefined,
    gates: record.gates ? parseJsonList(record.gates) : undefined,
  }
}

function evaluateStepCondition(
  condition: TaskStep['if'],
  stepResults: Map<string, { exitCode: number }>,
  worktreePath: string,
): boolean {
  if (!condition) return true

  if (condition.exitCode) {
    const prevResult = stepResults.get(condition.step)
    if (!prevResult) return false
    const code = prevResult.exitCode
    const ec = condition.exitCode
    if (ec.eq !== undefined && code !== ec.eq) return false
    if (ec.ne !== undefined && code === ec.ne) return false
    if (ec.gt !== undefined && !(code > ec.gt)) return false
    if (ec.lt !== undefined && !(code < ec.lt)) return false
  }

  if (condition.fileExists) {
    // Absolute paths and `..` are refused on either separator; the check used
    // to test for a leading '/' only, which never matched on Windows.
    const raw = condition.fileExists.path
    if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\')) return false
    let rel: string
    try {
      rel = normalizePath(raw)
    } catch {
      return false
    }
    if (!existsSync(join(worktreePath, rel))) return false
  }

  return true
}

// ── Usage accounting ──────────────────────────────────────────────────────────

interface Usage {
  /** Null when the runtime reported a total but not this part. */
  prompt: number | null
  completion: number | null
  total: number
  cacheRead: number | null
  cacheWrite: number | null
  cost: number | null
  estimated: boolean
  model: string | null
}

/** Add `b` to `a`, keeping null when neither side knows. */
function addNullable(a: number | null | undefined, b: number | null): number | null {
  if (b == null) return a ?? null
  return (a ?? 0) + b
}

/**
 * What one agent session spent, as the runtime reported it.
 *
 * When it reported nothing the tokens are estimated from the text (4 characters
 * a token) and flagged. Cost is the runtime's own figure; failing that, a price
 * for the *model* it says it used, flagged as an estimate. It is never priced
 * by the adapter's name — "claude" is not a model, and pricing it as Sonnet
 * produced figures that looked measured and were not.
 */
function usageOf(result: ExecuteResult, promptText: string, fallbackModel: string | null): Usage {
  const u = result.usage
  const reported = u != null && (u.prompt_tokens != null || u.completion_tokens != null || u.total_tokens != null)
  const prompt = reported ? (u!.prompt_tokens ?? null) : Math.ceil(promptText.length / 4)
  const completion = reported ? (u!.completion_tokens ?? null) : Math.ceil((result.output ?? '').length / 4)
  const total = reported ? (u!.total_tokens ?? (prompt ?? 0) + (completion ?? 0)) : (prompt ?? 0) + (completion ?? 0)
  const model = result.model ?? fallbackModel ?? null
  let cost: number | null = null
  let costEstimated = false
  if (result.costUsd != null) {
    cost = result.costUsd
  } else {
    cost = calculateCost(model, prompt, completion)
    costEstimated = true
  }
  return {
    prompt,
    completion,
    total,
    cacheRead: reported ? (u!.cache_read_tokens ?? null) : null,
    cacheWrite: reported ? (u!.cache_write_tokens ?? null) : null,
    cost,
    estimated: !reported || costEstimated,
    model,
  }
}

// ── Run control ───────────────────────────────────────────────────────────────

interface RunControl {
  /** No new task starts: a task failed under `on_failure: stop`, or a stop rule fired. */
  stopDispatch: boolean
  /** Set by SIGINT/SIGTERM or the abort signal. */
  interrupted: string | null
  /** Resolves when the run is interrupted, so waits can be cut short. */
  interruptedPromise: Promise<void>
  interrupt(reason: string): void
  /** Kill hooks for every agent session in flight. */
  onInterrupt: Array<() => void>
}

function createRunControl(): RunControl {
  let resolveInterrupt: () => void = () => {}
  const ctl: RunControl = {
    stopDispatch: false,
    interrupted: null,
    interruptedPromise: new Promise<void>(r => { resolveInterrupt = r }),
    onInterrupt: [],
    interrupt(reason: string) {
      if (ctl.interrupted) return
      ctl.interrupted = reason
      ctl.stopDispatch = true
      for (const fn of ctl.onInterrupt) {
        try { fn() } catch { /* best effort */ }
      }
      resolveInterrupt()
    },
  }
  return ctl
}

/** How long an interrupted run waits for its tasks to wind down before it lets go of them. */
const INTERRUPT_GRACE_MS = 10_000

interface RunContext {
  convoyId: string
  spec: TaskSpec
  adapter: AgentAdapter
  store: ConvoyStore
  events: ConvoyEventEmitter
  wtManager: WorktreeManager
  mergeQueue: MergeQueue
  /** The main checkout: logs, ledgers, artifacts. */
  repoRoot: string
  /** The checkout merges land in, on `branch`. */
  workRoot: string
  branch: string
  baseRef: string | null
  verbose: boolean
  startTime: number
  ndjsonPath: string
  reviewRunner: ReviewRunner
  progress: Progress
  ctl: RunControl
}

// ── Core convoy execution ─────────────────────────────────────────────────────

async function runConvoy(ctx: RunContext): Promise<ConvoyResult> {
  const {
    convoyId, spec, adapter, store, events, wtManager, mergeQueue, repoRoot, workRoot, branch,
    verbose, ndjsonPath, reviewRunner, progress, ctl,
  } = ctx
  const startTime = ctx.startTime
  const short = shortConvoyId(convoyId)
  const specTasks = new Map((spec.tasks ?? []).map(t => [t.id, t]))
  const reviewSemaphore = new Semaphore(spec.defaults?.max_concurrent_reviews ?? 3)
  const adapterCache = new Map<string, Promise<AgentAdapter>>()
  const conflictReruns = new Set<string>()
  const running = new Map<string, Promise<void>>()
  // Worker ids must be unique even when a retry starts in the same millisecond.
  let workerSeq = Date.now()
  const permissionMode = spec.defaults?.permission_mode
  let reviewTokensTotal = store.getConvoy(convoyId)?.review_tokens_total ?? 0
  let extraTokens = 0
  let extraCost = 0
  let extraEstimated = false

  // ── Circuit breaker ────────────────────────────────────────────────────────
  const circuitBreakerConfig = spec.defaults?.circuit_breaker
  const convoyRecord = store.getConvoy(convoyId)
  const initialCircuitState = convoyRecord?.circuit_state ? JSON.parse(convoyRecord.circuit_state) : undefined
  const circuitBreaker = new CircuitBreakerManager(circuitBreakerConfig, initialCircuitState)

  // ── Trust model ────────────────────────────────────────────────────────────
  // Gate, hook and step commands in a spec are operator-controlled build
  // configuration, like a Makefile or package.json scripts. They run through
  // the platform shell and must not carry user-supplied input; the spec file is
  // the trust boundary.

  // ── Shared prompt context, built once so it is identical for every task ───
  const sharedContext = buildSharedContext({
    convoyName: spec.name,
    plan: (spec.tasks ?? []).map(t => ({
      id: t.id,
      agent: t.agent,
      summary: summarizeTask(t),
      files: t.files ?? [],
      depends_on: t.depends_on ?? [],
    })),
    artifactsDir: join(repoRoot, '.opencastle', 'artifacts', convoyId) + '/',
  })

  // ── Agent sessions, tracked so Ctrl+C can stop them ───────────────────────

  const live = new Map<Task, { adapter: AgentAdapter; taskId: string }>()
  ctl.onInterrupt.push(() => {
    for (const [task, { adapter: a, taskId }] of live) {
      try { a.kill?.(task) } catch { /* already gone */ }
      events.emit('worker_killed', { reason: 'interrupted', task_id: taskId }, { convoy_id: convoyId, task_id: taskId })
    }
  })

  /**
   * One agent session with a deadline. On timeout the session is killed
   * through the adapter and the result says so; nothing waits on a process
   * that will not end.
   */
  async function runAgent(
    taskId: string,
    agentAdapter: AgentAdapter,
    task: Task,
    options: ExecuteOptions,
    timeoutMs: number,
  ): Promise<ExecuteResult> {
    if (ctl.interrupted) return { success: false, output: 'Interrupted before it started', exitCode: 130 }
    live.set(task, { adapter: agentAdapter, taskId })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<ExecuteResult>(res => {
      timer = setTimeout(() => {
        try { agentAdapter.kill?.(task) } catch { /* already gone */ }
        res({ _timedOut: true, success: false, output: `Timed out after ${formatDuration(timeoutMs)}`, exitCode: -1 })
      }, Math.max(1, timeoutMs))
    })
    const interrupted = ctl.interruptedPromise.then(
      (): ExecuteResult => ({ success: false, output: 'Interrupted', exitCode: 130 }),
    )
    try {
      const execution = agentAdapter.execute(task, { verbose, ...options }).catch(
        (err: unknown): ExecuteResult => ({ success: false, output: (err as Error).message, exitCode: -1 }),
      )
      return await Promise.race([execution, timedOut, interrupted])
    } finally {
      if (timer) clearTimeout(timer)
      live.delete(task)
    }
  }

  // ── Usage bookkeeping ──────────────────────────────────────────────────────

  /** Add one session's spend to the task row; attempts and steps accumulate. */
  function addTaskUsage(taskId: string, usage: Usage): void {
    const row = store.getTask(taskId, convoyId)
    if (!row) return
    const cost = usage.cost == null && row.cost_usd == null
      ? null
      : (row.cost_usd ?? 0) + (usage.cost ?? 0)
    store.updateTaskStatus(taskId, convoyId, row.status, {
      prompt_tokens: addNullable(row.prompt_tokens, usage.prompt),
      completion_tokens: addNullable(row.completion_tokens, usage.completion),
      total_tokens: (row.total_tokens ?? 0) + usage.total,
      cache_read_tokens: addNullable(row.cache_read_tokens, usage.cacheRead),
      cache_write_tokens: addNullable(row.cache_write_tokens, usage.cacheWrite),
      cost_usd: cost,
      cost_estimated: (row.cost_estimated ?? 0) || usage.estimated || usage.cost == null ? 1 : 0,
      model: usage.model ?? row.model,
    })
  }

  // ── Adapters ───────────────────────────────────────────────────────────────

  /**
   * A task's runtime. No `adapter:`, `auto`, or the run's own name means the
   * run's adapter; `auto` used to re-run detection for every task and could
   * land on a different runtime than the one the user chose.
   */
  function adapterFor(name: string | null): Promise<AgentAdapter> {
    if (!name || name === 'auto' || name === adapter.name) return Promise.resolve(adapter)
    let pending = adapterCache.get(name)
    if (!pending) {
      pending = getAdapter(name)
      adapterCache.set(name, pending)
    }
    return pending
  }

  // ── Task skipping and failure cascade ──────────────────────────────────────

  function skipTask(taskId: string, reason: string, visited: Set<string> = new Set()): void {
    if (visited.has(taskId)) return
    visited.add(taskId)
    const allTasks = store.getTasksByConvoy(convoyId)
    const task = allTasks.find(t => t.id === taskId)
    if (!task || task.status !== 'pending') return
    store.updateTaskStatus(taskId, convoyId, 'skipped', { output: reason })
    progress.line(`  ${c.dim('⊘')} ${c.bold(`[${taskId}]`)} skipped: ${reason}`)
    events.emit('task_skipped', { reason }, { convoy_id: convoyId, task_id: taskId })
    for (const t of allTasks) {
      if (parseJsonList(t.depends_on).includes(taskId)) {
        skipTask(t.id, `dependency "${taskId}" did not finish`, visited)
      }
    }
  }

  function cascadeFailure(failedTaskId: string): void {
    for (const t of store.getTasksByConvoy(convoyId)) {
      if (parseJsonList(t.depends_on).includes(failedTaskId)) {
        skipTask(t.id, `dependency "${failedTaskId}" failed`)
      }
    }
  }

  /** Dispatch nothing new; tasks already running finish. */
  function stopDispatching(reason: string): void {
    if (ctl.stopDispatch) return
    ctl.stopDispatch = true
    progress.line(`  ${c.yellow('■')} ${reason} — no new tasks will start; running tasks finish`)
  }

  function handleExhaustion(taskRecord: TaskRecord, failureType: string, errorOutput: string | null): void {
    const exhausted = taskRecord.on_exhausted ?? 'dlq'

    if (exhausted === 'dlq' || exhausted === 'stop') {
      const dlqId = `dlq-${taskRecord.id}-${Date.now()}`
      // Masked, then written to both the table and the ledger. Holding back
      // both on any finding used to lose the failure record altogether; now
      // only an entry that still flags after masking is held back — both
      // halves, so the table and the ledger never disagree.
      const masked = errorOutput == null ? null : redactSecrets(errorOutput)
      const clean = masked?.text ?? null
      if (masked && masked.patterns.length > 0) {
        events.emit('secret_leak_prevented', {
          task_id: taskRecord.id,
          findings_count: masked.patterns.length,
          patterns: [...new Set(masked.patterns)],
          context: 'dlq_redacted',
        }, { convoy_id: convoyId, task_id: taskRecord.id })
      }
      const { marker, entry } = buildDlqMarkdownEntry(dlqId, taskRecord, failureType, clean)
      const leak = scanForSecrets(entry, 'AGENT-FAILURES.md')
      if (!leak.clean) {
        events.emit('secret_leak_prevented', {
          task_id: taskRecord.id,
          findings_count: leak.findings.length,
          patterns: leak.findings.map(f => f.pattern),
          context: 'dlq_dual_write',
        }, { convoy_id: convoyId, task_id: taskRecord.id })
      } else {
        store.insertDlqEntry({
          id: dlqId,
          convoy_id: convoyId,
          task_id: taskRecord.id,
          agent: taskRecord.agent,
          failure_type: failureType,
          error_output: clean,
          attempts: taskRecord.retries + 1,
          tokens_spent: taskRecord.total_tokens,
          escalation_task_id: null,
          resolved: 0,
          resolution: null,
          created_at: new Date().toISOString(),
          resolved_at: null,
        })
        appendLedger(repoRoot, 'AGENT-FAILURES.md', marker, entry)
        events.emit('dlq_entry_created', {
          dlq_id: dlqId,
          task_id: taskRecord.id,
          agent: taskRecord.agent,
          attempts: taskRecord.retries + 1,
        }, { convoy_id: convoyId, task_id: taskRecord.id })
      }
    }

    if (exhausted === 'stop') {
      stopDispatching(`on_exhausted: stop — task "${taskRecord.id}" exhausted retries`)
    }
    cascadeFailure(taskRecord.id)

    if (circuitBreakerConfig) {
      const { tripped } = circuitBreaker.recordFailure(taskRecord.agent)
      try { store.updateConvoyCircuitState(convoyId, circuitBreaker.serialize()) } catch { /* non-critical */ }
      if (tripped) {
        events.emit('circuit_breaker_tripped', {
          agent: taskRecord.agent,
          failure_count: circuitBreaker.getState(taskRecord.agent).failures,
        }, { convoy_id: convoyId, task_id: taskRecord.id })
      }
    }
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  async function runHooks(
    hooks: Hook[],
    lifecycle: 'pre_task' | 'post_task' | 'post_convoy',
    context: { taskId?: string; cwd: string; taskAdapter?: AgentAdapter },
  ): Promise<{ passed: boolean; failedHook?: Hook; error?: string }> {
    const filtered = hooks.filter(h => (h.on ?? 'post_task') === lifecycle)
    for (const hook of filtered) {
      if (hook.type === 'command' || hook.type === 'guard' || hook.type === 'validate') {
        if (!hook.command) continue
        const r = await runShell(hook.command, { cwd: context.cwd, timeoutMs: 600_000 })
        if (r.code !== 0) {
          return { passed: false, failedHook: hook, error: (r.stderr || r.stdout).trim() || `exit ${r.code}` }
        }
      } else if (hook.type === 'agent') {
        if (!hook.prompt) continue
        const hookTask: Task = {
          id: `hook-${lifecycle}-${context.taskId ?? 'convoy'}`,
          prompt: hook.prompt,
          agent: hook.name ?? 'developer',
          timeout: '10m',
          depends_on: [],
          files: [],
          description: `Hook: ${hook.name ?? hook.type}`,
          max_retries: 0,
        }
        const hookResult = await runAgent(context.taskId ?? convoyId, context.taskAdapter ?? adapter, hookTask, {
          cwd: context.cwd,
          permissionMode,
        }, 600_000)
        if (!hookResult.success) {
          return { passed: false, failedHook: hook, error: hookResult.output }
        }
      } else if (hook.type === 'review') {
        if (!context.taskId) continue
        const rec = store.getTask(context.taskId, convoyId)
        if (rec) {
          const r = await reviewRunner(rec, 'fast', spec.defaults?.reviewer_model ?? 'default')
          if (r.verdict === 'block') {
            return { passed: false, failedHook: hook, error: r.feedback }
          }
        }
      }
    }
    return { passed: true }
  }

  // ── Multi-step tasks ───────────────────────────────────────────────────────

  async function executeSteps(
    rec: TaskRecord,
    steps: TaskStep[],
    taskAdapter: AgentAdapter,
    worktreePath: string,
    deadline: number,
    baseOptions: ExecuteOptions,
    /** Wraps a step's text in the shared context and the task's role and files. */
    wrap: (stepPrompt: string) => string,
  ): Promise<ExecuteResult> {
    const now = () => new Date().toISOString()
    const stepResults = new Map<string, { exitCode: number }>()
    let combinedOutput = ''
    let lastExitCode = 0

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]

      if (step.if && !evaluateStepCondition(step.if, stepResults, worktreePath)) {
        store.insertTaskStep({
          task_id: rec.id,
          step_index: i,
          prompt: step.prompt,
          gates: step.gates ? JSON.stringify(step.gates) : null,
          status: 'skipped',
          exit_code: null,
          output: 'Skipped: condition not met',
          started_at: now(),
          finished_at: now(),
        })
        if (step.id) stepResults.set(step.id, { exitCode: 0 })
        combinedOutput += `\n[Step ${i + 1} skipped: condition not met]`
        continue
      }

      const stepDbId = store.insertTaskStep({
        task_id: rec.id,
        step_index: i,
        prompt: step.prompt,
        gates: step.gates ? JSON.stringify(step.gates) : null,
        status: 'running',
        exit_code: null,
        output: null,
        started_at: now(),
        finished_at: null,
      })

      const stepMaxRetries = step.max_retries ?? rec.max_retries
      let stepResult: ExecuteResult = { success: false, output: '', exitCode: -1 }
      let stepAttempt = 0

      while (stepAttempt <= stepMaxRetries) {
        let stepPrompt = step.prompt
        if (stepAttempt > 0) {
          stepPrompt = `Previous attempt failed.\nExit code: ${stepResult.exitCode}\nError output:\n${stepResult.output || '(no output)'}\n\nFix the issues and try again.\n\n` + step.prompt
        }
        stepPrompt = wrap(stepPrompt)
        // Each step is its own Task object; it is what the adapter attaches
        // the process to, so it is what a kill has to name.
        const remaining = deadline - Date.now()
        const stepTask: Task = {
          id: rec.id,
          prompt: stepPrompt,
          agent: rec.agent,
          timeout: msToTimeout(Math.max(1000, remaining)),
          depends_on: [],
          files: parseJsonList(rec.files),
          description: `step ${i + 1}`,
          max_retries: stepMaxRetries,
        }
        stepResult = await runAgent(rec.id, taskAdapter, stepTask, baseOptions, remaining)
        addTaskUsage(rec.id, usageOf(stepResult, stepPrompt, rec.model))
        // A step that timed out or was killed is not retried: the task's time
        // is spent, or someone asked it to stop.
        if (stepResult.success || stepResult._timedOut || ctl.interrupted || Date.now() >= deadline) break
        stepAttempt++
        if (stepAttempt <= stepMaxRetries) {
          progress.line(`  ${c.yellow('↺')} ${c.bold(`[${rec.id}]`)} step ${i + 1}/${steps.length} failed, retry ${stepAttempt}/${stepMaxRetries}`)
        }
      }

      lastExitCode = stepResult.exitCode
      combinedOutput += `\n[Step ${i + 1}]\n${stepResult.output}`
      if (step.id) stepResults.set(step.id, { exitCode: stepResult.exitCode })

      if (step.gates && step.gates.length > 0 && stepResult.success) {
        for (const command of step.gates) {
          const r = await runShell(command, { cwd: worktreePath, timeoutMs: Math.max(1000, deadline - Date.now()) })
          if (r.code !== 0) {
            const output = (r.stderr || r.stdout).trim()
            stepResult = { success: false, output: `Gate failed: ${command}\nExit code: ${r.code}\n${output}`, exitCode: r.code }
            lastExitCode = r.code
            combinedOutput += `\n[Step ${i + 1} gate failed: ${command}]`
            break
          }
        }
      }

      store.updateTaskStep(stepDbId, {
        status: stepResult.success ? 'done' : 'failed',
        exit_code: stepResult.exitCode,
        output: redactSecrets(stepResult.output).text,
        finished_at: now(),
      })

      if (!stepResult.success) {
        return { ...stepResult, output: combinedOutput.trim() }
      }
    }

    return { success: true, output: combinedOutput.trim(), exitCode: lastExitCode }
  }

  // ── One task, start to merge ───────────────────────────────────────────────

  const statusLabel: Record<string, string> = {
    'failed': 'failed',
    'timed-out': 'timed out',
    'gate-failed': 'gate failed',
    'review-blocked': 'review blocked',
    'hook-failed': 'hook failed',
  }

  async function runTask(initial: TaskRecord): Promise<void> {
    // Re-read: the snapshot this was picked from can be stale by now.
    const rec = store.getTask(initial.id, convoyId)
    if (!rec || rec.status !== 'pending' || ctl.stopDispatch) return

    const now = () => new Date().toISOString()
    const taskStart = Date.now()
    const specTask = specTasks.get(rec.id)
    const files = parseJsonList(rec.files)
    const attempt = rec.retries + 1
    const elapsed = () => `(${formatDuration(Date.now() - taskStart)})`
    let workerId: string | null = null
    let worktreePath: string | null = null

    const cleanup = async (keepBranch = false): Promise<void> => {
      if (!worktreePath) return
      try { await wtManager.remove(worktreePath, keepBranch ? { keepBranch: true } : undefined) } catch { /* best effort */ }
      worktreePath = null
    }

    const telemetry = (outcome: 'success' | 'failed', retries: number, filesChanged = 0): void => {
      const row = store.getTask(rec.id, convoyId)
      const model = row?.model ?? null
      events.emit('session', {
        agent: rec.agent,
        model,
        task: rec.id,
        outcome,
        duration_min: Math.round((Date.now() - taskStart) / 60_000),
        files_changed: filesChanged,
        retries,
        convoy_id: convoyId,
      }, { convoy_id: convoyId, task_id: rec.id })
      events.emit('delegation', {
        session_id: convoyId,
        agent: rec.agent,
        model,
        tier: tierForAgent(rec.agent),
        mechanism: 'convoy',
        outcome,
        retries,
        phase: rec.phase,
        convoy_id: convoyId,
      }, { convoy_id: convoyId, task_id: rec.id })
    }

    /** Put an interrupted task back in the queue, as if it had not started. */
    const requeue = async (): Promise<void> => {
      await cleanup()
      store.updateTaskStatus(rec.id, convoyId, 'pending', { worker_id: null, worktree: null, started_at: null })
      if (workerId) store.updateWorkerStatus(workerId, 'killed', { finished_at: now() })
    }

    /** Record a task as failed for good, and everything that follows from it. */
    const fail = async (
      status: ConvoyTaskStatus,
      reason: string,
      opts: { kind?: string; output?: string; exitCode?: number; gate?: string; hook?: string; keepBranch?: string; failureType?: string } = {},
    ): Promise<void> => {
      await cleanup(Boolean(opts.keepBranch))
      const fresh = store.getTask(rec.id, convoyId) ?? rec
      store.withTransaction(() => {
        store.updateTaskStatus(rec.id, convoyId, status, {
          finished_at: now(),
          output: redactSecrets(opts.output ?? reason).text,
          exit_code: opts.exitCode ?? 1,
          ...(opts.keepBranch ? { branch: opts.keepBranch } : {}),
        })
        if (workerId) store.updateWorkerStatus(workerId, 'failed', { finished_at: now() })
      })
      const label = statusLabel[status] ?? status
      progress.line(`  ${c.red('✗')} ${c.bold(`[${rec.id}]`)} ${label} ${elapsed()}: ${firstLine(redactSecrets(reason).text)}`)
      events.emit('task_failed', {
        reason: opts.kind ?? status,
        message: firstLine(reason, 400),
        ...(opts.gate ? { gate: opts.gate } : {}),
        ...(opts.hook ? { hook: opts.hook } : {}),
        ...(opts.exitCode !== undefined ? { exit_code: opts.exitCode } : {}),
        ...(workerId ? { worker_id: workerId } : {}),
      }, { convoy_id: convoyId, task_id: rec.id, ...(workerId ? { worker_id: workerId } : {}) })
      telemetry('failed', fresh.retries)
      handleExhaustion(fresh, opts.failureType ?? opts.kind ?? status, opts.output ?? reason)
      if (spec.on_failure === 'stop') stopDispatching(`on_failure: stop — task "${rec.id}" failed`)
    }

    /**
     * Retry when the task has retries left, whatever `on_failure` says — that
     * setting is about what happens *after* a task has failed for good. They
     * were tangled: every retry site checked `on_failure !== 'stop'`, and the
     * spec builder's default `stop` turned off every retry in every plan.
     */
    const retryOrFail = async (
      status: ConvoyTaskStatus,
      reason: string,
      opts: { kind?: string; note?: string; output?: string; exitCode?: number; gate?: string; failureType?: string; noRetry?: boolean } = {},
    ): Promise<void> => {
      if (ctl.interrupted) return requeue()
      const fresh = store.getTask(rec.id, convoyId) ?? rec
      if (!opts.noRetry && fresh.retries < fresh.max_retries) {
        await cleanup()
        store.updateTaskStatus(rec.id, convoyId, 'pending', {
          retries: fresh.retries + 1,
          worker_id: null,
          worktree: null,
          started_at: null,
          finished_at: null,
          retry_note: redactSecrets(opts.note ?? reason).text,
        })
        if (workerId) store.updateWorkerStatus(workerId, 'failed', { finished_at: now() })
        const label = statusLabel[status] ?? status
        progress.line(
          `  ${c.yellow('⟳')} ${c.bold(`[${rec.id}]`)} ${label}, retry ${fresh.retries + 1}/${fresh.max_retries}: ${firstLine(redactSecrets(reason).text)}`,
        )
        events.emit('task_retried', {
          previous_status: status,
          reason: firstLine(reason, 400),
          attempt: fresh.retries + 2,
        }, { convoy_id: convoyId, task_id: rec.id })
        return
      }
      return fail(status, reason, opts)
    }

    // ── Runtime ─────────────────────────────────────────────────────────────
    let taskAdapter: AgentAdapter
    try {
      taskAdapter = await adapterFor(rec.adapter)
    } catch (err) {
      return fail('failed', `No usable runtime "${rec.adapter}": ${(err as Error).message}`, { kind: 'adapter' })
    }

    // ── Circuit breaker ─────────────────────────────────────────────────────
    if (circuitBreakerConfig && !circuitBreaker.canAssign(rec.agent)) {
      const fallback = circuitBreaker.fallback
      if (fallback) {
        events.emit('circuit_breaker_fallback', {
          original_agent: rec.agent,
          fallback_agent: fallback,
          task_id: rec.id,
        }, { convoy_id: convoyId, task_id: rec.id })
      } else {
        events.emit('circuit_breaker_blocked', { agent: rec.agent, task_id: rec.id }, { convoy_id: convoyId, task_id: rec.id })
      }
      const reason = `Circuit breaker open for agent "${rec.agent}"`
      store.updateTaskStatus(rec.id, convoyId, 'skipped', { output: reason })
      progress.line(`  ${c.dim('⊘')} ${c.bold(`[${rec.id}]`)} skipped: ${reason}`)
      events.emit('task_skipped', { reason }, { convoy_id: convoyId, task_id: rec.id })
      cascadeFailure(rec.id)
      return
    }

    // ── Inputs ──────────────────────────────────────────────────────────────
    const inputs: TaskInput[] = rec.inputs ? JSON.parse(rec.inputs) as TaskInput[] : []
    for (const input of inputs) {
      if (!store.getArtifact(convoyId, input.name)) {
        return fail('failed', `Input "${input.name}" from task "${input.from}" was never produced`, { kind: 'missing-input' })
      }
    }

    // ── Worktree ────────────────────────────────────────────────────────────
    workerId = `${short}-${slugify(rec.id, 24) || 'task'}-${(workerSeq++).toString(36).slice(-5)}`
    store.updateTaskStatus(rec.id, convoyId, 'assigned', { worker_id: workerId })
    try {
      worktreePath = await wtManager.create(workerId, branch)
    } catch (err) {
      return retryOrFail('failed', `Could not create a worktree: ${firstLine((err as { stderr?: string }).stderr) || (err as Error).message}`, { kind: 'worktree' })
    }
    const wt: string = worktreePath
    const startSha = wtManager.head ? await wtManager.head(wt) : null

    store.insertWorker({
      id: workerId,
      task_id: rec.id,
      adapter: taskAdapter.name,
      pid: null,
      session_id: null,
      status: 'running',
      worktree: wt,
      created_at: now(),
    })
    store.updateTaskStatus(rec.id, convoyId, 'running', { started_at: now(), worktree: wt, worker_id: workerId })

    const runtime = taskAdapter.name !== adapter.name ? ` ${c.dim(`(${taskAdapter.name})`)}` : ''
    const attemptNote = attempt > 1 ? c.dim(` attempt ${attempt}/${rec.max_retries + 1}`) : ''
    progress.line(`  ${c.cyan('▶')} ${c.bold(`[${rec.id}]`)} ${rec.agent}${runtime}${attemptNote}`)
    events.emit('task_started', {
      worker_id: workerId,
      mechanism: 'worktree',
      adapter: taskAdapter.name,
      attempt,
    }, { convoy_id: convoyId, task_id: rec.id, worker_id: workerId })

    // ── Prompt ──────────────────────────────────────────────────────────────
    let instructions = rec.prompt
    for (const input of inputs) {
      const artifact = store.getArtifact(convoyId, input.name)!
      instructions = instructions.replaceAll(`{{input.${input.as ?? input.name}}}`, artifact.content)
    }
    instructions = instructions.replace(/\{\{scratchpad\.([a-zA-Z0-9_.-]+)\}\}/g, (whole, key: string) => {
      const value = store.getScratchpadValue(key)
      return value ?? whole
    })
    let previousWork: string[] = []
    if (specTask?.persistent) {
      try {
        previousWork = store.getAgentIdentities(rec.agent, 3).map(i => i.summary)
      } catch { /* non-critical */ }
    }
    const dependencyResults = resolveDependencyResults(store, convoyId, parseJsonList(rec.depends_on), repoRoot)
    const promptFor = (text: string, retryNote: string | null | undefined): string =>
      composePrompt(sharedContext, buildTaskSection({
        id: rec.id,
        agent: rec.agent,
        files,
        prompt: text,
        dependencyResults,
        previousWork,
        retryNote,
        contract: buildContractInstruction(rec.agent),
      }))
    const promptText = promptFor(instructions, rec.retry_note)

    const promptScan = scanForSecrets(promptText, `task:${rec.id}`)
    if (!promptScan.clean) {
      events.emit('secret_leak_prevented', {
        task_id: rec.id,
        findings_count: promptScan.findings.length,
        patterns: promptScan.findings.map(f => f.pattern),
        context: 'prompt',
      }, { convoy_id: convoyId, task_id: rec.id })
      return fail('failed', `Secret detected in the prompt (${promptScan.findings.map(f => f.pattern).join(', ')}) — the task was not sent to the agent`, { kind: 'secret-in-prompt' })
    }

    const taskHooks: Hook[] = specTask?.hooks ?? []
    if (taskHooks.length > 0) {
      const pre = await runHooks(taskHooks, 'pre_task', { taskId: rec.id, cwd: wt, taskAdapter })
      if (!pre.passed) {
        const label = pre.failedHook?.name ?? pre.failedHook?.type ?? 'unknown'
        return fail('hook-failed', `pre_task hook "${label}" failed: ${pre.error ?? ''}`, { kind: 'hook-failed', hook: label })
      }
    }

    if (files.length > 0) {
      try {
        scanSymlinks(files, wt)
      } catch (err) {
        return fail('failed', `Symlink security check failed: ${(err as Error).message}`, { kind: 'symlink-escape' })
      }
    }

    // ── The agent ───────────────────────────────────────────────────────────
    const deadline = taskStart + rec.timeout_ms
    const execOptions: ExecuteOptions = {
      cwd: wt,
      permissionMode,
      ...(rec.model ? { model: rec.model } : {}),
    }
    const steps = specTask?.steps
    let result: ExecuteResult
    if (steps && steps.length > 0) {
      // Each step is sent as the task's own text would be: shared context
      // first, then the role, the files, and the step.
      result = await executeSteps(rec, steps, taskAdapter, wt, deadline, execOptions, (text) => promptFor(text, rec.retry_note))
    } else {
      const task = taskRecordToTask(rec)
      task.prompt = promptText
      result = await runAgent(rec.id, taskAdapter, task, execOptions, deadline - Date.now())
      addTaskUsage(rec.id, usageOf(result, promptText, rec.model))
    }

    if (ctl.interrupted) return requeue()
    if (result._timedOut) {
      return retryOrFail('timed-out', `Timed out after ${formatDuration(rec.timeout_ms)}`, {
        kind: 'timeout',
        output: result.output,
        note: `Your previous attempt ran out of time after ${formatDuration(rec.timeout_ms)}. Work in smaller steps and finish within the limit.`,
      })
    }
    if (!result.success) {
      const out = result.output || '(no output)'
      return retryOrFail('failed', firstLine(out) || `exit code ${result.exitCode}`, {
        kind: 'error',
        output: out,
        exitCode: result.exitCode,
        note: `Your previous attempt failed (exit code ${result.exitCode}). Its last output:\n${out.slice(-3000)}`,
      })
    }

    // ── Commit, so every check below sees the change ──────────────────────
    //
    // Gates and review sizing diffed `base..HEAD` before anything was
    // committed, so unless the agent committed itself they saw an empty change:
    // secret_scan scanned nothing and every review was sized as tiny.
    const summary = summarizeTask({ id: rec.id, description: specTask?.description, prompt: rec.prompt })
    if (wtManager.commitAll) {
      try {
        await wtManager.commitAll(wt, `convoy(${rec.id}): ${summary}`.slice(0, 200))
      } catch (err) {
        return retryOrFail('failed', `Could not commit the task's work: ${firstLine((err as { stderr?: string }).stderr) || (err as Error).message}`, { kind: 'commit' })
      }
    }
    const changes = startSha && wtManager.changes ? await wtManager.changes(wt, startSha) : null
    const changedFiles = changes?.files ?? []
    const diff = changes?.diff ?? ''

    // ── Per-task gates from the spec ────────────────────────────────────────
    const taskGates = parseJsonList(rec.gates)
    for (const command of taskGates) {
      const r = await runShell(command, { cwd: wt, timeoutMs: (spec.defaults?.gate_timeout ?? 300) * 1000 })
      events.emit('gate_result', { command, passed: r.code === 0, exit_code: r.code, scope: 'task' }, { convoy_id: convoyId, task_id: rec.id })
      if (ctl.interrupted) return requeue()
      if (r.code !== 0) {
        const output = [r.stderr, r.stdout].filter(Boolean).join('\n').trim() || '(no output)'
        return retryOrFail('gate-failed', `Gate "${command}" failed (exit ${r.code})`, {
          kind: 'gate-failed',
          gate: command,
          exitCode: r.code,
          output: `Gate failed: ${command}\nExit code: ${r.code}\n${output}`,
          note: `The gate \`${command}\` failed on your previous attempt (exit ${r.code}):\n${output.slice(-3000)}\n\nMake it pass.`,
        })
      }
    }

    const builtInGates = spec.defaults?.built_in_gates
    const contractResult = validateOutput(rec.agent, result.output)

    // ── No-op gate ──────────────────────────────────────────────────────────
    // A clean exit is not proof the work happened: a worker refused write
    // permission exits 0 having written nothing. On unless the spec turns it off.
    if (files.length > 0 && (builtInGates ? builtInGates.no_op !== false : true)) {
      const noOp = noOpGate({
        declaredFiles: files,
        changedFiles: changes ? changedFiles : null,
        agent: rec.agent,
        contractData: contractResult.data,
      })
      if (!noOp.passed) {
        events.emit('built_in_gate_result', { gate: 'no_op', passed: false, output: noOp.output }, { convoy_id: convoyId, task_id: rec.id })
        return retryOrFail('gate-failed', 'Produced no changes', {
          kind: 'no-op',
          gate: 'no_op',
          output: `Built-in gate (no_op) failed:\n${noOp.output}`,
          failureType: 'no-op',
          note: `Your previous attempt produced no changes.\n${noOp.output}\n\nWrite the files the task asks for. If you cannot, say why and stop.`,
        })
      }
    }

    // ── Built-in per-task gates ─────────────────────────────────────────────
    if (builtInGates) {
      if (builtInGates.browser_test) {
        const browserConfig = specTask?.browser_test ?? spec.defaults?.browser_test
        if (!browserConfig) {
          progress.line(`  ${c.yellow('⚠')} ${c.bold(`[${rec.id}]`)} browser_test is on but no browser_test.urls are set — skipped`)
        } else {
          const browserResult = await browserTestGate({
            mcpServers: spec.defaults?.mcp_servers ?? [],
            taskConfig: browserConfig,
            worktreePath: wt,
            approvalTimeout: spec.defaults?.mcp_server_approval_timeout,
          })
          events.emit('built_in_gate_result', { gate: 'browser_test', passed: browserResult.passed, output: browserResult.output }, { convoy_id: convoyId, task_id: rec.id })
          if (!browserResult.passed) {
            return retryOrFail('gate-failed', 'Browser test gate failed', {
              kind: 'gate-failed', gate: 'browser_test', output: `Built-in gate (browser_test) failed:\n${browserResult.output}`, failureType: 'browser-test',
              note: `The browser test gate failed on your previous attempt:\n${browserResult.output.slice(-3000)}`,
            })
          }
        }
      }

      if (builtInGates.secret_scan && changedFiles.length > 0) {
        const scanResult = await runSecretScanGate(changedFiles, wt)
        events.emit('built_in_gate_result', { gate: 'secret_scan', passed: scanResult.passed, output: scanResult.output }, { convoy_id: convoyId, task_id: rec.id })
        if (!scanResult.passed) {
          return retryOrFail('gate-failed', 'Secret scan found a credential in the change', {
            kind: 'gate-failed', gate: 'secret_scan', output: `Built-in gate (secret_scan) failed:\n${scanResult.output}`, failureType: 'secret-scan',
            note: `The secret scan found credentials in your previous change:\n${scanResult.output}\n\nRemove them; read secrets from the environment instead.`,
          })
        }
      }

      if (builtInGates.blast_radius && diff) {
        const blast = runBlastRadiusGate(diff)
        events.emit('built_in_gate_result', { gate: 'blast_radius', level: blast.level, passed: blast.passed, output: blast.output }, { convoy_id: convoyId, task_id: rec.id })
        if (!blast.passed) {
          return retryOrFail('gate-failed', blast.output, {
            kind: 'gate-failed', gate: 'blast_radius', output: `Built-in gate (blast_radius) failed:\n${blast.output}`,
            note: `Your previous change was too large: ${blast.output}\n\nKeep the change to what the task asks for.`,
          })
        }
      }

      if (builtInGates.tdd_check && changedFiles.length > 0) {
        const tddConfig: TDDGateConfig = typeof builtInGates.tdd_check === 'object'
          ? { ...DEFAULT_TDD_CONFIG, ...builtInGates.tdd_check }
          : DEFAULT_TDD_CONFIG
        const tdd = checkTDD(changedFiles, changedFiles, tddConfig, rec.agent)
        if (tdd.skipped) {
          events.emit('tdd_check_skipped', { task_id: rec.id, reason: tdd.skip_reason, agent: rec.agent }, { convoy_id: convoyId, task_id: rec.id })
        } else if (tdd.passed) {
          events.emit('tdd_check_passed', {
            task_id: rec.id,
            new_source_files: tdd.new_source_files.length,
            existing_test_files: tdd.existing_test_files.length,
          }, { convoy_id: convoyId, task_id: rec.id })
        } else {
          const failureMsg = formatTDDFailure(tdd)
          events.emit('tdd_check_failed', {
            task_id: rec.id,
            missing_test_files: tdd.missing_test_files,
            new_source_files: tdd.new_source_files.length,
          }, { convoy_id: convoyId, task_id: rec.id })
          if (tddConfig.mode === 'block') {
            return retryOrFail('gate-failed', 'TDD gate: source files without tests', {
              kind: 'gate-failed', gate: 'tdd_check', output: `Built-in gate (tdd_check) failed:\n${failureMsg}`, failureType: 'tdd-check',
              note: `The TDD gate failed on your previous attempt:\n${failureMsg}\n\nCreate the missing test files.`,
            })
          }
          progress.line(`  ${c.yellow('⚠')} ${c.bold(`[${rec.id}]`)} ${tdd.missing_test_files.length} source file(s) without tests`)
        }
      }
    }

    // ── Partition check: a warning, the work stays ─────────────────────────
    if (files.length > 0 && changedFiles.length > 0) {
      const violation = detectPartitionViolations(rec.id, files, changedFiles)
      if (violation) {
        events.emit('partition_violation', {
          task_id: rec.id,
          allowed: violation.allowedFiles,
          actual: violation.actualFiles,
          violations: violation.violations,
        }, { convoy_id: convoyId, task_id: rec.id })
        progress.line(`  ${c.yellow('⚠')} ${c.bold(`[${rec.id}]`)} changed files outside its list: ${violation.violations.join(', ')}`)
      }
    }

    // ── Review ──────────────────────────────────────────────────────────────
    const reviewSetting = specTask?.review ?? spec.defaults?.review ?? 'auto'
    if (reviewSetting !== 'none') {
      const diffStats: DiffStats = {
        linesChanged: countChangedLines(diff),
        filesChanged: changedFiles.length,
        filePaths: changedFiles,
      }
      const level: ReviewLevel = reviewSetting === 'fast' || reviewSetting === 'panel'
        ? reviewSetting
        : evaluateReviewLevel(rec, diffStats, spec.defaults?.review_heuristics, true)
      const reviewerModel = spec.defaults?.reviewer_model ?? 'default'

      const recordSkip = (why: string): void => {
        store.updateTaskReview(rec.id, convoyId, { review_level: level, review_verdict: 'skipped', review_tokens: 0, review_model: null })
        events.emit('review_skipped', { level, reason: why }, { convoy_id: convoyId, task_id: rec.id })
        progress.line(`  ${c.yellow('⚠')} ${c.bold(`[${rec.id}]`)} review skipped: ${why}`)
      }

      if (level === 'auto-pass') {
        store.updateTaskReview(rec.id, convoyId, { review_level: 'auto-pass', review_verdict: 'pass', review_tokens: 0, review_model: null })
        events.emit('review_verdict', { level: 'auto-pass', verdict: 'pass', tokens: 0, model: null, feedback_length: 0 }, { convoy_id: convoyId, task_id: rec.id })
      } else if (spec.defaults?.review_budget != null && reviewTokensTotal >= spec.defaults.review_budget) {
        if ((spec.defaults.on_review_budget_exceeded ?? 'skip') === 'stop') {
          stopDispatching('review budget spent (on_review_budget_exceeded: stop)')
          return fail('review-blocked', 'Review budget exceeded', { kind: 'review-blocked' })
        }
        recordSkip('the review budget is spent')
      } else {
        const reviewContext: ReviewContext = {
          prompt: rec.prompt,
          files,
          diff,
          cwd: wt,
          adapterName: taskAdapter.name,
          execute: (task, options) => runAgent(rec.id, taskAdapter, task, options, Math.min(rec.timeout_ms, 900_000)),
          canRunReadOnly: supportsPermissionMode(taskAdapter.name, 'plan'),
          timeoutMs: Math.min(rec.timeout_ms, 900_000),
        }
        events.emit('review_started', { level, task_id: rec.id, model: reviewerModel }, { convoy_id: convoyId, task_id: rec.id })
        const reviews: ReviewResult[] = level === 'panel'
          ? await Promise.all([0, 1, 2].map(() => reviewSemaphore.use(() => reviewRunner(rec, 'panel', reviewerModel, reviewContext))))
          : [await reviewSemaphore.use(() => reviewRunner(rec, 'fast', reviewerModel, reviewContext))]
        if (ctl.interrupted) return requeue()

        const reviewTokens = reviews.reduce((s, r) => s + (r.tokens ?? 0), 0)
        const reviewCost = reviews.reduce((s, r) => s + (r.costUsd ?? 0), 0)
        reviewTokensTotal += reviewTokens
        if (reviewTokens > 0) store.updateConvoyReviewTokens(convoyId, reviewTokensTotal)
        if (reviewCost > 0) {
          const row = store.getTask(rec.id, convoyId)!
          store.updateTaskStatus(rec.id, convoyId, row.status, { cost_usd: (row.cost_usd ?? 0) + reviewCost })
        }

        const decided = reviews.filter(r => r.verdict !== 'skipped')
        const passes = decided.filter(r => r.verdict === 'pass').length
        const blocks = decided.filter(r => r.verdict === 'block').length
        const needed = level === 'panel' ? 2 : 1
        const freshForPanel = store.getTask(rec.id, convoyId)!
        if (passes < needed && blocks < needed) {
          recordSkip(reviews.find(r => r.verdict === 'skipped')?.feedback || 'no verdict')
        } else {
          const verdict = blocks >= needed ? 'block' : 'pass'
          const model = decided.find(r => r.model)?.model ?? null
          store.updateTaskReview(rec.id, convoyId, {
            review_level: level,
            review_verdict: verdict,
            review_tokens: reviewTokens,
            review_model: model,
            ...(level === 'panel' ? { panel_attempts: freshForPanel.panel_attempts + 1 } : {}),
          })
          events.emit('review_verdict', {
            level,
            verdict,
            tokens: reviewTokens,
            model,
            feedback_length: decided.map(r => r.feedback).join('').length,
            ...(level === 'panel' ? { passes, blocks } : {}),
          }, { convoy_id: convoyId, task_id: rec.id })

          if (verdict === 'block') {
            const feedback = decided.filter(r => r.verdict === 'block').map(r => r.feedback).join('\n\n---\n\n')
            if (level === 'panel' && freshForPanel.panel_attempts + 1 >= 3) {
              const disputeId = `dispute-${rec.id}-${Date.now()}`
              await cleanup()
              store.updateTaskDisputeStatus(rec.id, convoyId, 'disputed', disputeId)
              writeDispute(disputeId, rec, decided, freshForPanel.panel_attempts + 1)
              events.emit('dispute_opened', {
                dispute_id: disputeId,
                task_id: rec.id,
                agent: rec.agent,
                panel_attempts: freshForPanel.panel_attempts + 1,
                reason: firstLine(feedback, 400),
              }, { convoy_id: convoyId, task_id: rec.id })
              progress.line(`  ${c.red('⚡')} ${c.bold(`[${rec.id}]`)} disputed after ${freshForPanel.panel_attempts + 1} panel reviews`)
              if ((spec.defaults?.on_dispute ?? 'stop') === 'stop') stopDispatching(`on_dispute: stop — task "${rec.id}" disputed`)
              cascadeFailure(rec.id)
              return
            }
            return retryOrFail('review-blocked', firstLine(feedback) || 'no reason given', {
              kind: 'review-blocked',
              output: `Review blocked: ${firstLine(feedback) || 'no reason given'}\n\n${feedback}`,
              note: `A reviewer blocked your previous change:\n${feedback}\n\nFix these and finish the task.`,
            })
          }
        }
      }
    }

    // ── post_task hooks and the post-run symlink scan ───────────────────────
    if (taskHooks.length > 0) {
      const post = await runHooks(taskHooks, 'post_task', { taskId: rec.id, cwd: wt, taskAdapter })
      if (!post.passed) {
        const label = post.failedHook?.name ?? post.failedHook?.type ?? 'unknown'
        return fail('hook-failed', `post_task hook "${label}" failed: ${post.error ?? ''}`, { kind: 'hook-failed', hook: label })
      }
    }
    if (files.length > 0) {
      try {
        scanNewSymlinks(wt, files)
      } catch (err) {
        return fail('failed', `Post-execution symlink security check failed: ${(err as Error).message}`, { kind: 'symlink-escape-post' })
      }
    }

    // ── Output contract: a warning, never a re-run ──────────────────────────
    // The re-run used to happen after the first attempt had already merged,
    // so a missing block ran — and merged — the whole task twice.
    if (!contractResult.valid) {
      const missing = contractResult.missing.filter(m => m !== '__contract_block')
      events.emit('contract_violation', {
        task_id: rec.id,
        agent: rec.agent,
        missing: contractResult.missing,
        warnings: contractResult.warnings,
      }, { convoy_id: convoyId, task_id: rec.id })
      if (verbose) {
        progress.line(`  ${c.dim(`  [${rec.id}] no complete output summary${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)}`)
      }
    }

    if (ctl.interrupted) return requeue()

    // ── Merge ───────────────────────────────────────────────────────────────
    const workerBranch = workerBranchName(workerId)
    const nothingToMerge = changes !== null && changedFiles.length === 0
    if (!nothingToMerge) {
      try {
        await mergeQueue.merge(wt, workerBranch, branch)
      } catch (err) {
        const fresh = store.getTask(rec.id, convoyId) ?? rec
        if (err instanceof MergeConflictError) {
          events.emit('merge_conflict_detected', {
            attempt,
            conflicting_files: err.conflictingFiles,
          }, { convoy_id: convoyId, task_id: rec.id })
          // Once, from the current tip — which now holds the change it collided
          // with — and named, so the agent knows what moved under it. Aborting
          // and handing the conflict to a fresh worktree cut from the old base,
          // as before, recreated the same conflict every time.
          if (!conflictReruns.has(rec.id) && fresh.retries < fresh.max_retries) {
            conflictReruns.add(rec.id)
            const listed = err.conflictingFiles.join(', ') || 'files another task changed'
            return retryOrFail('failed', `Merge conflict in ${listed}`, {
              kind: 'merge-conflict',
              note:
                `Your previous change conflicted with work merged while you ran, in: ${listed}.\n` +
                'Your worktree now starts from the convoy branch with that work in it. Make your change on top of it — keep what is there.',
            })
          }
        }
        const conflicting = err instanceof MergeConflictError ? err.conflictingFiles : undefined
        const message = err instanceof MergeConflictError
          ? `conflict in ${conflicting!.join(', ') || 'unknown files'}`
          : (err as Error).message
        events.emit('merge_failed', {
          branch: workerBranch,
          error: message,
          ...(conflicting ? { conflicting_files: conflicting } : {}),
        }, { convoy_id: convoyId, task_id: rec.id })
        return fail('failed', `Merge failed (${message}); the work is kept on branch ${workerBranch}`, {
          kind: 'merge-failed',
          keepBranch: workerBranch,
          failureType: 'merge-failed',
        })
      }
      events.emit('task_merged', { branch, files: changedFiles.length }, { convoy_id: convoyId, task_id: rec.id })
    }
    await cleanup()
    if (rec.branch && rec.branch !== workerBranch && wtManager.commitAll) {
      // A branch kept from an earlier failed merge is superseded now.
      try { await git(['branch', '-D', rec.branch], repoRoot) } catch { /* already gone */ }
    }

    // ── Outputs and artifacts ──────────────────────────────────────────────
    if (rec.outputs) {
      const outputs: TaskOutput[] = JSON.parse(rec.outputs) as TaskOutput[]
      for (const output of outputs) {
        let content: string
        if (output.type === 'summary') {
          content = result.output.slice(-4096)
        } else if (output.type === 'json') {
          const jsonMatch = result.output.match(/```json\n([\s\S]*?)```/)
          content = jsonMatch ? jsonMatch[1].trim() : result.output
        } else {
          content = result.output
        }
        try {
          store.insertArtifact({
            id: `artifact-${rec.id}-${output.name}-${Date.now()}`,
            convoy_id: convoyId,
            task_id: rec.id,
            name: output.name,
            type: output.type,
            content: redactSecrets(content).text,
            created_at: now(),
          })
        } catch (err) {
          if (!(err instanceof ConvoyArtifactLimitError)) throw err
          events.emit('artifact_limit_reached', { task_id: rec.id, limit: 50 }, { convoy_id: convoyId, task_id: rec.id })
        }
      }
    } else if (files.length > 0) {
      for (const filePath of files.slice(0, 20)) {
        try {
          store.insertArtifact({
            id: `artifact-${rec.id}-file-${filePath.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`,
            convoy_id: convoyId,
            task_id: rec.id,
            name: filePath,
            type: 'file',
            content: '',
            created_at: now(),
          })
        } catch (err) {
          if (err instanceof ConvoyArtifactLimitError) break
        }
      }
    }
    try {
      const refs = extractArtifactRefs(rec.id, convoyId, result.output, repoRoot)
      if (refs.length > 0) {
        events.emit('artifacts_extracted', {
          task_id: rec.id,
          count: refs.length,
          artifacts: refs.map(r => ({ filename: r.filename, summary: r.summary })),
        }, { convoy_id: convoyId, task_id: rec.id })
      }
    } catch { /* non-critical */ }

    if (specTask?.persistent && result.output) {
      try {
        const words = result.output.split(/\s+/)
        const lastWords = words.slice(-300).join(' ')
        const identitySummary = lastWords.length > 4096 ? lastWords.slice(-4096) : lastWords
        const summaryScan = scanForSecrets(identitySummary, `identity:${rec.id}`)
        if (summaryScan.clean) {
          store.insertAgentIdentity({
            id: `identity-${rec.id}-${Date.now()}`,
            agent: rec.agent,
            convoy_id: convoyId,
            task_id: rec.id,
            summary: identitySummary,
            created_at: now(),
            retention_days: 90,
          })
          events.emit('agent_identity_captured', { agent: rec.agent, task_id: rec.id }, { convoy_id: convoyId, task_id: rec.id })
        } else {
          events.emit('agent_identity_rejected', { agent: rec.agent, task_id: rec.id, reason: 'secrets_detected' }, { convoy_id: convoyId, task_id: rec.id })
        }
      } catch { /* non-critical */ }
    }

    // ── Done ────────────────────────────────────────────────────────────────
    store.withTransaction(() => {
      store.updateTaskStatus(rec.id, convoyId, 'done', {
        finished_at: now(),
        output: redactSecrets(result.output).text,
        exit_code: result.exitCode,
        contract_result: JSON.stringify(contractResult),
        branch: null,
        retry_note: null,
      })
      store.updateWorkerStatus(workerId!, 'done', { finished_at: now() })
    })
    if (circuitBreakerConfig) {
      circuitBreaker.recordSuccess(rec.agent)
      try { store.updateConvoyCircuitState(convoyId, circuitBreaker.serialize()) } catch { /* non-critical */ }
    }
    const row = store.getTask(rec.id, convoyId)!
    const cost = formatCost(row.cost_usd, Boolean(row.cost_estimated))
    progress.line(`  ${c.green('✓')} ${c.bold(`[${rec.id}]`)} ${elapsed()}${cost ? c.dim(` · ${cost}`) : ''}`)
    events.emit('task_done', {
      exit_code: result.exitCode,
      worker_id: workerId!,
      tokens: row.total_tokens,
      cost_usd: row.cost_usd,
      estimated: Boolean(row.cost_estimated),
      model: row.model,
    }, { convoy_id: convoyId, task_id: rec.id, worker_id: workerId! })
    telemetry('success', row.retries, changedFiles.length)
  }

  function writeDispute(disputeId: string, task: TaskRecord, panelResults: ReviewResult[], attempts: number): void {
    const marker = `<!-- dispute:${disputeId} -->`
    const blockingReasons = panelResults.filter(r => r.verdict === 'block').map(r => r.feedback).join('\n\n')
    const entry = `\n${marker}\n## Dispute: ${task.id}\n\n| Field | Value |\n|-------|-------|\n| Convoy | ${convoyId} |\n| Task | ${task.id} |\n| Date | ${new Date().toISOString()} |\n| Panel attempts | ${attempts} |\n| Agent | ${task.agent} |\n| Status | Open |\n\n**Blocking reasons:**\n\n${redactSecrets(blockingReasons).text}\n`
    const scan = scanForSecrets(entry, '.opencastle/DISPUTES.md')
    if (!scan.clean) {
      events.emit('secret_leak_prevented', {
        task_id: task.id,
        findings_count: scan.findings.length,
        patterns: scan.findings.map(f => f.pattern),
        context: 'dispute_markdown_write',
      }, { convoy_id: convoyId, task_id: task.id })
      return
    }
    appendLedger(repoRoot, 'DISPUTES.md', marker, entry)
  }

  // ── Scheduler: a ready queue, not phase barriers ──────────────────────────
  //
  // Waves used to run in fixed batches and the next wave waited for the whole
  // previous one, so a task whose dependency finished early sat idle behind the
  // slowest task of its wave. Now any finished task frees its slot and the
  // ready set is recomputed at once.

  const slots = typeof spec.concurrency === 'number' && spec.concurrency >= 1
    ? spec.concurrency
    : (spec.defaults?.max_swarm_concurrency ?? 4)

  function prerequisites(t: TaskRecord): string[] {
    // An input names the task that produces it; that is a dependency too.
    const inputs = t.inputs ? (JSON.parse(t.inputs) as TaskInput[]).map(i => i.from) : []
    return [...parseJsonList(t.depends_on), ...inputs]
  }

  /**
   * Ready tasks, most-blocking first: a task that others wait on starts before
   * one nobody needs, and ties keep the spec's order. Picking alphabetically
   * could leave the run's longest task for the second round.
   */
  const specOrder = new Map((spec.tasks ?? []).map((t, i) => [t.id, i]))
  function readyTasks(all: TaskRecord[]): TaskRecord[] {
    const ids = new Set(all.map(t => t.id))
    const done = new Set(all.filter(t => t.status === 'done').map(t => t.id))
    const dependents = new Map<string, string[]>()
    for (const t of all) {
      for (const d of prerequisites(t)) dependents.set(d, [...(dependents.get(d) ?? []), t.id])
    }
    const reach = (id: string, seen = new Set<string>()): number => {
      for (const next of dependents.get(id) ?? []) {
        if (!seen.has(next)) { seen.add(next); reach(next, seen) }
      }
      return seen.size
    }
    return all
      .filter(t => t.status === 'pending' && !running.has(t.id) && prerequisites(t).every(d => done.has(d) || !ids.has(d)))
      .map(t => ({ t, weight: reach(t.id), order: specOrder.get(t.id) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => b.weight - a.weight || a.order - b.order)
      .map(x => x.t)
  }

  progress.setStatus(() => {
    const all = store.getTasksByConvoy(convoyId)
    const names = all.filter(t => running.has(t.id)).map(t => t.id)
    const queued = all.filter(t => t.status === 'pending' && !running.has(t.id)).length
    const done = all.filter(t => t.status === 'done').length
    let cost = extraCost
    let anyCost = extraCost > 0
    let estimated = extraEstimated
    for (const t of all) {
      if (t.cost_usd != null) { cost += t.cost_usd; anyCost = true }
      if (t.cost_estimated) estimated = true
    }
    const parts = [
      names.length > 0 ? names.join(', ') : (ctl.stopDispatch ? 'stopping' : 'idle'),
      `${queued} queued`,
      `${done}/${all.length} done`,
      formatDuration(Date.now() - startTime).replace(/ /g, ''),
    ]
    const costText = anyCost ? formatCost(cost, estimated) : null
    if (costText) parts.push(costText)
    return `  ${c.cyan('▸')} ${parts.join(' · ')}`
  })

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const graceExpired = ctl.interruptedPromise.then(
    () => new Promise<'grace'>(res => { graceTimer = setTimeout(() => res('grace'), INTERRUPT_GRACE_MS) }),
  )

  try {
    for (;;) {
      if (!ctl.stopDispatch) {
        const all = store.getTasksByConvoy(convoyId)
        const runningRecords = all.filter(t => running.has(t.id))
        const startable = pickStartable(readyTasks(all), runningRecords, slots - running.size)
        for (const t of startable) {
          const p = runTask(t)
            .catch(async (err: unknown) => {
              // An unexpected throw fails the one task, not the convoy.
              const msg = (err as Error)?.message ?? String(err)
              try {
                const row = store.getTask(t.id, convoyId)
                if (row && (row.status === 'running' || row.status === 'assigned' || row.status === 'pending')) {
                  store.updateTaskStatus(t.id, convoyId, ctl.interrupted ? 'pending' : 'failed', {
                    finished_at: ctl.interrupted ? null : new Date().toISOString(),
                    output: redactSecrets(`Engine error: ${msg}`).text,
                  })
                  if (!ctl.interrupted) {
                    progress.line(`  ${c.red('✗')} ${c.bold(`[${t.id}]`)} failed: engine error: ${firstLine(msg)}`)
                    events.emit('task_failed', { reason: 'engine-error', message: firstLine(msg, 400) }, { convoy_id: convoyId, task_id: t.id })
                    cascadeFailure(t.id)
                  }
                }
              } catch { /* store closed */ }
            })
            .finally(() => { running.delete(t.id) })
          running.set(t.id, p)
        }
      }
      if (running.size === 0) break
      const winner = await Promise.race([
        ...running.values(),
        ctl.interruptedPromise.then(() => (ctl.interrupted ? graceExpired : undefined)),
      ])
      if (winner === 'grace') break
    }
  } finally {
    if (graceTimer) clearTimeout(graceTimer)
  }

  // ── After the queue ───────────────────────────────────────────────────────

  if (ctl.interrupted) {
    return finishInterrupted()
  }

  // Tasks never started because dispatch stopped are skipped, with the reason.
  if (ctl.stopDispatch) {
    for (const t of store.getTasksByConvoy(convoyId).filter(x => x.status === 'pending')) {
      skipTask(t.id, 'not started: the run stopped dispatching after a failure')
    }
  }
  for (const t of store.getTasksByConvoy(convoyId).filter(x => x.status === 'pending')) {
    skipTask(t.id, 'its dependencies never finished')
  }

  // ── Run-once gates ────────────────────────────────────────────────────────
  //
  // `npm test` and `npm audit` used to run once per task, in each worktree —
  // N copies of the test suite. They run once, here, on the merged result,
  // together with the spec's own gates.
  const maxGateRetries = spec.gate_retries ?? 0
  let gateAttempt = 0
  let gateResults: Array<{ command: string; exitCode: number; passed: boolean; output?: string }> = []
  const anyDone = store.getTasksByConvoy(convoyId).some(t => t.status === 'done')
  const builtInGates = spec.defaults?.built_in_gates ?? {}
  const pkgScripts = readPackageScripts(workRoot)
  const wantRegression = Boolean(builtInGates.regression_test)
  const wantAudit = Boolean(builtInGates.dependency_audit)
  // npm is the only runner these two know; a project that is not an npm
  // package is told so once, not failed on a gate it cannot satisfy.
  const runRegression = wantRegression && pkgScripts !== null && typeof pkgScripts.test === 'string'
  const runAudit = wantAudit && pkgScripts !== null
  const hasGates = (spec.gates?.length ?? 0) > 0 || runRegression || runAudit
  const gateTimeoutMs = (builtInGates.gate_timeout ?? spec.defaults?.gate_timeout ?? 300) * 1000

  if (wantRegression && !runRegression) {
    progress.line(`  ${c.dim('regression_test is on but there is no "test" script in package.json — skipped')}`)
  }
  if (wantAudit && !runAudit) {
    progress.line(`  ${c.dim('dependency_audit is on but there is no package.json — skipped')}`)
  }

  while (hasGates && anyDone && !ctl.interrupted) {
    gateResults = []
    progress.line(`\n  ${c.bold(gateAttempt === 0 ? 'Gates:' : `Gates (fix ${gateAttempt}/${maxGateRetries}):`)}`)

    for (const command of spec.gates ?? []) {
      const r = await runShell(command, { cwd: workRoot, timeoutMs: gateTimeoutMs })
      const output = [r.stderr, r.stdout].filter(Boolean).join('\n').trim()
      gateResults.push({ command, exitCode: r.code, passed: r.code === 0, ...(r.code !== 0 ? { output } : {}) })
      events.emit('gate_result', { command, passed: r.code === 0, exit_code: r.code, scope: 'convoy', ...(r.code !== 0 ? { output: output.slice(-2000) } : {}) }, { convoy_id: convoyId })
      progress.line(`  ${r.code === 0 ? c.green('✓') : c.red('✗')} ${c.dim(command)}${r.code !== 0 && output ? `: ${firstLine(output)}` : ''}`)
    }
    if (runRegression) {
      const reg = await runRegressionTestGate(workRoot, 'npm test', gateTimeoutMs)
      gateResults.push({ command: 'npm test', exitCode: reg.passed ? 0 : 1, passed: reg.passed, ...(reg.passed ? {} : { output: reg.output }) })
      events.emit('built_in_gate_result', { gate: 'regression_test', passed: reg.passed, output: reg.output.slice(-2000) }, { convoy_id: convoyId })
      progress.line(`  ${reg.passed ? c.green('✓') : c.red('✗')} ${c.dim('npm test (regression_test)')}`)
    }
    if (runAudit) {
      const audit = await runDependencyAuditGate(workRoot, gateTimeoutMs)
      gateResults.push({ command: 'npm audit', exitCode: audit.passed ? 0 : 1, passed: audit.passed, ...(audit.passed ? {} : { output: audit.output }) })
      events.emit('built_in_gate_result', { gate: 'dependency_audit', passed: audit.passed, output: audit.output.slice(-2000) }, { convoy_id: convoyId })
      progress.line(`  ${audit.passed ? c.green('✓') : c.red('✗')} ${c.dim('npm audit (dependency_audit)')}`)
    }

    const failedGates = gateResults.filter(g => !g.passed)
    if (failedGates.length === 0 || gateAttempt >= maxGateRetries) break

    gateAttempt++
    const failureSummary = failedGates
      .map(g => `Command: ${g.command}\nExit code: ${g.exitCode}\nOutput:\n${(g.output ?? '(no output)').slice(-4000)}`)
      .join('\n\n---\n\n')
    const touchedFiles = store.getTasksByConvoy(convoyId).flatMap(t => parseJsonList(t.files))
    const filesContext = touchedFiles.length > 0
      ? `\n\nFiles changed by the convoy's tasks:\n${touchedFiles.map(f => `- ${f}`).join('\n')}\n`
      : ''
    const fixTaskId = `gate-fix-${gateAttempt}`
    progress.line(`\n  ${c.yellow('⟳')} ${c.bold(`[${fixTaskId}]`)} fixing the failed gates (attempt ${gateAttempt}/${maxGateRetries})`)
    const fixTask: Task = {
      id: fixTaskId,
      prompt: `${sharedContext}\n\n---\n\n## Your task: ${fixTaskId}\nThese checks failed after every task was merged. Fix the code so they pass.${filesContext}\n\n${failureSummary}\n`,
      agent: spec.defaults?.agent ?? 'developer',
      timeout: spec.defaults?.timeout ?? '30m',
      depends_on: [],
      files: [],
      description: `Fix gate failures (attempt ${gateAttempt})`,
      max_retries: 0,
    }
    const fixResult = await runAgent(fixTaskId, adapter, fixTask, { cwd: workRoot, permissionMode }, parseTimeout(fixTask.timeout))
    const fixUsage = usageOf(fixResult, fixTask.prompt, spec.defaults?.model ?? null)
    extraTokens += fixUsage.total
    extraCost += fixUsage.cost ?? 0
    extraEstimated = extraEstimated || fixUsage.estimated
    if (ctl.interrupted) break
    if (!fixResult.success) {
      progress.line(`  ${c.red('✗')} ${c.bold(`[${fixTaskId}]`)} the fix attempt failed: ${firstLine(fixResult.output)}`)
      break
    }
    if (wtManager.commitAll) {
      try {
        await commitAllIn(workRoot, `convoy: fix gates (attempt ${gateAttempt})`)
      } catch (err) {
        progress.line(`  ${c.red('✗')} could not commit the gate fix: ${firstLine((err as Error).message)}`)
        break
      }
    }
    progress.line(`  ${c.green('✓')} ${c.bold(`[${fixTaskId}]`)} fix applied`)
  }

  if (ctl.interrupted) return finishInterrupted()

  // ── post_convoy hooks ─────────────────────────────────────────────────────
  const specLevelHooks: Hook[] = spec.hooks ?? []
  if (specLevelHooks.length > 0) {
    const post = await runHooks(specLevelHooks, 'post_convoy', { cwd: workRoot })
    if (!post.passed) {
      const hookLabel = post.failedHook?.name ?? post.failedHook?.type ?? 'unknown'
      events.emit('post_convoy_hook_failed', { hook: hookLabel, error: post.error }, { convoy_id: convoyId })
      progress.line(`  ${c.red('✗')} post_convoy hook "${hookLabel}" failed: ${firstLine(post.error)}`)
    }
  }

  // ── Final status ──────────────────────────────────────────────────────────
  const allTasksFinal = store.getTasksByConvoy(convoyId)
  const summary = summarize(allTasksFinal)
  const anyGateFailed = gateResults.some(g => !g.passed)
  const notDone = allTasksFinal.filter(t => t.status !== 'done')
  // A skipped task is not done: the run is not finished while one remains.
  const finalStatus: ConvoyStatus = anyGateFailed ? 'gate-failed' : notDone.length > 0 ? 'failed' : 'done'
  const totals = persistTotals(allTasksFinal, finalStatus)

  if (finalStatus === 'done') {
    events.emit('convoy_finished', { status: 'done' }, { convoy_id: convoyId })
  } else {
    events.emit('convoy_failed', {
      status: finalStatus,
      reason: anyGateFailed ? 'Gate check failed' : `${notDone.length} task(s) not done`,
    }, { convoy_id: convoyId })
  }

  const guard = runConvoyGuard(store, convoyId, wtManager, ndjsonPath, spec.guard)
  if (guard.warnings.length > 0) {
    events.emit('convoy_guard', { passed: guard.passed, warnings: guard.warnings }, { convoy_id: convoyId })
    if (verbose) for (const w of guard.warnings) progress.line(`  ${c.dim(`guard: ${w}`)}`)
  }

  return {
    convoyId,
    status: finalStatus,
    summary,
    duration: formatDuration(Date.now() - startTime),
    gateResults: hasGates && gateResults.length > 0 ? gateResults : undefined,
    cost: totals,
    exitCode: finalStatus === 'done' ? 0 : 1,
    branch,
    baseRef: ctx.baseRef,
    logPath: ndjsonPath,
    keptBranches: allTasksFinal.filter(t => t.branch).map(t => ({ taskId: t.id, branch: t.branch! })),
  }

  function summarize(tasks: TaskRecord[]): ConvoyResult['summary'] {
    return {
      total: tasks.length,
      done: tasks.filter(t => t.status === 'done').length,
      failed: tasks.filter(t => ['failed', 'gate-failed', 'review-blocked', 'disputed', 'hook-failed'].includes(t.status)).length,
      skipped: tasks.filter(t => t.status === 'skipped').length,
      timedOut: tasks.filter(t => t.status === 'timed-out').length,
    }
  }

  function persistTotals(tasks: TaskRecord[], status: ConvoyStatus): ConvoyResult['cost'] {
    let tokens: number | null = extraTokens > 0 ? extraTokens : null
    let cost: number | null = extraCost > 0 ? extraCost : null
    let estimated = extraEstimated
    for (const t of tasks) {
      const taskTokens = (t.total_tokens ?? 0) + (t.review_tokens ?? 0)
      if (t.total_tokens != null || t.review_tokens) tokens = (tokens ?? 0) + taskTokens
      if (t.cost_usd != null) cost = (cost ?? 0) + t.cost_usd
      if (t.cost_estimated) estimated = true
    }
    store.updateConvoyStatus(convoyId, status, {
      finished_at: new Date().toISOString(),
      total_tokens: tokens,
      total_cost_usd: cost,
      cost_estimated: estimated,
    })
    return tokens != null || cost != null
      ? { total_tokens: tokens ?? 0, total_cost_usd: cost ?? undefined, estimated }
      : undefined
  }

  function finishInterrupted(): ConvoyResult {
    const requeued: string[] = []
    for (const t of store.getTasksByConvoy(convoyId)) {
      if (t.status === 'running' || t.status === 'assigned') {
        store.updateTaskStatus(t.id, convoyId, 'pending', { worker_id: null, worktree: null, started_at: null })
        if (t.worker_id) {
          try { store.updateWorkerStatus(t.worker_id, 'killed', { finished_at: new Date().toISOString() }) } catch { /* gone */ }
        }
        requeued.push(t.id)
      }
    }
    const all = store.getTasksByConvoy(convoyId)
    const totals = persistTotals(all, 'interrupted')
    events.emit('convoy_interrupted', { signal: ctl.interrupted ?? 'abort', requeued }, { convoy_id: convoyId })
    return {
      convoyId,
      status: 'interrupted',
      summary: summarize(all),
      duration: formatDuration(Date.now() - startTime),
      cost: totals,
      exitCode: 130,
      branch,
      baseRef: ctx.baseRef,
      logPath: ndjsonPath,
      keptBranches: all.filter(t => t.branch).map(t => ({ taskId: t.id, branch: t.branch! })),
    }
  }
}

function readPackageScripts(dir: string): Record<string, unknown> | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return pkg.scripts ?? {}
  } catch {
    return null
  }
}

// ── The summary a run ends with ───────────────────────────────────────────────

function printSummary(progress: Progress, result: ConvoyResult, store: ConvoyStore, repoRoot: string): void {
  const tasks = store.getTasksByConvoy(result.convoyId)
  const icon = result.status === 'done' ? c.green('✓') : result.status === 'interrupted' ? c.yellow('■') : c.red('✗')
  const s = result.summary
  const lines: string[] = ['', `  ${c.dim('──────────────────────────────────────')}`]
  lines.push(`  ${icon} ${c.bold(`Convoy ${result.status}`)} in ${result.duration} — ${s.done}/${s.total} tasks done` +
    (s.failed ? `, ${s.failed} failed` : '') + (s.timedOut ? `, ${s.timedOut} timed out` : '') + (s.skipped ? `, ${s.skipped} skipped` : ''))
  for (const t of tasks.filter(x => x.status !== 'done')) {
    const why = t.status === 'pending'
      ? (result.status === 'interrupted' ? 'stopped; runs again on resume' : 'not started')
      : firstLine(t.output, 120) || t.status
    lines.push(`    ${c.dim('•')} ${t.id} ${c.dim(`(${t.status})`)}: ${why}`)
  }
  if (result.gateResults) {
    const passed = result.gateResults.filter(g => g.passed).length
    lines.push(`  Gates: ${passed}/${result.gateResults.length} passed`)
    for (const g of result.gateResults.filter(x => !x.passed)) {
      lines.push(`    ${c.dim('•')} ${g.command} ${c.dim(`(exit ${g.exitCode})`)}: ${firstLine(g.output, 120) || 'no output'}`)
    }
  }
  if (result.cost) {
    const cost = formatCost(result.cost.total_cost_usd, Boolean(result.cost.estimated))
    lines.push(`  Spent: ${formatTokens(result.cost.total_tokens)} tokens${result.cost.estimated && !cost ? ' (est.)' : ''}${cost ? ` · ${cost}` : ''}`)
  }
  lines.push(`  Convoy: ${result.convoyId}`)
  if (result.branch) {
    lines.push(`  Branch: ${c.bold(result.branch)}${result.baseRef ? c.dim(` (from ${result.baseRef})`) : ''}`)
    if (s.done > 0) {
      if (result.baseRef) lines.push(`    Review: git diff ${result.baseRef}...${result.branch}`)
      lines.push(`    Merge:  git merge ${result.branch}`)
    }
  }
  for (const k of result.keptBranches ?? []) {
    lines.push(`  Kept: ${k.branch} ${c.dim(`— ${k.taskId}'s work, which could not be merged`)}`)
  }
  if (result.logPath) {
    const rel = relative(repoRoot, result.logPath)
    lines.push(`  Log: ${rel.startsWith('..') ? result.logPath : rel}`)
  }
  if (result.status !== 'done') {
    lines.push(`  Resume with: ${c.cyan('opencastle convoy resume')}`)
  }
  for (const l of lines) progress.line(l)
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createConvoyEngine(options: ConvoyEngineOptions): ConvoyEngine {
  const { spec, specYaml, adapter, verbose = false } = options
  const basePath = resolve(options.basePath ?? process.cwd())
  const dbPath = options.dbPath ?? join(basePath, '.opencastle', 'convoy.db')
  const injectedCheckout = options._convoyWorktreeDir !== undefined || options._ensureBranch !== undefined

  /**
   * The main checkout, where `.opencastle/` lives — never a worktree that is
   * about to be removed. A caller that supplies its own checkout (tests, the
   * pipeline) says where with `repoRoot`, or gets `basePath`.
   */
  async function resolveRepoRoot(): Promise<string> {
    if (options.repoRoot) return resolve(options.repoRoot)
    if (injectedCheckout) return basePath
    return (await mainRepoRoot(basePath)) ?? basePath
  }

  function openLock(): { release(): void } {
    mkdirSync(dirname(dbPath), { recursive: true })
    const lockDb = new DatabaseSync(dbPath)
    lockDb.exec('PRAGMA journal_mode = WAL')
    lockDb.exec(`CREATE TABLE IF NOT EXISTS engine_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    )`)
    let lock: ReturnType<typeof acquireEngineLock>
    try {
      lock = acquireEngineLock(lockDb, dbPath)
    } catch (err) {
      lockDb.close()
      throw err
    }
    const versionRow = lockDb.prepare('SELECT sqlite_version() as v').get() as { v: string }
    const [major, minor] = versionRow.v.split('.').map(Number)
    if (major < 3 || (major === 3 && minor < 35)) {
      lock.release()
      lockDb.close()
      throw new Error(`SQLite version ${versionRow.v} is too old. Requires >= 3.35.0`)
    }
    lock.startHeartbeat()
    return {
      release() {
        lock.release()
        lockDb.close()
      },
    }
  }

  /**
   * Refuse a spec the run would fail on, before anything is recorded: overlapping
   * files within a phase, globs, an unknown per-task runtime. These used to
   * surface mid-run, after earlier tasks had merged, or after a failed row was
   * already written.
   */
  async function validatePlan(): Promise<void> {
    const tasks = spec.tasks ?? []
    const partition = validateFilePartitions(tasks, buildPhases(tasks))
    if (!partition.valid) {
      const conflictSummary = partition.conflicts
        .map(cf => `Phase ${cf.phase + 1}: tasks "${cf.taskA}" and "${cf.taskB}" overlap on [${cf.overlapping.join(', ')}]`)
        .join('\n')
      throw new Error(`File partition conflicts detected:\n${conflictSummary}`)
    }
    const names = new Set(tasks.map(t => t.adapter).filter((a): a is string => Boolean(a) && a !== 'auto' && a !== adapter.name))
    for (const name of names) {
      await getAdapter(name)
    }
  }

  /** Stop on SIGINT/SIGTERM or the abort signal; a second Ctrl+C stops at once. */
  function installInterrupts(ctl: RunControl, progress: Progress): () => void {
    const disposers: Array<() => void> = []
    const onSignal = (sig: NodeJS.Signals): void => {
      if (ctl.interrupted) {
        // A second Ctrl+C means "now". Agents get SIGKILL through their
        // adapters; the exit is unavoidable, because the person has said they
        // will not wait for the cleanup the first signal started. The rows
        // already read pending or running, and `resume` handles both.
        for (const fn of ctl.onInterrupt) {
          try { fn() } catch { /* best effort */ }
        }
        process.exit(130)
      }
      progress.line(`\n  ${c.yellow('■')} ${sig} — stopping: killing running agents, no new tasks. Press Ctrl+C again to quit at once.`)
      ctl.interrupt(sig)
    }
    if (options.handleSignals !== false) {
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      disposers.push(() => {
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
      })
    }
    if (options.signal) {
      const onAbort = (): void => ctl.interrupt('abort')
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
      disposers.push(() => options.signal?.removeEventListener('abort', onAbort))
    }
    return () => { for (const d of disposers) d() }
  }

  /** The integration checkout for `branch`, and whether this run owns it. */
  async function integrationCheckout(repoRoot: string, branch: string, base: string, dirName: string): Promise<{ path: string; owned: boolean }> {
    if (typeof options._convoyWorktreeDir === 'string') return { path: resolve(options._convoyWorktreeDir), owned: false }
    if (injectedCheckout) {
      // `basePath` is the merge target here. That must never be the user's own
      // checkout — the main worktree — however the caller got there. (Tests
      // that inject `_ensureBranch` use a scratch directory and are spared the
      // git call; the pipeline never passes it.)
      let main: string | undefined
      if (options._ensureBranch === undefined) {
        try {
          main = (await listAllWorktrees(basePath))[0]?.path
        } catch { /* not a git repository */ }
      }
      const real = (p: string): string => { try { return realpathSync(p) } catch { return resolve(p) } }
      if (main && real(main) === real(basePath)) {
        throw new Error(
          `Refusing to merge convoy work into ${basePath}, the repository's own checkout. ` +
            'Give the convoy a worktree of its branch (_convoyWorktreeDir), or let it create one.',
        )
      }
      return { path: basePath, owned: false }
    }
    return { path: await ensureRootWorktree({ repoRoot, branch, base, dirName }), owned: true }
  }

  /** The branch checked out in the user's own checkout, which a convoy must not merge into. */
  async function userBranch(repoRoot: string): Promise<string | null> {
    try {
      const main = (await listAllWorktrees(repoRoot))[0]
      return main?.branch ? main.branch.replace(/^refs\/heads\//, '') : null
    } catch {
      return null
    }
  }

  async function run(): Promise<ConvoyResult> {
    const startTime = Date.now()
    const convoyId = `convoy-${startTime}`
    const specHash = createHash('sha256').update(specYaml).digest('hex')
    await validatePlan()

    const lock = openLock()
    const store = createConvoyStore(dbPath)
    const progress = createProgress({ stream: options.output })
    const ctl = createRunControl()
    let events: ConvoyEventEmitter | null = null
    let checkout: { path: string; owned: boolean } | null = null
    let repoRoot = basePath
    let disposeInterrupts: () => void = () => {}
    let inserted = false

    try {
      repoRoot = await resolveRepoRoot()
      const branch = spec.branch ?? defaultBranchName(spec.name, convoyId)
      let baseRef: string | null = injectedCheckout ? null : await currentRef(basePath)
      if (!injectedCheckout) {
        // Work lands on a branch of its own. A spec naming the branch the
        // user has checked out would have the convoy commit into their tree.
        const mine = await userBranch(repoRoot)
        if (mine && mine === branch) throw new BranchInUseError(branch, repoRoot)
        checkout = await integrationCheckout(repoRoot, branch, baseRef ?? 'HEAD', shortConvoyId(convoyId))
      } else {
        checkout = await integrationCheckout(repoRoot, branch, 'HEAD', shortConvoyId(convoyId))
        baseRef = null
      }

      const ndjsonPath = options.logsDir
        ? join(options.logsDir, 'convoys', `${convoyId}.ndjson`)
        : ndjsonPathForConvoy(convoyId, repoRoot)
      events = createEventEmitter(store, { ndjsonPath })
      const wtManager = options._worktreeManager ?? createWorktreeManager(repoRoot)
      const mergeQueue = options._mergeQueue ?? createMergeQueue(checkout.path, { worktreesDir: worktreesDirFor(repoRoot) })

      // From here on a throw is a crash of this convoy, and its row is marked so.
      inserted = true
      store.insertConvoy({
        id: convoyId,
        name: spec.name,
        spec_hash: specHash,
        status: 'pending',
        branch,
        base_ref: baseRef,
        adapter: adapter.name,
        created_at: new Date().toISOString(),
        spec_yaml: specYaml,
        pipeline_id: options.pipelineId ?? null,
      })

      const tasks = spec.tasks ?? []
      const phases = buildPhases(tasks)
      for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
        for (const task of phases[phaseIdx]) {
          store.insertTask({
            id: task.id,
            convoy_id: convoyId,
            phase: phaseIdx,
            prompt: task.prompt,
            agent: task.agent,
            adapter: task.adapter ?? null,
            model: task.model ?? null,
            timeout_ms: parseTimeout(task.timeout),
            status: 'pending',
            retries: 0,
            max_retries: task.max_retries,
            files: task.files.length > 0 ? JSON.stringify(task.files) : null,
            depends_on: task.depends_on.length > 0 ? JSON.stringify(task.depends_on) : null,
            gates: task.gates && task.gates.length > 0 ? JSON.stringify(task.gates) : null,
            outputs: task.outputs && task.outputs.length > 0 ? JSON.stringify(task.outputs) : null,
            inputs: task.inputs && task.inputs.length > 0 ? JSON.stringify(task.inputs) : null,
          })
        }
      }

      const concurrency = typeof spec.concurrency === 'number' ? spec.concurrency : (spec.defaults?.max_swarm_concurrency ?? 4)
      store.updateConvoyStatus(convoyId, 'running', { started_at: new Date().toISOString() })
      events.emit('convoy_started', { name: spec.name, branch, base: baseRef, concurrency }, { convoy_id: convoyId })
      progress.line(`  ${c.dim('Branch')} ${branch}${baseRef ? c.dim(` (from ${baseRef})`) : ''} ${c.dim(`· ${tasks.length} tasks · up to ${concurrency} at once`)}`)

      disposeInterrupts = installInterrupts(ctl, progress)
      const result = await runConvoy({
        convoyId, spec, adapter, store, events, wtManager, mergeQueue, repoRoot,
        workRoot: checkout.path, branch, baseRef, verbose, startTime, ndjsonPath,
        reviewRunner: options._reviewRunner ?? defaultReviewer, progress, ctl,
      })
      progress.stop()
      printSummary(progress, result, store, repoRoot)
      return result
    } catch (err) {
      if (inserted) markConvoyCrashed(store, events, convoyId, err)
      throw err
    } finally {
      disposeInterrupts()
      progress.stop()
      events?.close()
      store.close()
      lock.release()
      if (checkout?.owned) await removeRootWorktree(repoRoot, checkout.path)
    }
  }

  /**
   * Continue whatever is not done.
   *
   * Everything `retry` used to do happens here: failed, timed-out, gate-failed,
   * review-blocked, disputed, interrupted (running/assigned) and skipped tasks
   * go back to pending. A stale integration worktree is reused or pruned, a dead
   * owner's lock is taken over, and a convoy recorded without a branch of its
   * own gets one.
   */
  async function resume(convoyId: string): Promise<ConvoyResult> {
    const startTime = Date.now()
    const lock = openLock()
    const store = createConvoyStore(dbPath)
    const progress = createProgress({ stream: options.output })
    const ctl = createRunControl()
    let events: ConvoyEventEmitter | null = null
    let checkout: { path: string; owned: boolean } | null = null
    let repoRoot = basePath
    let disposeInterrupts: () => void = () => {}

    try {
      const convoy = store.getConvoy(convoyId)
      if (!convoy) {
        throw new Error(`Convoy "${convoyId}" not found in store`)
      }
      repoRoot = await resolveRepoRoot()

      let branch = convoy.branch ?? spec.branch ?? defaultBranchName(convoy.name, convoyId)
      let baseRef = convoy.base_ref ?? null
      if (!injectedCheckout) {
        // Older runs recorded the user's own branch here even when the spec
        // named none, and merged into their checkout. Such a run continues on a
        // branch of its own, cut from where it left off.
        const mine = await userBranch(repoRoot)
        if (!convoy.branch || convoy.branch === mine) {
          baseRef = convoy.branch ?? (await currentRef(basePath))
          branch = defaultBranchName(convoy.name, convoyId)
          store.updateConvoyBranch(convoyId, branch, baseRef)
          progress.line(`  ${c.dim(`This run had no branch of its own; continuing on ${branch}.`)}`)
        }
      }

      const ndjsonPath = options.logsDir
        ? join(options.logsDir, 'convoys', `${convoyId}.ndjson`)
        : ndjsonPathForConvoy(convoyId, repoRoot)
      events = createEventEmitter(store, { ndjsonPath })

      checkout = await integrationCheckout(repoRoot, branch, baseRef ?? 'HEAD', shortConvoyId(convoyId))
      const wtManager = options._worktreeManager ?? createWorktreeManager(repoRoot)
      const mergeQueue = options._mergeQueue ?? createMergeQueue(checkout.path, { worktreesDir: worktreesDirFor(repoRoot) })

      const reset = resetForResume(store, events, convoyId)

      // Worktrees left by a run that died — not the integration checkout.
      await wtManager.removeAll({ except: [checkout.path] })

      recoverNdjson(store, convoyId, ndjsonPath)
      store.updateConvoyStatus(convoyId, 'running', {})
      events.emit('convoy_resumed', { original_created_at: convoy.created_at, reset }, { convoy_id: convoyId })
      const pendingCount = store.getTasksByConvoy(convoyId).filter(t => t.status === 'pending').length
      progress.line(`  ${c.dim('Branch')} ${branch}${baseRef ? c.dim(` (from ${baseRef})`) : ''} ${c.dim(`· ${pendingCount} task(s) to run`)}`)

      disposeInterrupts = installInterrupts(ctl, progress)
      const result = await runConvoy({
        convoyId, spec, adapter, store, events, wtManager, mergeQueue, repoRoot,
        workRoot: checkout.path, branch, baseRef, verbose, startTime, ndjsonPath,
        reviewRunner: options._reviewRunner ?? defaultReviewer, progress, ctl,
      })
      progress.stop()
      printSummary(progress, result, store, repoRoot)
      return result
    } catch (err) {
      markConvoyCrashed(store, events, convoyId, err)
      throw err
    } finally {
      disposeInterrupts()
      progress.stop()
      events?.close()
      store.close()
      lock.release()
      if (checkout?.owned) await removeRootWorktree(repoRoot, checkout.path)
    }
  }

  async function retryFailed(convoyId: string, taskIds?: string[]): Promise<void> {
    mkdirSync(dirname(dbPath), { recursive: true })
    const store = createConvoyStore(dbPath)
    const repoRoot = await resolveRepoRoot()
    const ndjsonPath = options.logsDir
      ? join(options.logsDir, 'convoys', `${convoyId}.ndjson`)
      : ndjsonPathForConvoy(convoyId, repoRoot)
    const events = createEventEmitter(store, { ndjsonPath })
    try {
      resetForResume(store, events, convoyId, taskIds)
      store.updateConvoyStatus(convoyId, 'running', {})
    } finally {
      events.close()
      store.close()
    }
  }

  function injectTask(convoyId: string, task: {
    id: string
    prompt: string
    agent: string
    phase: number
    timeout_ms?: number
    depends_on?: string[]
    files?: string[]
    max_retries?: number
    provenance?: string
    idempotency_key?: string
    on_exhausted?: 'dlq' | 'skip' | 'stop'
  }): TaskRecord {
    mkdirSync(dirname(dbPath), { recursive: true })
    const store = createConvoyStore(dbPath)
    try {
      if (task.idempotency_key) {
        const existing = store.getTaskByIdempotencyKey(convoyId, task.idempotency_key)
        if (existing) return existing
      }

      const allTasks = store.getTasksByConvoy(convoyId)

      const injectedCount = allTasks.filter(t => t.injected === 1).length
      if (injectedCount >= 10) {
        throw new Error(`Max injectable tasks (10) reached for convoy ${convoyId}`)
      }

      if (allTasks.some(t => t.id === task.id)) {
        throw new Error(`Task ID "${task.id}" already exists in convoy ${convoyId}`)
      }

      const deps = task.depends_on ?? []
      for (const dep of deps) {
        if (!allTasks.some(t => t.id === dep)) {
          throw new Error(`Dependency "${dep}" not found in convoy ${convoyId}`)
        }
      }

      const taskFilesIn = task.files ?? []
      if (taskFilesIn.length > 0) {
        const normalizedTaskFiles = taskFilesIn.map(normalizePath)
        try {
          scanSymlinks(normalizedTaskFiles, basePath)
        } catch (err) {
          throw new Error(`Injected task "${task.id}" failed symlink check: ${(err as Error).message}`)
        }

        const activeTasks = allTasks.filter(t => t.status === 'pending' || t.status === 'running' || t.status === 'assigned')
        for (const other of activeTasks) {
          const normalizedOther = taskFiles(other)
          if (normalizedOther.length === 0) continue
          const overlapping: string[] = []
          for (const fileA of normalizedTaskFiles) {
            for (const fileB of normalizedOther) {
              if (pathsOverlap(fileA, fileB) && !overlapping.includes(fileA)) {
                overlapping.push(fileA)
              }
            }
          }
          if (overlapping.length > 0) {
            throw new Error(`File partition overlap with task "${other.id}": ${overlapping.join(', ')}`)
          }
        }
      }

      const depGraph = new Map<string, string[]>()
      for (const t of allTasks) depGraph.set(t.id, parseJsonList(t.depends_on))
      depGraph.set(task.id, deps)
      const visited = new Set<string>()
      const stack = new Set<string>()
      const hasCycle = (nodeId: string): boolean => {
        visited.add(nodeId)
        stack.add(nodeId)
        for (const dep of depGraph.get(nodeId) ?? []) {
          if (!visited.has(dep)) {
            if (hasCycle(dep)) return true
          } else if (stack.has(dep)) {
            return true
          }
        }
        stack.delete(nodeId)
        return false
      }
      for (const nodeId of depGraph.keys()) {
        if (!visited.has(nodeId) && hasCycle(nodeId)) {
          throw new Error(`Dependency cycle detected when injecting task "${task.id}"`)
        }
      }

      const record: TaskRecord = {
        id: task.id,
        convoy_id: convoyId,
        phase: task.phase,
        prompt: task.prompt,
        agent: task.agent,
        adapter: null,
        model: null,
        timeout_ms: task.timeout_ms ?? 1_800_000,
        status: 'pending',
        worker_id: null,
        worktree: null,
        output: null,
        exit_code: null,
        started_at: null,
        finished_at: null,
        retries: 0,
        max_retries: task.max_retries ?? 1,
        files: taskFilesIn.length > 0 ? JSON.stringify(taskFilesIn) : null,
        depends_on: deps.length > 0 ? JSON.stringify(deps) : null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        cost_usd: null,
        gates: null,
        on_exhausted: task.on_exhausted ?? 'dlq',
        injected: 1,
        provenance: task.provenance ?? null,
        idempotency_key: task.idempotency_key ?? null,
        current_step: null,
        total_steps: null,
        review_level: null,
        review_verdict: null,
        review_tokens: null,
        review_model: null,
        panel_attempts: 0,
        dispute_id: null,
        drift_score: null,
        drift_retried: 0,
        outputs: null,
        inputs: null,
      }

      store.insertInjectedTask(record)
      return record
    } finally {
      store.close()
    }
  }

  return { run, resume, retryFailed, injectTask }
}

/**
 * Put every unfinished task back to pending. Returns the ids it reset.
 *
 * With `taskIds`, only those and the tasks skipped because of them. A failed
 * task gets its retry budget back; an interrupted one keeps the retries it had.
 */
function resetForResume(
  store: ConvoyStore,
  events: ConvoyEventEmitter,
  convoyId: string,
  taskIds?: string[],
): string[] {
  const all = store.getTasksByConvoy(convoyId)
  let selected: Set<string> | null = null
  if (taskIds && taskIds.length > 0) {
    selected = new Set(taskIds)
    // The dependents a failure skipped come along with it.
    let grew = true
    while (grew) {
      grew = false
      for (const t of all) {
        if (selected.has(t.id) || t.status !== 'skipped') continue
        if (parseJsonList(t.depends_on).some(d => selected!.has(d))) {
          selected.add(t.id)
          grew = true
        }
      }
    }
  }
  const reset: string[] = []
  for (const task of all) {
    if (!RESUME_RESET_STATUSES.includes(task.status)) continue
    if (selected && !selected.has(task.id)) continue
    if (task.worker_id && (task.status === 'running' || task.status === 'assigned')) {
      try {
        store.updateWorkerStatus(task.worker_id, 'killed', { finished_at: new Date().toISOString() })
      } catch { /* worker record may already be absent */ }
    }
    store.updateTaskStatus(task.id, convoyId, 'pending', {
      worker_id: null,
      worktree: null,
      started_at: null,
      finished_at: null,
      ...(FAILED_STATUSES.has(task.status) ? { retries: 0 } : {}),
      ...(task.status === 'skipped' ? { retry_note: null } : {}),
    })
    if (task.status === 'disputed') {
      store.updateTaskReview(task.id, convoyId, { panel_attempts: 0 })
    }
    events.emit('task_retried', { previous_status: task.status }, { convoy_id: convoyId, task_id: task.id })
    reset.push(task.id)
  }
  return reset
}
