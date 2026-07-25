import { execFile as execFileCb } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { Task, TaskSpec, AgentAdapter, ExecuteResult, ReviewHeuristics } from '../types.js'
import { createConvoyStore, ConvoyArtifactLimitError, type ConvoyStore } from './store.js'
import { acquireEngineLock } from './lock.js'
import { createEventEmitter, ndjsonPathForConvoy, recoverNdjson, type ConvoyEventEmitter } from './events.js'
import { createWorktreeManager, type WorktreeManager } from './worktree.js'
import { createMergeQueue, MergeConflictError, type MergeQueue } from './merge.js'
import { createHealthMonitor, detectDrift } from './health.js'
import type { TaskRecord, ConvoyStatus, ConvoyTaskStatus, GuardConfig, CircuitBreakerConfig, TaskStep, Hook, TaskOutput, TaskInput, TDDGateConfig } from './types.js'
import { buildPhases, formatDuration } from '../run/executor.js'
import { parseTimeout, parseYaml } from '../run/schema.js'
import { getAdapter, detectAdapter } from '../run/adapters/index.js'
import { c } from '../prompt.js'
import { validateFilePartitions, scanSymlinks, scanNewSymlinks, normalizePath, pathsOverlap } from './partition.js'
import { scanForSecrets, runSecretScanGate, runBlastRadiusGate, browserTestGate } from './gates.js'
import { readLessons, captureLessons, consolidateLessons } from './lessons.js'
import { updateExpertise, feedCircuitBreaker } from './expertise.js'
import { buildKnowledgeGraph } from './knowledge.js'
import { injectDiscoveredIssuesInstruction, checkDiscoveredIssues, consolidateIssues } from './issues.js'
import { validateOutput, buildContractInstruction, buildContractRetryPrompt } from './contracts.js'
import { runTwoStageReview } from './review-stages.js'
import { buildIsolationPreamble, resolveDependencyResults, detectPartitionViolations } from './isolation.js'
import { checkTDD, formatTDDFailure, DEFAULT_TDD_CONFIG } from './tdd-gate.js'
import { runSkillRefinementCheck } from './skill-refinement.js'
import { getArtifactDir, extractArtifactRefs } from './artifacts.js'
import { shouldCompact, parseCompactionSummary, saveCompaction, canCompact, getMaxCompactions, generateCompactionPrompt, buildContinuationPrompt } from './compaction.js'
import { calculateCost } from './pricing.js'

const execFile = promisify(execFileCb)

/** Map agent names to their default model. Used when adapters don't report model. */
const AGENT_MODEL_MAP: Record<string, string> = {
  'developer': 'claude-sonnet-4-6',
  'ui-ux-expert': 'claude-sonnet-4-6',
  'testing-expert': 'claude-sonnet-4-6',
  'security-expert': 'claude-sonnet-4-6',
  'performance-expert': 'claude-sonnet-4-6',
  'devops-expert': 'claude-sonnet-4-6',
  'data-expert': 'claude-sonnet-4-6',
  'api-designer': 'claude-sonnet-4-6',
  'copywriter': 'claude-sonnet-4-6',
  'content-engineer': 'claude-sonnet-4-6',
  'database-engineer': 'claude-sonnet-4-6',
  'researcher': 'claude-sonnet-4-6',
  'release-manager': 'claude-sonnet-4-6',
  'architect': 'claude-opus-4-6',
  'team-lead': 'claude-opus-4-6',
  'reviewer': 'claude-haiku-3-5',
  'documentation-writer': 'claude-haiku-3-5',
  'seo-specialist': 'claude-haiku-3-5',
  'session-guard': 'claude-haiku-3-5',
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ConvoyEngineOptions {
  spec: TaskSpec
  specYaml: string
  adapter: AgentAdapter
  basePath?: string
  dbPath?: string
  logsDir?: string
  verbose?: boolean
  pipelineId?: string
  _worktreeManager?: WorktreeManager
  _mergeQueue?: MergeQueue
  /** Override for test injection. Pass `ensureBranch` for real behavior, or a mock. */
  _ensureBranch?: (branchName: string, basePath: string) => Promise<void>
  /** Pass `null` to skip convoy-level worktree creation (test mode).
   *  Pass a string path to inject a specific worktree directory.
   *  Omit (undefined) for real worktree creation.
   *  Also skipped when `_ensureBranch` is provided (backward-compat for tests). */
  _convoyWorktreeDir?: string | null
  /** Injectable for test injection of the review pipeline. */
  _reviewRunner?: (task: TaskRecord, level: ReviewLevel, reviewerModel: string) => Promise<ReviewResult>
}

export interface ConvoyResult {
  convoyId: string
  status: ConvoyStatus
  summary: { total: number; done: number; failed: number; skipped: number; timedOut: number }
  duration: string
  gateResults?: Array<{ command: string; exitCode: number; passed: boolean; output?: string }>
  cost?: { total_tokens: number; total_cost_usd?: number }
}

export interface ConvoyEngine {
  run(): Promise<ConvoyResult>
  resume(convoyId: string): Promise<ConvoyResult>
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

// ── Branch management ───────────────────────────────────────────────────────

/**
 * Ensure the given branch exists and is checked out.
 * Creates the branch from HEAD if it does not yet exist.
 * Fails fast if there are uncommitted changes.
 */
export async function ensureBranch(branchName: string, basePath: string, skipDirtyCheck = false): Promise<void> {
  // Validate refspec — reject shell metacharacters
  if (!/^[a-zA-Z0-9\-/_\.]+$/.test(branchName)) {
    throw new Error(
      `Invalid branch name "${branchName}": only alphanumeric, -, /, _, and . are allowed`,
    )
  }

  if (!skipDirtyCheck) {
    // Refuse to switch branches with uncommitted changes
    // Untracked files (??) don't block branch checkout — ignore them
    const { stdout: statusOut } = await execFile('git', ['status', '--porcelain'], {
      cwd: basePath,
    })
    const trackedChanges = statusOut
      .split('\n')
      .filter(line => line.trim() && !line.startsWith('??'))
      .join('\n')
    if (trackedChanges) {
      throw new Error(
        `Uncommitted changes detected in "${basePath}". Commit or stash before switching branches.`,
      )
    }
  }

  // Check if branch already exists
  try {
    await execFile('git', ['rev-parse', '--verify', branchName], { cwd: basePath })
    // Branch exists — check it out
    await execFile('git', ['checkout', branchName], { cwd: basePath })
  } catch {
    // Branch does not exist — create from current HEAD
    await execFile('git', ['checkout', '-b', branchName], { cwd: basePath })
  }
}

// ── Convoy guard ──────────────────────────────────────────────────────────────

export interface ConvoyGuardResult {
  passed: boolean
  warnings: string[]
}

export function runConvoyGuard(
  store: ConvoyStore,
  convoyId: string,
  _wtManager: WorktreeManager,
  ndjsonPath: string,
  guardConfig?: GuardConfig,
): ConvoyGuardResult {
  // If guard is explicitly disabled, skip all checks
  if (guardConfig?.enabled === false) {
    return { passed: true, warnings: [] }
  }

  const warnings: string[] = []
  const tasks = store.getTasksByConvoy(convoyId)

  // Check 1: All task statuses are terminal
  const terminalStatuses = new Set(['done', 'failed', 'skipped', 'timed-out', 'gate-failed', 'review-blocked', 'hook-failed', 'disputed'])
  const nonTerminal = tasks.filter(t => !terminalStatuses.has(t.status))
  if (nonTerminal.length > 0) {
    warnings.push(
      `Non-terminal tasks: ${nonTerminal.map(t => `${t.id}(${t.status})`).join(', ')}`,
    )
  }

  // Check 2: NDJSON file exists and record count >= completed task count
  const completedTasks = tasks.filter(t => t.status === 'done')
  try {
    const content = readFileSync(ndjsonPath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim())
    // Per-convoy file — all records belong to this convoy, no need to filter by convoy_id
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

  // Check 3: Every retried task has events for each attempt
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

  // Check 4: Gate results recorded for all gates that ran
  const gateEvents = events.filter(e => {
    if (e.type === 'built_in_gate_result') return true
    if (e.data == null) return false
    try {
      const parsed = JSON.parse(e.data) as Record<string, unknown>
      return 'gate' in parsed
    } catch {
      return false
    }
  })
  const tasksWithGates = tasks.filter(t => t.gates)
  if (tasksWithGates.length > 0 && gateEvents.length === 0) {
    warnings.push('Tasks have gates configured but no gate result events found')
  }

  // Check 5: Token/cost totals computed
  const convoy = store.getConvoy(convoyId)
  if (convoy && convoy.total_tokens == null) {
    const totalTokens = tasks.reduce((sum, t) => sum + (t.total_tokens ?? 0), 0)
    if (totalTokens > 0) {
      warnings.push('Convoy total_tokens not persisted despite tasks having token data')
    }
  }

  // Check 6: No orphaned worktrees — engine already calls removeAll() during cleanup.
  // Synchronous check is not possible; the engine handles this.

  return { passed: warnings.length === 0, warnings }
}

// ── Review routing ────────────────────────────────────────────────────────────

export interface DiffStats {
  linesChanged: number
  filesChanged: number
  filePaths: string[]
}

export type ReviewLevel = 'auto-pass' | 'fast' | 'panel'

export interface ReviewResult {
  verdict: 'pass' | 'block'
  feedback: string
  tokens: number
  model: string
}

export function evaluateReviewLevel(
  task: TaskRecord,
  diff: DiffStats,
  heuristics?: ReviewHeuristics,
  allGatesPassed?: boolean,
): ReviewLevel {
  const panelPaths = heuristics?.panel_paths ?? ['auth/', 'security/', 'migrations/', 'rls/']
  const panelAgents = heuristics?.panel_agents ?? ['security-expert', 'database-engineer']
  const autoPassAgents = heuristics?.auto_pass_agents ?? ['documentation-writer']
  const autoPassMaxLines = heuristics?.auto_pass_max_lines ?? 10
  const autoPassMaxFiles = heuristics?.auto_pass_max_files ?? 2

  // Panel: sensitive paths or agents
  if (panelPaths.some(p => diff.filePaths.some(fp => fp.startsWith(p) || fp.includes('/' + p)))) return 'panel'
  if (panelAgents.includes(task.agent)) return 'panel'

  // Auto-pass: documentation/copy agents
  if (autoPassAgents.includes(task.agent)) return 'auto-pass'

  // Auto-pass: small diffs with all gates passing
  if (diff.linesChanged <= autoPassMaxLines && diff.filesChanged <= autoPassMaxFiles && allGatesPassed !== false) return 'auto-pass'

  // Large diffs → fast review
  if (diff.linesChanged > 200 || diff.filesChanged > 5) return 'fast'

  // Default → fast review
  return 'fast'
}

class ReviewSemaphore {
  private current = 0
  private queue: Array<() => void> = []
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => { this.current++; resolve() })
    })
  }

  release(): void {
    this.current--
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }
}

function msToTimeout(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${ms / 1_000}s`
}

// ── DLQ markdown dual-write ───────────────────────────────────────────────────

// Builds the DLQ markdown entry text (no I/O, no scanning).
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

// Appends a pre-scanned DLQ entry to AGENT-FAILURES.md. The caller must have
// already verified the entry is clean via scanForSecrets — no re-scan here.
function appendDlqMarkdownClean(marker: string, entry: string, basePath: string): void {
  const mdPath = join(resolve(basePath), '.opencastle', 'AGENT-FAILURES.md')
  try {
    const existing = readFileSync(mdPath, 'utf8')
    if (existing.includes(marker)) return
  } catch {
    // File doesn't exist yet — will create
  }
  mkdirSync(dirname(mdPath), { recursive: true })
  appendFileSync(mdPath, entry)
}

/**
 * Marks a convoy 'failed' after an unexpected throw escapes runConvoy.
 *
 * Both run() and resume() previously wrapped runConvoy in try/finally with no
 * catch, so a crash left the row reading 'running' — which resume() then treats
 * as owned by a live engine and refuses to pick up (KI-003). Best-effort: if the
 * store is already closed or the DB is gone, the original error still wins.
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

function writeDisputeToMarkdown(
  disputeId: string,
  convoyId: string,
  task: TaskRecord,
  panelResults: ReviewResult[],
  basePath: string,
  events?: ConvoyEventEmitter | null,
): void {
  const mdPath = join(resolve(basePath), '.opencastle', 'DISPUTES.md')
  const marker = `<!-- dispute:${disputeId} -->`

  try {
    const existing = readFileSync(mdPath, 'utf8')
    if (existing.includes(marker)) return
  } catch {
    // File doesn't exist yet
  }

  const blockingReasons = panelResults
    .filter(r => r.verdict === 'block')
    .map(r => r.feedback)
    .join('\n\n')

  const entry = `\n${marker}\n## Dispute: ${task.id}\n\n| Field | Value |\n|-------|-------|\n| Convoy | ${convoyId} |\n| Task | ${task.id} |\n| Date | ${new Date().toISOString()} |\n| Panel attempts | ${task.panel_attempts + 1} |\n| Agent | ${task.agent} |\n| Status | Open |\n\n**Blocking reasons:**\n\n${blockingReasons}\n`

  const scanResult = scanForSecrets(entry, '.opencastle/DISPUTES.md')
  if (!scanResult.clean) {
    if (events) {
      events.emit(
        'secret_leak_prevented',
        {
          task_id: task.id,
          findings_count: scanResult.findings.length,
          patterns: scanResult.findings.map((f) => f.pattern),
          context: 'dispute_markdown_write',
        },
        { convoy_id: convoyId, task_id: task.id },
      )
    }
    return
  }

  mkdirSync(dirname(mdPath), { recursive: true })
  appendFileSync(mdPath, entry)
}



function taskRecordToTask(record: TaskRecord): Task {
  return {
    id: record.id,
    prompt: record.prompt,
    agent: record.agent,
    timeout: msToTimeout(record.timeout_ms),
    depends_on: record.depends_on ? (JSON.parse(record.depends_on) as string[]) : [],
    files: record.files ? (JSON.parse(record.files) as string[]) : [],
    description: '',
    model: record.model ?? undefined,
    max_retries: record.max_retries,
    adapter: record.adapter ?? undefined,
    gates: record.gates ? (JSON.parse(record.gates) as string[]) : undefined,
  }
}

function makeTimeoutPromise(ms: number): { promise: Promise<ExecuteResult>; clear: () => void } {
  let timerId: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<ExecuteResult>((res) => {
    timerId = setTimeout(
      () => res({ _timedOut: true, success: false, output: 'Task timed out', exitCode: -1 }),
      ms,
    )
  })
  return { promise, clear: () => { if (timerId !== undefined) clearTimeout(timerId) } }
}

// ── Step condition evaluation ─────────────────────────────────────────────────

function evaluateStepCondition(
  condition: TaskStep['if'],
  stepResults: Map<string, { exitCode: number }>,
  worktreePath: string | null,
  basePath: string,
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
    const base = worktreePath ?? basePath
    if (condition.fileExists.path.startsWith('/')) {
      return false // Absolute paths not allowed in step conditions
    }
    const filePath = join(base, condition.fileExists.path)
    const resolved = resolve(filePath)
    const resolvedBase = resolve(base)
    if (!resolved.startsWith(resolvedBase + '/') && resolved !== resolvedBase) {
      return false // path escapes the worktree — treat as "file doesn't exist"
    }
    if (!existsSync(filePath)) return false
  }

  return true
}

async function executeSteps(
  taskRecord: TaskRecord,
  steps: TaskStep[],
  adapter: AgentAdapter,
  worktreePath: string | null,
  basePath: string,
  store: ConvoyStore,
  convoyId: string,
  verbose: boolean,
): Promise<ExecuteResult> {
  const now = () => new Date().toISOString()
  const stepResults = new Map<string, { exitCode: number }>()
  let combinedOutput = ''
  let lastExitCode = 0

  // Track total_steps in DB
  store.updateTaskStatus(taskRecord.id, convoyId, 'running', {})

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    // Evaluate condition — skip step if condition is not met
    if (step.if) {
      const condMet = evaluateStepCondition(step.if, stepResults, worktreePath, basePath)
      if (!condMet) {
        const stepId = store.insertTaskStep({
          task_id: taskRecord.id,
          step_index: i,
          prompt: step.prompt,
          gates: step.gates ? JSON.stringify(step.gates) : null,
          status: 'skipped',
          exit_code: null,
          output: 'Skipped: condition not met',
          started_at: now(),
          finished_at: now(),
        })
        if (step.id) {
          stepResults.set(step.id, { exitCode: 0 })
        }
        combinedOutput += `\n[Step ${i + 1} skipped: condition not met]`
        continue
      }
    }

    // Insert step record as running
    const stepDbId = store.insertTaskStep({
      task_id: taskRecord.id,
      step_index: i,
      prompt: step.prompt,
      gates: step.gates ? JSON.stringify(step.gates) : null,
      status: 'running',
      exit_code: null,
      output: null,
      started_at: now(),
      finished_at: null,
    })

    // Update current_step on the task record
    store.updateTaskStatus(taskRecord.id, convoyId, 'running', {})

    const stepMaxRetries = step.max_retries ?? taskRecord.max_retries
    let stepResult: ExecuteResult = { success: false, output: '', exitCode: -1 }
    let stepAttempt = 0

    while (stepAttempt <= stepMaxRetries) {
      // Prepend prior failure context on retries
      let stepPrompt = step.prompt
      if (stepAttempt > 0 && stepResult) {
        const failedOutput = stepResult.output || '(no output)'
        stepPrompt = `Previous attempt failed.\nExit code: ${stepResult.exitCode}\nError output:\n${failedOutput}\n\nFix the issues and try again.\n\n` + step.prompt
      }

      const stepTask = {
        id: taskRecord.id,
        prompt: stepPrompt,
        agent: taskRecord.agent,
        timeout: `${taskRecord.timeout_ms}ms`,
        depends_on: [],
        files: taskRecord.files ? JSON.parse(taskRecord.files) as string[] : [],
        description: `step ${i + 1}`,
        max_retries: stepMaxRetries,
      }

      try {
        stepResult = await adapter.execute(stepTask, { verbose, cwd: worktreePath ?? basePath })
      } catch (err) {
        stepResult = { success: false, output: (err as Error).message, exitCode: -1 }
      }

      if (stepResult.success) break

      stepAttempt++
      if (stepAttempt <= stepMaxRetries) {
        process.stdout.write(`  ↺ step ${i + 1}/${steps.length} failed, retry ${stepAttempt}/${stepMaxRetries}\n`)
      }
    }

    lastExitCode = stepResult.exitCode
    combinedOutput += `\n[Step ${i + 1}]\n${stepResult.output}`

    if (step.id) {
      stepResults.set(step.id, { exitCode: stepResult.exitCode })
    }

    // Run step-level gates if present
    if (step.gates && step.gates.length > 0 && stepResult.success) {
      let gateFailure: { command: string; exitCode: number; output: string } | null = null
      const execFileCb = (await import('node:child_process')).execFile
      const execFileP = (await import('node:util')).promisify(execFileCb)
      for (const command of step.gates) {
        try {
          // SECURITY: Gate/hook commands come from the .convoy.yml spec file, which is operator-controlled.
          // They are NOT user-supplied and are part of the trusted build configuration.
          await execFileP('sh', ['-c', command], { cwd: worktreePath ?? basePath })
        } catch (gateErr) {
          const ge = gateErr as Error & { code?: unknown; stderr?: string; stdout?: string }
          const code = typeof ge.code === 'number' ? ge.code : 1
          const output = ge.stderr || ge.stdout || ge.message || ''
          gateFailure = { command, exitCode: code, output }
          break
        }
      }
      if (gateFailure !== null) {
        stepResult = { success: false, output: `Gate failed: ${gateFailure.command}\nExit code: ${gateFailure.exitCode}\n${gateFailure.output}`, exitCode: gateFailure.exitCode }
        lastExitCode = gateFailure.exitCode
        combinedOutput += `\n[Step ${i + 1} gate failed: ${gateFailure.command}]`
      }
    }

    // Update step record
    store.updateTaskStep(stepDbId, {
      status: stepResult.success ? 'done' : 'failed',
      exit_code: stepResult.exitCode,
      output: stepResult.output,
      finished_at: now(),
    })

    if (!stepResult.success) {
      return {
        success: false,
        output: combinedOutput.trim(),
        exitCode: lastExitCode,
      }
    }
  }

  return {
    success: true,
    output: combinedOutput.trim(),
    exitCode: lastExitCode,
  }
}

// ── File-based injection ──────────────────────────────────────────────────────

const INJECT_DIR = '.opencastle/convoy-inject'
const CONVOY_ID_RE = /^[a-zA-Z0-9-]+$/
const MAX_FILE_INJECTED_TASKS = 10

function pollInjectFile(
  convoyId: string,
  store: ConvoyStore,
  events: ConvoyEventEmitter,
  basePath: string,
): number {
  // Path traversal guard: convoy_id must be alphanumeric + hyphens only
  if (!CONVOY_ID_RE.test(convoyId)) return 0

  const injectDir = join(basePath, INJECT_DIR, convoyId)
  const injectPath = join(injectDir, 'inject.yml')

  if (!existsSync(injectPath)) return 0

  // Atomic rename to prevent double-read
  const processingPath = injectPath + '.processing'
  try {
    renameSync(injectPath, processingPath)
  } catch {
    return 0 // Another process may have grabbed it
  }

  let raw: string
  try {
    raw = readFileSync(processingPath, 'utf8')
  } catch {
    return 0
  } finally {
    try { unlinkSync(processingPath) } catch { /* ignore */ }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseYaml(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      process.stderr.write(`Warning: inject file has invalid format (expected { tasks: [...] })\n`)
      return 0
    }
  } catch (err) {
    process.stderr.write(`Warning: failed to parse inject file: ${(err as Error).message}\n`)
    return 0
  }

  const tasks = parsed.tasks as Array<Record<string, unknown>>
  const allExisting = store.getTasksByConvoy(convoyId)
  const existingFileInjected = allExisting.filter(t => t.provenance === 'file-injection').length
  const remaining = MAX_FILE_INJECTED_TASKS - existingFileInjected
  let injectedCount = 0

  for (const rawTask of tasks) {
    if (injectedCount >= remaining) {
      process.stderr.write(`Warning: file injection limit reached (${MAX_FILE_INJECTED_TASKS}), skipping remaining tasks\n`)
      break
    }

    // Validate required fields
    if (!rawTask.id || typeof rawTask.id !== 'string') {
      process.stderr.write(`Warning: skipping injected task with missing/invalid id\n`)
      continue
    }
    if (!rawTask.prompt || typeof rawTask.prompt !== 'string') {
      process.stderr.write(`Warning: skipping injected task "${rawTask.id}": missing prompt\n`)
      continue
    }
    if (!rawTask.agent || typeof rawTask.agent !== 'string') {
      process.stderr.write(`Warning: skipping injected task "${rawTask.id}": missing agent\n`)
      continue
    }

    // Check ID uniqueness
    if (allExisting.some(t => t.id === rawTask.id as string)) {
      process.stderr.write(`Warning: skipping injected task "${rawTask.id}": ID already exists\n`)
      continue
    }

    // Determine phase — inject into last scheduled phase
    const maxPhase = allExisting.reduce((max, t) => Math.max(max, t.phase), 0)

    // Validate file paths before building the record
    let validatedFiles: string | null = null
    if (rawTask.files && Array.isArray(rawTask.files)) {
      try {
        validatedFiles = JSON.stringify((rawTask.files as string[]).map(f => normalizePath(f as string)))
      } catch (err) {
        process.stderr.write(`Warning: skipping injected task "${rawTask.id as string}": invalid file path: ${(err as Error).message}\n`)
        continue
      }
    }

    const record: TaskRecord = {
      id: rawTask.id as string,
      convoy_id: convoyId,
      phase: maxPhase,
      prompt: rawTask.prompt as string,
      agent: rawTask.agent as string,
      adapter: null,
      model: null,
      timeout_ms: typeof rawTask.timeout_ms === 'number' ? rawTask.timeout_ms : 1_800_000,
      status: 'pending',
      worker_id: null,
      worktree: null,
      output: null,
      exit_code: null,
      started_at: null,
      finished_at: null,
      retries: 0,
      max_retries: typeof rawTask.max_retries === 'number' ? rawTask.max_retries : 1,
      files: validatedFiles,
      depends_on: null,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      cost_usd: null,
      gates: null,
      on_exhausted: 'dlq',
      injected: 1,
      provenance: 'file-injection',
      idempotency_key: null,
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
      compaction_count: 0,
      outputs: null,
      inputs: null,
      discovered_issues: null,
    }

    try {
      store.insertInjectedTask(record)
      injectedCount++
    } catch (err) {
      process.stderr.write(`Warning: failed to inject task "${rawTask.id}": ${(err as Error).message}\n`)
    }
  }

  if (injectedCount > 0) {
    events.emit('file_injection_received', {
      task_count: injectedCount,
      source: injectPath,
    }, { convoy_id: convoyId })
  }

  return injectedCount
}

// ── Core convoy execution ─────────────────────────────────────────────────────

async function runConvoy(
  convoyId: string,
  spec: TaskSpec,
  adapter: AgentAdapter,
  store: ConvoyStore,
  events: ConvoyEventEmitter,
  wtManager: WorktreeManager,
  mergeQueue: MergeQueue,
  basePath: string,
  baseBranch: string,
  verbose: boolean,
  startTime: number,
  ndjsonPath: string,
  reviewRunner?: (task: TaskRecord, level: ReviewLevel, reviewerModel: string) => Promise<ReviewResult>,
): Promise<ConvoyResult> {
  const totalTasks = spec.tasks?.length ?? 0
  let completedCount = 0
  const activeTaskMap = new Map<string, Task>()
  const reviewSemaphore = new ReviewSemaphore(spec.defaults?.max_concurrent_reviews ?? 3)
  let reviewTokensTotal = 0
  const taskAdapterMap = new Map<string, AgentAdapter>()

  const healthMonitor = createHealthMonitor({
    store,
    events,
    convoyId,
    onKill: (workerId, taskId) => {
      const task = activeTaskMap.get(taskId)
      const taskAdpt = taskAdapterMap.get(taskId) ?? adapter
      if (task && typeof taskAdpt.kill === 'function') {
        taskAdpt.kill(task)
      }
      activeTaskMap.delete(taskId)
      taskAdapterMap.delete(taskId)
    },
  })
  healthMonitor.start()

  // ── Circuit breaker ────────────────────────────────────────────────────────
  const circuitBreakerConfig = spec.defaults?.circuit_breaker
  const convoyRecord = store.getConvoy(convoyId)
  const initialCircuitState = convoyRecord?.circuit_state ? JSON.parse(convoyRecord.circuit_state) : undefined
  const circuitBreaker = new CircuitBreakerManager(circuitBreakerConfig, initialCircuitState)

  // ── Trust model ────────────────────────────────────────────────────────────
  // Gate commands, hook commands, and step commands in .convoy.yml are treated
  // as operator-controlled build configuration (analogous to Makefiles, CI
  // configs, or package.json scripts). They are executed via sh -c and must
  // NOT contain user-supplied input. The spec file itself is the trust boundary.
  // ──────────────────────────────────────────────────────────────────────────

  // ── Task skipping ─────────────────────────────────────────────────────────

  function skipTask(taskId: string, reason: string, visited: Set<string> = new Set()): void {
    if (visited.has(taskId)) return
    visited.add(taskId)
    const allTasks = store.getTasksByConvoy(convoyId)
    const task = allTasks.find(t => t.id === taskId)
    if (!task || task.status !== 'pending') return
    store.updateTaskStatus(taskId, convoyId, 'skipped', { output: reason })
    process.stdout.write(`  ${c.dim('⊘')} ${c.bold(`[${taskId}]`)} skipped\n`)
    events.emit('task_skipped', { reason }, { convoy_id: convoyId, task_id: taskId })
    for (const t of allTasks) {
      const deps = t.depends_on ? (JSON.parse(t.depends_on) as string[]) : []
      if (deps.includes(taskId)) {
        skipTask(t.id, `dependency "${taskId}" was skipped/failed`, visited)
      }
    }
  }

  function cascadeFailure(failedTaskId: string): void {
    if (spec.on_failure === 'stop') {
      const allPending = store.getTasksByConvoy(convoyId).filter(t => t.status === 'pending')
      for (const t of allPending) {
        skipTask(t.id, 'execution halted due to on_failure: stop')
      }
    } else {
      const allTasks = store.getTasksByConvoy(convoyId)
      for (const t of allTasks) {
        const deps = t.depends_on ? (JSON.parse(t.depends_on) as string[]) : []
        if (deps.includes(failedTaskId)) {
          skipTask(t.id, `dependency "${failedTaskId}" failed`)
        }
      }
    }
  }

  function handleExhaustion(taskRecord: TaskRecord, failureType: string, errorOutput: string | null): void {
    const exhausted = taskRecord.on_exhausted ?? 'dlq'

    if (exhausted === 'dlq' || exhausted === 'stop') {
      const dlqId = `dlq-${taskRecord.id}-${Date.now()}`

      // Pre-scan: build the markdown entry and check for secrets BEFORE any
      // writes. This keeps the SQLite DLQ row and the Markdown file in sync —
      // either both are written or neither is (MF-2 dual-write atomicity).
      const { marker: dlqMarker, entry: dlqMdEntry } = buildDlqMarkdownEntry(
        dlqId,
        taskRecord,
        failureType,
        errorOutput,
      )
      const dlqScanResult = scanForSecrets(dlqMdEntry, 'AGENT-FAILURES.md')

      if (!dlqScanResult.clean) {
        // Block BOTH writes to maintain consistent state
        events.emit(
          'secret_leak_prevented',
          {
            task_id: taskRecord.id,
            findings_count: dlqScanResult.findings.length,
            patterns: dlqScanResult.findings.map((f) => f.pattern),
            context: 'dlq_dual_write',
          },
          { convoy_id: convoyId, task_id: taskRecord.id },
        )
      } else {
        // Clean — proceed with both writes atomically
        store.insertDlqEntry({
          id: dlqId,
          convoy_id: convoyId,
          task_id: taskRecord.id,
          agent: taskRecord.agent,
          failure_type: failureType,
          error_output: errorOutput,
          attempts: taskRecord.retries + 1,
          tokens_spent: taskRecord.total_tokens,
          escalation_task_id: null,
          resolved: 0,
          resolution: null,
          created_at: new Date().toISOString(),
          resolved_at: null,
        })
        appendDlqMarkdownClean(dlqMarker, dlqMdEntry, basePath)
        events.emit('dlq_entry_created', {
          dlq_id: dlqId,
          task_id: taskRecord.id,
          agent: taskRecord.agent,
          failure_type: failureType,
        }, { convoy_id: convoyId, task_id: taskRecord.id })
      }
    }

    if (exhausted === 'stop') {
      // Skip all remaining pending tasks + set convoy to failed
      const allPending = store.getTasksByConvoy(convoyId).filter(t => t.status === 'pending')
      for (const t of allPending) {
        skipTask(t.id, `on_exhausted: stop — task "${taskRecord.id}" exhausted retries`)
      }
      store.updateConvoyStatus(convoyId, 'failed')
      events.emit('convoy_failed', { status: 'failed', reason: `on_exhausted: stop — task "${taskRecord.id}" exhausted retries` }, { convoy_id: convoyId })
    } else if (exhausted === 'dlq' || exhausted === 'skip') {
      // Default behavior: cascade failure to dependents only
      cascadeFailure(taskRecord.id)
    }

    // ── Circuit breaker: record exhaustion failure ──────────────────────────
    if (circuitBreakerConfig) {
      const { tripped } = circuitBreaker.recordFailure(taskRecord.agent)
      try { store.updateConvoyCircuitState(convoyId, circuitBreaker.serialize()) } catch { /* non-critical */ }
      if (tripped) {
        events.emit('circuit_breaker_tripped', {
          agent: taskRecord.agent,
          state: circuitBreaker.getState(taskRecord.agent),
        }, { convoy_id: convoyId, task_id: taskRecord.id })
      }
    }
  }

  // ── Hook execution ────────────────────────────────────────────────────────

  async function runHooks(
    hooks: Hook[],
    lifecycle: 'pre_task' | 'post_task' | 'post_convoy',
    context: { taskId?: string; convoyId: string; cwd: string },
  ): Promise<{ passed: boolean; failedHook?: Hook; error?: string }> {
    const filtered = hooks.filter(h => (h.on ?? 'post_task') === lifecycle)
    for (const hook of filtered) {
      if (hook.type === 'command' || hook.type === 'guard' || hook.type === 'validate') {
        const cmd = hook.command
        if (!cmd) continue
        try {
          // SECURITY: Gate/hook commands come from the .convoy.yml spec file, which is operator-controlled.
          // They are NOT user-supplied and are part of the trusted build configuration.
          await execFile('sh', ['-c', cmd], { cwd: context.cwd })
        } catch (err) {
          const execErr = err as Error & { stderr?: string; stdout?: string }
          const errorMsg = execErr.stderr || execErr.stdout || execErr.message || ''
          return { passed: false, failedHook: hook, error: errorMsg }
        }
      } else if (hook.type === 'agent') {
        if (!hook.prompt) continue
        const hookTask: Task = {
          id: `hook-${lifecycle}-${context.taskId ?? 'convoy'}-${Date.now()}`,
          prompt: hook.prompt,
          agent: hook.name ?? 'developer',
          timeout: '10m',
          depends_on: [],
          files: [],
          description: `Hook: ${hook.name ?? hook.type}`,
          max_retries: 0,
        }
        try {
          const hookResult = await adapter.execute(hookTask, { verbose, cwd: context.cwd })
          if (!hookResult.success) {
            return { passed: false, failedHook: hook, error: hookResult.output }
          }
        } catch (err) {
          return { passed: false, failedHook: hook, error: (err as Error).message }
        }
      } else if (hook.type === 'review') {
        if (!context.taskId || !reviewRunner) continue
        const reviewTaskRecord = store.getTask(context.taskId, context.convoyId)
        if (reviewTaskRecord) {
          const reviewResult = await reviewRunner(
            reviewTaskRecord,
            'fast',
            spec.defaults?.reviewer_model ?? 'default',
          )
          if (reviewResult.verdict !== 'pass') {
            return { passed: false, failedHook: hook, error: reviewResult.feedback }
          }
        }
      }
    }
    return { passed: true }
  }

  // ── Single-task executor ──────────────────────────────────────────────────

  async function executeOneTask(taskRecord: TaskRecord): Promise<void> {
    const workerId = `worker-${taskRecord.id}-${Date.now()}`
    const now = () => new Date().toISOString()

    // Resolve per-task adapter (fallback to convoy-level adapter)
    let taskAdapter: AgentAdapter = adapter
    if (taskRecord.adapter && taskRecord.adapter !== adapter.name) {
      if (taskRecord.adapter === 'auto') {
        const detected = await detectAdapter()
        if (detected) {
          taskAdapter = await getAdapter(detected)
        }
      } else {
        taskAdapter = await getAdapter(taskRecord.adapter)
      }
    }
    taskAdapterMap.set(taskRecord.id, taskAdapter)

    // ── Check inputs availability ────────────────────────────────────────────
    if (taskRecord.inputs) {
      const inputs: TaskInput[] = JSON.parse(taskRecord.inputs)
      for (const input of inputs) {
        const artifact = store.getArtifact(convoyId, input.name)
        if (!artifact) {
          store.updateTaskStatus(taskRecord.id, convoyId, 'wait-for-input')
          events.emit('task_waiting_input', {
            task_id: taskRecord.id,
            missing_artifact: input.name,
            from_task: input.from,
          }, { convoy_id: convoyId, task_id: taskRecord.id })
          taskAdapterMap.delete(taskRecord.id)
          return
        }
      }
    }

    // ── Circuit breaker check ──────────────────────────────────────────────
    if (circuitBreakerConfig) {
      if (!circuitBreaker.canAssign(taskRecord.agent)) {
        const fallback = circuitBreaker.fallback
        if (fallback) {
          events.emit('circuit_breaker_fallback', {
            original_agent: taskRecord.agent,
            fallback_agent: fallback,
            state: circuitBreaker.getState(taskRecord.agent),
          }, { convoy_id: convoyId, task_id: taskRecord.id })
        } else {
          events.emit('circuit_breaker_blocked', {
            agent: taskRecord.agent,
            state: circuitBreaker.getState(taskRecord.agent),
          }, { convoy_id: convoyId, task_id: taskRecord.id })
        }
        store.updateTaskStatus(taskRecord.id, convoyId, 'skipped', {
          output: `Circuit breaker open for agent "${taskRecord.agent}". ${fallback ? `No fallback available.` : `No fallback configured.`}`,
        })
        completedCount++
        taskAdapterMap.delete(taskRecord.id)
        cascadeFailure(taskRecord.id)
        return
      }
    }

    // ── Intelligence: circuit breaker weak-area avoidance (Phase 18.2) ─────
    if (spec.defaults?.avoid_weak_agents) {
      try {
        const weakAreas = feedCircuitBreaker(taskRecord.agent, basePath)
        const taskFiles = taskRecord.files ? JSON.parse(taskRecord.files) as string[] : []
        const matchesWeakArea = weakAreas.some(area =>
          taskFiles.some(f => f.toLowerCase().includes(area.toLowerCase()))
        )
        if (matchesWeakArea && taskRecord.retries === 0) {
          events.emit('weak_area_skipped', { agent: taskRecord.agent, weak_areas: weakAreas, task_files: taskFiles }, { convoy_id: convoyId, task_id: taskRecord.id })
          store.updateTaskStatus(taskRecord.id, convoyId, 'skipped', { output: `Agent "${taskRecord.agent}" has weak-area match for task files. Skipped by avoid_weak_agents policy.` })
          completedCount++
          taskAdapterMap.delete(taskRecord.id)
          return
        }
      } catch { /* non-critical */ }
    }

    // Create worktree (skip for copilot adapter)
    let worktreePath: string | null = null
    if (taskAdapter.name !== 'copilot') {
      try {
        worktreePath = await wtManager.create(workerId, baseBranch)
      } catch (err) {
        if (verbose) {
          process.stderr.write(
            `Warning: failed to create worktree for ${taskRecord.id}: ${(err as Error).message}\n`,
          )
        }
      }
    }

    store.insertWorker({
      id: workerId,
      task_id: taskRecord.id,
      adapter: taskAdapter.name,
      pid: null,
      session_id: null,
      status: 'spawned',
      worktree: worktreePath,
      created_at: now(),
    })

    // Mark assigned then running
    store.updateTaskStatus(taskRecord.id, convoyId, 'assigned', {
      worker_id: workerId,
      worktree: worktreePath,
    })
    store.updateTaskStatus(taskRecord.id, convoyId, 'running', { started_at: now() })
    store.updateWorkerStatus(workerId, 'running')

    const task = taskRecordToTask(taskRecord)
    activeTaskMap.set(taskRecord.id, task)

    // ── Inject inputs into prompt ────────────────────────────────────────────
    if (taskRecord.inputs) {
      const inputs: TaskInput[] = JSON.parse(taskRecord.inputs)
      for (const input of inputs) {
        const artifact = store.getArtifact(convoyId, input.name)!
        const templateVar = input.as ?? input.name
        task.prompt = task.prompt.replaceAll(`{{input.${templateVar}}}`, artifact.content)
      }
    }

    // ── Scratchpad template substitution (Phase 17.1) ───────────────────────
    const scratchpadRe = /\{\{scratchpad\.([a-zA-Z0-9_.-]+)\}\}/g
    let scratchpadMatch: RegExpExecArray | null
    while ((scratchpadMatch = scratchpadRe.exec(task.prompt)) !== null) {
      const spKey = scratchpadMatch[1]
      const spVal = store.getScratchpadValue(spKey)
      if (spVal !== null) {
        task.prompt = task.prompt.replaceAll(`{{scratchpad.${spKey}}}`, spVal)
        scratchpadRe.lastIndex = 0 // reset after replaceAll
      }
    }

    process.stdout.write(`  ${c.cyan('▶')} ${c.bold(`[${taskRecord.id}]`)} ${taskRecord.agent}${worktreePath ? c.dim(' (worktree)') : ''}\n`)
    events.emit(
      'task_started',
      { worker_id: workerId, mechanism: worktreePath ? 'background' : 'sub-agent' },
      { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
    )

    const taskStartTime = Date.now()

    // ── Outbound prompt scan — NEVER send a prompt containing secrets ─────────
    const promptScan = scanForSecrets(taskRecord.prompt, `task:${taskRecord.id}`)
    if (!promptScan.clean) {
      store.updateTaskStatus(taskRecord.id, convoyId, 'failed', {
        finished_at: now(),
        output: `Secret detected in prompt — task blocked before execution.\nFindings:\n${
          promptScan.findings
            .map((f) => `  ${f.pattern} at line ${f.line}: ${f.snippet}`)
            .join('\n')
        }`,
      })
      store.updateWorkerStatus(workerId, 'failed', { finished_at: now() })
      completedCount++
      events.emit(
        'secret_leak_prevented',
        {
          task_id: taskRecord.id,
          findings_count: promptScan.findings.length,
          patterns: promptScan.findings.map((f) => f.pattern),
        },
        { convoy_id: convoyId, task_id: taskRecord.id },
      )
      cascadeFailure(taskRecord.id)
      taskAdapterMap.delete(taskRecord.id)
      return
    }

    const timeout = makeTimeoutPromise(taskRecord.timeout_ms)
    let result: ExecuteResult

    // Retrieve steps from spec if defined
    const specTask = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
    const steps: TaskStep[] | undefined = specTask?.steps
    const taskHooks: Hook[] = specTask?.hooks ?? []

    // ── Context isolation preamble (Phase 41) ────────────────────────────
    try {
      const taskFiles = taskRecord.files ? JSON.parse(taskRecord.files) as string[] : []
      const depIds = taskRecord.depends_on ? JSON.parse(taskRecord.depends_on) as string[] : []
      const depResults = resolveDependencyResults(store, convoyId, depIds)
      const preamble = buildIsolationPreamble(
        { id: taskRecord.id, description: taskRecord.prompt.slice(0, 200), prompt: taskRecord.prompt, files: taskFiles, agent: taskRecord.agent },
        depResults,
      )
      task.prompt = preamble + '\n\n' + task.prompt
    } catch { /* non-critical — isolation preamble is best-effort */ }

    // ── Artifact output instructions (Phase 43) ────────────────────────────
    try {
      const artifactDir = getArtifactDir(convoyId, taskRecord.id, basePath)
      const artifactInstructions = [
        '',
        '## Artifact Output (for large results)',
        'If your output includes large content (>100 lines of code, full reports, data dumps),',
        'write it to an artifact file instead of including it inline:',
        '',
        '1. Write the content to: ' + artifactDir + '{filename}',
        '2. In your response, reference it: `[ARTIFACT: {filename}] {1-line summary}`',
        '3. Keep your inline response focused on the summary and key decisions.',
        '',
        'Small outputs (< 100 lines) can remain inline.',
      ].join('\n')
      task.prompt = task.prompt + '\n' + artifactInstructions
    } catch { /* non-critical */ }

    // ── Intelligence: inject lessons (Phase 18.1) ─────────────────────────
    if (spec.defaults?.inject_lessons !== false) {
      try {
        const taskFiles = taskRecord.files ? JSON.parse(taskRecord.files) as string[] : []
        const lessons = readLessons(taskRecord.agent, taskFiles, basePath)
        if (lessons.length > 0) {
          const lessonsBlock
            = '\n\n---\nRelevant lessons from previous sessions:\n'
            + lessons.join('\n\n')
            + '\n---\n\n'
          task.prompt = lessonsBlock + task.prompt
        }
      } catch { /* non-critical */ }
    }
    // ── Intelligence: inject persistent agent identity (Phase 17.2) ────────
    const specTaskForPersistent = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
    if (specTaskForPersistent?.persistent) {
      try {
        const identities = store.getAgentIdentities(taskRecord.agent, 3)
        if (identities.length > 0) {
          const contextBlock = '\n\n[Previous work context]\n'
            + identities.map(id => id.summary).join('\n\n')
            + '\n[End previous context]\n\n'
          task.prompt = contextBlock + task.prompt
        }
      } catch { /* non-critical */ }
    }
    // ── Intelligence: inject discovered issues instruction (Phase 18.4) ────
    if (spec.defaults?.track_discovered_issues) {
      task.prompt = injectDiscoveredIssuesInstruction(task.prompt)
    }

    // ── Output contract injection ─────────────────────────────────────────
    const contractInstruction = buildContractInstruction(taskRecord.agent)
    if (contractInstruction) {
      task.prompt = task.prompt + '\n\n' + contractInstruction
    }

    // ── pre_task hooks ────────────────────────────────────────────────────────
    if (taskHooks.length > 0) {
      const preResult = await runHooks(taskHooks, 'pre_task', {
        taskId: taskRecord.id,
        convoyId,
        cwd: worktreePath ?? basePath,
      })
      if (!preResult.passed) {
        await removeWorktree()
        const hookLabel = preResult.failedHook?.name ?? preResult.failedHook?.type ?? 'unknown'
        store.withTransaction(() => {
          store.updateTaskStatus(taskRecord.id, convoyId, 'hook-failed', {
            finished_at: now(),
            output: `pre_task hook "${hookLabel}" failed: ${preResult.error ?? ''}`,
            exit_code: 1,
          })
          store.updateWorkerStatus(workerId, 'failed', { finished_at: now() })
        })
        completedCount++
        process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} pre_task hook failed ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
        events.emit('task_failed', { reason: 'hook-failed', hook: hookLabel, worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
        cascadeFailure(taskRecord.id)
        taskAdapterMap.delete(taskRecord.id)
        return
      }
    }

    // ── Symlink security scan (pre-execution) ────────────────────────────────
    const taskFiles = taskRecord.files ? JSON.parse(taskRecord.files) as string[] : []
    if (taskFiles.length > 0 && worktreePath) {
      try {
        scanSymlinks(taskFiles, worktreePath)
      } catch (err) {
        await removeWorktree()
        store.withTransaction(() => {
          store.updateTaskStatus(taskRecord.id, convoyId, 'failed', {
            finished_at: now(),
            output: `Symlink security check failed: ${(err as Error).message}`,
            exit_code: 1,
          })
          store.updateWorkerStatus(workerId, 'failed', { finished_at: now() })
        })
        completedCount++
        events.emit('task_failed', { reason: 'symlink-escape', worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
        cascadeFailure(taskRecord.id)
        taskAdapterMap.delete(taskRecord.id)
        return
      }
    }

    try {
      if (steps && steps.length > 0) {
        result = await Promise.race([
          executeSteps(taskRecord, steps, taskAdapter, worktreePath, basePath, store, convoyId, verbose),
          timeout.promise,
        ])
      } else {
        result = await Promise.race([
          taskAdapter.execute(task, { verbose, cwd: worktreePath ?? basePath }),
          timeout.promise,
        ])
      }
      timeout.clear()
    } catch (err) {
      timeout.clear()
      result = { success: false, output: (err as Error).message, exitCode: -1 }
    }

    activeTaskMap.delete(taskRecord.id)
    const finishedAt = now()
    const elapsed = `(${formatDuration(Date.now() - taskStartTime)})`

    async function removeWorktree(): Promise<void> {
      if (worktreePath) {
        try { await wtManager.remove(worktreePath) } catch { /* ignore cleanup errors */ }
      }
    }

    // ── Timed out ───────────────────────────────────────────────────────────
    if (result._timedOut) {
      if (typeof taskAdapter.kill === 'function') taskAdapter.kill(task)
      await removeWorktree()

      const freshRecord = store.getTask(taskRecord.id, convoyId)!
      if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
        const contextPrefix = `Previous attempt timed out.\n\nFix the issues and try again.\n\n`
        store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
          retries: freshRecord.retries + 1,
          worker_id: null,
          worktree: null,
          started_at: null,
          finished_at: null,
          prompt: contextPrefix + taskRecord.prompt,
        })
        store.updateWorkerStatus(workerId, 'killed', { finished_at: finishedAt })
        process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} timed out, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`)
      } else {
        // Estimate tokens even for timed-out tasks — you still paid for them
        const estimatedPrompt = Math.ceil(taskRecord.prompt.length / 4)
        const estimatedCompletion = Math.ceil((result.output?.length ?? 0) / 4)
        const timeoutModel = taskRecord.model ?? AGENT_MODEL_MAP[taskRecord.agent.toLowerCase()] ?? taskAdapter.name
        const timeoutCost = calculateCost(timeoutModel, estimatedPrompt, estimatedCompletion)
        store.withTransaction(() => {
          store.updateTaskStatus(taskRecord.id, convoyId, 'timed-out', {
            finished_at: finishedAt,
            output: result.output,
            prompt_tokens: estimatedPrompt,
            completion_tokens: estimatedCompletion,
            total_tokens: estimatedPrompt + estimatedCompletion,
            model: timeoutModel,
            cost_usd: timeoutCost,
          })
          store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
        })
        completedCount++
        process.stdout.write(`  ${c.red('⏱')} ${c.bold(`[${taskRecord.id}]`)} timed out ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
        events.emit(
          'task_failed',
          { reason: 'timeout', worker_id: workerId },
          { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
        )
        events.emit('session', {
          agent: taskRecord.agent,
          model: taskRecord.model ?? taskAdapter.name,
          task: taskRecord.id,
          outcome: 'failed',
          duration_min: Math.round((Date.now() - taskStartTime) / 60_000),
          files_changed: 0,
          retries: freshRecord.retries,
          convoy_id: convoyId,
        }, { convoy_id: convoyId, task_id: taskRecord.id })
        events.emit('delegation', {
          session_id: convoyId,
          agent: taskRecord.agent,
          model: taskRecord.model ?? taskAdapter.name,
          tier: 'standard',
          mechanism: 'convoy',
          outcome: 'failed',
          retries: freshRecord.retries,
          phase: taskRecord.phase,
          convoy_id: convoyId,
        }, { convoy_id: convoyId, task_id: taskRecord.id })
        handleExhaustion(freshRecord, 'timeout', result.output || null)
      }
      taskAdapterMap.delete(taskRecord.id)
      return
    }

    // ── Success ─────────────────────────────────────────────────────────────
    if (result.success) {      // ── Per-task gates ─────────────────────────────────────────────────────
      const taskGates = taskRecord.gates ? (JSON.parse(taskRecord.gates) as string[]) : []
      if (taskGates.length > 0) {
        let gateFailure: { command: string; exitCode: number; output: string } | null = null
        for (const command of taskGates) {
          try {
            // SECURITY: Gate/hook commands come from the .convoy.yml spec file, which is operator-controlled.
            // They are NOT user-supplied and are part of the trusted build configuration.
            await execFile('sh', ['-c', command], { cwd: worktreePath ?? basePath, maxBuffer: 10 * 1024 * 1024 })
          } catch (err) {
            const execErr = err as Error & { code?: unknown; stderr?: string; stdout?: string }
            const code = typeof execErr.code === 'number' ? execErr.code : 1
            const output = [execErr.stderr, execErr.stdout].filter(Boolean).join('\n').trim() || execErr.message || ''
            gateFailure = { command, exitCode: code, output }
            break
          }
        }

        if (gateFailure !== null) {
          await removeWorktree()
          const freshRecord = store.getTask(taskRecord.id, convoyId)!
          if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
            const contextPrefix = `Previous attempt's gate check failed.\nGate: ${gateFailure.command}\nExit code: ${gateFailure.exitCode}\nOutput:\n${gateFailure.output || '(no output)'}\n\nFix the issues and try again.\n\n`
            store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
              retries: freshRecord.retries + 1,
              worker_id: null,
              worktree: null,
              started_at: null,
              finished_at: null,
              prompt: contextPrefix + taskRecord.prompt,
            })
            store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
            process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} gate failed, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`)
          } else {
            store.withTransaction(() => {
              store.updateTaskStatus(taskRecord.id, convoyId, 'gate-failed', {
                finished_at: finishedAt,
                output: `Gate failed: ${gateFailure!.command}\nExit code: ${gateFailure!.exitCode}\n${gateFailure!.output}`,
                exit_code: gateFailure!.exitCode,
              })
              store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
            })
            completedCount++
            process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} gate failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
            events.emit(
              'task_failed',
              { reason: 'gate-failed', gate: gateFailure.command, exit_code: gateFailure.exitCode, worker_id: workerId },
              { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
            )
            events.emit('session', {
              agent: taskRecord.agent,
              model: taskRecord.model ?? taskAdapter.name,
              task: taskRecord.id,
              outcome: 'failed',
              duration_min: Math.round((Date.now() - taskStartTime) / 60_000),
              files_changed: 0,
              retries: freshRecord.retries,
              convoy_id: convoyId,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
            events.emit('delegation', {
              session_id: convoyId,
              agent: taskRecord.agent,
              model: taskRecord.model ?? taskAdapter.name,
              tier: 'standard',
              mechanism: 'convoy',
              outcome: 'failed',
              retries: freshRecord.retries,
              phase: taskRecord.phase,
              convoy_id: convoyId,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
            handleExhaustion(freshRecord, 'gate-failed', gateFailure!.output || null)
          }
          taskAdapterMap.delete(taskRecord.id)
          return
        }
      }

      // ── Built-in gates ────────────────────────────────────────────────────
      const builtInGates = spec.defaults?.built_in_gates
      if (builtInGates && worktreePath) {
        if (builtInGates.browser_test) {
          const specTask = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
          const taskBrowserConfig = specTask?.browser_test ?? spec.defaults?.browser_test
          if (!taskBrowserConfig) {
            process.stderr.write(
              `Warning: browser_test gate enabled but no browser_test config (urls) found — skipping\n`,
            )
          } else {
            const browserResult = await browserTestGate({
              mcpServers: spec.defaults?.mcp_servers ?? [],
              taskConfig: taskBrowserConfig,
              worktreePath,
              approvalTimeout: spec.defaults?.mcp_server_approval_timeout,
            })
            events.emit(
              'built_in_gate_result',
              { gate: 'browser_test', passed: browserResult.passed, output: browserResult.output },
              { convoy_id: convoyId, task_id: taskRecord.id },
            )
            if (!browserResult.passed) {
              await removeWorktree()
              const freshRecord = store.getTask(taskRecord.id, convoyId)!
              if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
                store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
                  retries: freshRecord.retries + 1,
                  worker_id: null,
                  worktree: null,
                  started_at: null,
                  finished_at: null,
                })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
                process.stdout.write(
                  `  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} browser test gate failed, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`,
                )
              } else {
                store.withTransaction(() => {
                  store.updateTaskStatus(taskRecord.id, convoyId, 'gate-failed', {
                    finished_at: finishedAt,
                    output: `Built-in gate (browser_test) failed:\n${browserResult.output}`,
                    exit_code: 1,
                  })
                  store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
                })
                completedCount++
                process.stdout.write(
                  `  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} browser test gate failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`,
                )
                events.emit(
                  'task_failed',
                  { reason: 'gate-failed', gate: 'browser_test', worker_id: workerId },
                  { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
                )
                handleExhaustion(freshRecord, 'browser-test', browserResult.output)
              }
              taskAdapterMap.delete(taskRecord.id)
              return
            }
          }
        }

        let changedFiles: string[] = []
        let diff = ''
        try {
          const { stdout: filesOut } = await execFile(
            'git', ['diff', '--name-only', `${baseBranch}..HEAD`],
            { cwd: worktreePath },
          )
          changedFiles = filesOut.split('\n').filter(Boolean)
          const { stdout: diffOut } = await execFile(
            'git', ['diff', `${baseBranch}..HEAD`],
            { cwd: worktreePath },
          )
          diff = diffOut
        } catch { /* no commits in worktree yet — skip */ }

        // Secret scan gate
        if (builtInGates.secret_scan && changedFiles.length > 0) {
          const scanResult = await runSecretScanGate(changedFiles, worktreePath)
          events.emit(
            'built_in_gate_result',
            { gate: 'secret_scan', passed: scanResult.passed, output: scanResult.output },
            { convoy_id: convoyId, task_id: taskRecord.id },
          )
          if (!scanResult.passed) {
            await removeWorktree()
            const freshRecord = store.getTask(taskRecord.id, convoyId)!
            if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
              store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
                retries: freshRecord.retries + 1,
                worker_id: null,
                worktree: null,
                started_at: null,
                finished_at: null,
                prompt: `Secret scan gate failed.\n${scanResult.output}\n\nFix the issues and try again.\n\n${taskRecord.prompt}`,
              })
              store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              process.stdout.write(
                `  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} secret scan gate failed, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`,
              )
            } else {
              store.withTransaction(() => {
                store.updateTaskStatus(taskRecord.id, convoyId, 'gate-failed', {
                  finished_at: finishedAt,
                  output: `Built-in gate (secret_scan) failed:\n${scanResult.output}`,
                  exit_code: 1,
                })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              })
              completedCount++
              process.stdout.write(
                `  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} secret scan gate failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`,
              )
              events.emit(
                'task_failed',
                { reason: 'gate-failed', gate: 'secret_scan', worker_id: workerId },
                { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
              )
              handleExhaustion(freshRecord, 'secret-scan', scanResult.output)
            }
            taskAdapterMap.delete(taskRecord.id)
            return
          }
        }

        // Blast radius gate
        if (builtInGates.blast_radius && diff) {
          const blastResult = runBlastRadiusGate(diff)
          events.emit(
            'built_in_gate_result',
            { gate: 'blast_radius', level: blastResult.level, passed: blastResult.passed, output: blastResult.output },
            { convoy_id: convoyId, task_id: taskRecord.id },
          )
          if (!blastResult.passed) {
            await removeWorktree()
            const freshRecord = store.getTask(taskRecord.id, convoyId)!
            if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
              store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
                retries: freshRecord.retries + 1,
                worker_id: null,
                worktree: null,
                started_at: null,
                finished_at: null,
                prompt: `Blast radius gate failed.\n${blastResult.output}\n\nFix the issues and try again.\n\n${taskRecord.prompt}`,
              })
              store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              process.stdout.write(
                `  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} blast radius gate failed, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`,
              )
            } else {
              store.withTransaction(() => {
                store.updateTaskStatus(taskRecord.id, convoyId, 'gate-failed', {
                  finished_at: finishedAt,
                  output: `Built-in gate (blast_radius) failed:\n${blastResult.output}`,
                  exit_code: 1,
                })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              })
              completedCount++
              process.stdout.write(
                `  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} blast radius gate failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`,
              )
              events.emit(
                'task_failed',
                { reason: 'gate-failed', gate: 'blast_radius', worker_id: workerId },
                { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
              )
              handleExhaustion(freshRecord, 'gate-failed', blastResult.output)
            }
            taskAdapterMap.delete(taskRecord.id)
            return
          }
        }

        // ── Partition violation check (Phase 41) ────────────────────────────
        if (changedFiles.length > 0) {
          try {
            const taskFiles = taskRecord.files ? JSON.parse(taskRecord.files) as string[] : []
            if (taskFiles.length > 0) {
              const violation = detectPartitionViolations(taskRecord.id, taskFiles, changedFiles)
              if (violation) {
                events.emit('partition_violation', {
                  task_id: taskRecord.id,
                  allowed: violation.allowedFiles,
                  actual: violation.actualFiles,
                  violations: violation.violations,
                }, { convoy_id: convoyId, task_id: taskRecord.id })
                process.stdout.write(`  ${c.yellow('⚠')} ${c.bold(`[${taskRecord.id}]`)} partition violation: ${violation.violations.join(', ')}\n`)
              }
            }
          } catch { /* non-critical */ }
        }

        // ── TDD gate ──────────────────────────────────────────────────────────
        if (builtInGates.tdd_check && changedFiles.length > 0) {
          const tddConfig: TDDGateConfig = typeof builtInGates.tdd_check === 'object'
            ? { ...DEFAULT_TDD_CONFIG, ...builtInGates.tdd_check }
            : DEFAULT_TDD_CONFIG
          const specTaskForTDD = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
          const tddResult = checkTDD(changedFiles, changedFiles, tddConfig, specTaskForTDD?.agent ?? taskRecord.agent)

          if (tddResult.skipped) {
            events.emit('tdd_check_skipped', {
              task_id: taskRecord.id,
              reason: tddResult.skip_reason,
              agent: specTaskForTDD?.agent ?? taskRecord.agent,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
          } else if (tddResult.passed) {
            events.emit('tdd_check_passed', {
              task_id: taskRecord.id,
              new_source_files: tddResult.new_source_files.length,
              existing_test_files: tddResult.existing_test_files.length,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
          } else {
            const failureMsg = formatTDDFailure(tddResult)
            events.emit('tdd_check_failed', {
              task_id: taskRecord.id,
              missing_test_files: tddResult.missing_test_files,
              new_source_files: tddResult.new_source_files.length,
            }, { convoy_id: convoyId, task_id: taskRecord.id })

            if (tddConfig.mode === 'block') {
              await removeWorktree()
              const freshRecord = store.getTask(taskRecord.id, convoyId)!
              if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
                store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
                  retries: freshRecord.retries + 1,
                  worker_id: null,
                  worktree: null,
                  started_at: null,
                  finished_at: null,
                  prompt: `TDD gate failed.\n${failureMsg}\n\nCreate the missing test files and try again.\n\n${taskRecord.prompt}`,
                })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
                process.stdout.write(
                  `  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} TDD gate failed, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`,
                )
              } else {
                store.withTransaction(() => {
                  store.updateTaskStatus(taskRecord.id, convoyId, 'gate-failed', {
                    finished_at: finishedAt,
                    output: `Built-in gate (tdd_check) failed:\n${failureMsg}`,
                    exit_code: 1,
                  })
                  store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
                })
                completedCount++
                process.stdout.write(
                  `  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} TDD gate failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`,
                )
                events.emit(
                  'task_failed',
                  { reason: 'gate-failed', gate: 'tdd_check', worker_id: workerId },
                  { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
                )
                handleExhaustion(freshRecord, 'tdd-check', failureMsg)
              }
              taskAdapterMap.delete(taskRecord.id)
              return
            } else {
              // warn mode — log but continue
              process.stdout.write(
                `  ${c.yellow('⚠')} ${c.bold(`[${taskRecord.id}]`)} TDD gate warning: ${tddResult.missing_test_files.length} source file(s) without tests\n`,
              )
            }
          }
        }
      }

      // ── Drift detection ──────────────────────────────────────────────────
      const specTaskForDrift = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
      const isDriftEnabled = specTaskForDrift?.detect_drift ?? spec.defaults?.detect_drift ?? false

      if (isDriftEnabled && taskRecord.drift_retried === 0) {
        const driftResult = await detectDrift(taskRecord, taskAdapter)

        events.emit('drift_check_result', {
          task_id: taskRecord.id,
          score: driftResult.score,
          threshold: driftResult.threshold,
          explanation: driftResult.explanation,
          drifted: driftResult.drifted,
        }, { convoy_id: convoyId, task_id: taskRecord.id })

        store.updateTaskDrift(taskRecord.id, convoyId, { drift_score: driftResult.score })

        if (driftResult.drifted) {
          events.emit('drift_detected', {
            task_id: taskRecord.id,
            score: driftResult.score,
            threshold: driftResult.threshold,
          }, { convoy_id: convoyId, task_id: taskRecord.id })

          await removeWorktree()
          store.updateTaskDrift(taskRecord.id, convoyId, { drift_retried: 1 })
          store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
            worker_id: null,
            worktree: null,
            started_at: null,
            finished_at: null,
          })
          store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
          process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} drift detected (score: ${driftResult.score.toFixed(2)}), retrying\n`)
          taskAdapterMap.delete(taskRecord.id)
          return
        }
      }

      // ── Review pipeline ──────────────────────────────────────────────────
      const specTaskForReview = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
      const taskReviewSetting: string = specTaskForReview?.review ?? spec.defaults?.review ?? 'auto'

      if (taskReviewSetting !== 'none') {
        // Compute diff stats from worktree
        let reviewChangedFiles: string[] = []
        let reviewDiffLines = 0

        if (worktreePath) {
          try {
            const { stdout: filesOut } = await execFile(
              'git', ['diff', '--name-only', `${baseBranch}..HEAD`],
              { cwd: worktreePath },
            )
            reviewChangedFiles = filesOut.split('\n').filter(Boolean)
            const { stdout: diffOut } = await execFile(
              'git', ['diff', `${baseBranch}..HEAD`],
              { cwd: worktreePath },
            )
            reviewDiffLines = diffOut.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).filter(l => !l.startsWith('+++') && !l.startsWith('---')).length
          } catch { /* no commits yet */ }
        }

        const diffStats: DiffStats = {
          linesChanged: reviewDiffLines,
          filesChanged: reviewChangedFiles.length,
          filePaths: reviewChangedFiles,
        }

        // Determine review level
        let reviewLevel: ReviewLevel
        if (taskReviewSetting === 'fast') {
          reviewLevel = 'fast'
        } else if (taskReviewSetting === 'panel') {
          reviewLevel = 'panel'
        } else {
          reviewLevel = evaluateReviewLevel(taskRecord, diffStats, spec.defaults?.review_heuristics, true)
        }

        const reviewerModel = spec.defaults?.reviewer_model ?? 'default'
        events.emit('review_started', { level: reviewLevel, task_id: taskRecord.id, model: reviewerModel }, { convoy_id: convoyId, task_id: taskRecord.id })

        if (reviewLevel === 'auto-pass') {
          store.updateTaskReview(taskRecord.id, convoyId, {
            review_level: 'auto-pass',
            review_verdict: 'pass',
            review_tokens: 0,
            review_model: reviewerModel,
          })
          events.emit('review_verdict', { level: 'auto-pass', verdict: 'pass', tokens: 0, model: reviewerModel, feedback_length: 0 }, { convoy_id: convoyId, task_id: taskRecord.id })
        } else if (reviewLevel === 'fast') {
          // Check review budget
          const reviewBudget = spec.defaults?.review_budget
          const onBudgetExceeded = spec.defaults?.on_review_budget_exceeded ?? 'skip'

          if (reviewBudget != null && reviewTokensTotal >= reviewBudget) {
            if (onBudgetExceeded === 'stop') {
              const allPending = store.getTasksByConvoy(convoyId).filter(t => t.status === 'pending')
              for (const t of allPending) skipTask(t.id, 'review_budget exceeded with on_review_budget_exceeded: stop')
              store.withTransaction(() => {
                store.updateTaskStatus(taskRecord.id, convoyId, 'review-blocked', { finished_at: finishedAt, output: 'Review budget exceeded', exit_code: 1 })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              })
              completedCount++
              process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} review budget exceeded (stop) ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
              events.emit('review_verdict', { level: 'fast', verdict: 'skip', tokens: 0, model: reviewerModel, feedback_length: 0, budget_exceeded: true }, { convoy_id: convoyId, task_id: taskRecord.id })
              taskAdapterMap.delete(taskRecord.id)
              return
            } else if (onBudgetExceeded === 'downgrade') {
              store.updateTaskReview(taskRecord.id, convoyId, { review_level: 'fast', review_verdict: 'pass', review_tokens: 0, review_model: reviewerModel })
              events.emit('review_verdict', { level: 'fast', verdict: 'pass', tokens: 0, model: reviewerModel, feedback_length: 0, budget_downgrade: true }, { convoy_id: convoyId, task_id: taskRecord.id })
            } else {
              // 'skip': treat as passed
              events.emit('review_verdict', { level: 'fast', verdict: 'pass', tokens: 0, model: reviewerModel, feedback_length: 0, budget_skip: true }, { convoy_id: convoyId, task_id: taskRecord.id })
            }
          } else {
            await reviewSemaphore.acquire()
            let reviewResult: ReviewResult
            try {
              if (reviewRunner && spec.defaults?.review_stages !== false) {
                // Two-stage review: spec compliance first, then code quality
                const twoStageResult = await runTwoStageReview(taskRecord, reviewRunner, reviewerModel)
                for (const stage of twoStageResult.stages) {
                  events.emit('review_stage_completed', { stage: stage.stage, verdict: stage.verdict, tokens: stage.tokens_used, task_id: taskRecord.id, model: reviewerModel }, { convoy_id: convoyId, task_id: taskRecord.id })
                }
                reviewResult = {
                  verdict: twoStageResult.overall_verdict,
                  feedback: twoStageResult.stages.flatMap(s => s.issues).join('\n'),
                  tokens: twoStageResult.total_tokens,
                  model: reviewerModel,
                }
              } else if (reviewRunner) {
                reviewResult = await reviewRunner(taskRecord, 'fast', reviewerModel)
              } else {
                reviewResult = { verdict: 'pass', feedback: '', tokens: 0, model: reviewerModel }
              }
            } finally {
              reviewSemaphore.release()
            }

            reviewTokensTotal += reviewResult.tokens
            store.updateTaskReview(taskRecord.id, convoyId, {
              review_level: 'fast',
              review_verdict: reviewResult.verdict,
              review_tokens: reviewResult.tokens,
              review_model: reviewResult.model,
            })
            store.updateConvoyReviewTokens(convoyId, reviewTokensTotal)
            events.emit('review_verdict', { level: 'fast', verdict: reviewResult.verdict, tokens: reviewResult.tokens, model: reviewResult.model, feedback_length: reviewResult.feedback.length }, { convoy_id: convoyId, task_id: taskRecord.id })

            if (reviewResult.verdict === 'block') {
              await removeWorktree()
              const freshRecord = store.getTask(taskRecord.id, convoyId)!
              if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
                const contextPrefix = `Previous attempt was blocked by review.\nFeedback:\n${reviewResult.feedback}\n\nFix the issues and try again.\n\n`
                store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
                  retries: freshRecord.retries + 1,
                  worker_id: null,
                  worktree: null,
                  started_at: null,
                  finished_at: null,
                  prompt: contextPrefix + taskRecord.prompt,
                })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
                process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} review blocked, retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`)
                taskAdapterMap.delete(taskRecord.id)
                return
              } else {
                store.withTransaction(() => {
                  store.updateTaskStatus(taskRecord.id, convoyId, 'review-blocked', {
                    finished_at: finishedAt,
                    output: `Review blocked: ${reviewResult.feedback}`,
                    exit_code: 1,
                  })
                  store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
                })
                completedCount++
                process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} review blocked ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
                events.emit('task_failed', { reason: 'review-blocked', worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
                handleExhaustion(freshRecord, 'review-blocked', reviewResult.feedback || null)
                taskAdapterMap.delete(taskRecord.id)
                return
              }
            }
          }
        } else {
          // panel: 3 concurrent reviewer calls, majority vote
          await reviewSemaphore.acquire()
          let panelResults: ReviewResult[]
          try {
            const noopRunner = (_t: TaskRecord, _l: ReviewLevel, m: string) => Promise.resolve({ verdict: 'pass' as const, feedback: '', tokens: 0, model: m })
            const runner = reviewRunner ?? noopRunner
            const twoStageEnabled = spec.defaults?.review_stages !== false
            if (twoStageEnabled && reviewRunner) {
              // Each panel reviewer runs both stages; majority vote on overall_verdict
              const twoStageResults = await Promise.all([
                runTwoStageReview(taskRecord, runner, reviewerModel),
                runTwoStageReview(taskRecord, runner, reviewerModel),
                runTwoStageReview(taskRecord, runner, reviewerModel),
              ])
              for (const tsr of twoStageResults) {
                for (const stage of tsr.stages) {
                  events.emit('review_stage_completed', { stage: stage.stage, verdict: stage.verdict, tokens: stage.tokens_used, task_id: taskRecord.id, model: reviewerModel }, { convoy_id: convoyId, task_id: taskRecord.id })
                }
              }
              panelResults = twoStageResults.map(tsr => ({
                verdict: tsr.overall_verdict,
                feedback: tsr.stages.flatMap(s => s.issues).join('\n'),
                tokens: tsr.total_tokens,
                model: reviewerModel,
              }))
            } else {
              panelResults = await Promise.all([
                runner(taskRecord, 'panel', reviewerModel),
                runner(taskRecord, 'panel', reviewerModel),
                runner(taskRecord, 'panel', reviewerModel),
              ])
            }
          } finally {
            reviewSemaphore.release()
          }

          const panelPasses = panelResults.filter(r => r.verdict === 'pass').length
          const panelBlocks = panelResults.filter(r => r.verdict === 'block').length
          const totalPanelTokens = panelResults.reduce((sum, r) => sum + r.tokens, 0)
          reviewTokensTotal += totalPanelTokens

          const freshForPanel = store.getTask(taskRecord.id, convoyId)!
          store.updateTaskReview(taskRecord.id, convoyId, {
            review_level: 'panel',
            review_verdict: panelPasses >= 2 ? 'pass' : 'block',
            review_tokens: totalPanelTokens,
            review_model: reviewerModel,
            panel_attempts: freshForPanel.panel_attempts + 1,
          })
          if (totalPanelTokens > 0) store.updateConvoyReviewTokens(convoyId, reviewTokensTotal)
          events.emit('review_verdict', { level: 'panel', verdict: panelPasses >= 2 ? 'pass' : 'block', tokens: totalPanelTokens, model: reviewerModel, feedback_length: panelResults.map(r => r.feedback).join('').length, passes: panelPasses, blocks: panelBlocks }, { convoy_id: convoyId, task_id: taskRecord.id })

          if (panelBlocks >= 2) {
            const blockFeedback = panelResults.filter(r => r.verdict === 'block').map(r => r.feedback).join('\n\n---\n\n')
            await removeWorktree()

            // Check for dispute trigger
            const updatedTask = store.getTask(taskRecord.id, convoyId)!
            if (updatedTask.panel_attempts >= 3) {
              const disputeId = `dispute-${taskRecord.id}-${Date.now()}`
              const onDispute = spec.defaults?.on_dispute ?? 'stop'

              store.updateTaskDisputeStatus(taskRecord.id, convoyId, 'disputed', disputeId)
              writeDisputeToMarkdown(disputeId, convoyId, taskRecord, panelResults, basePath, events)

              events.emit('dispute_opened', {
                dispute_id: disputeId,
                task_id: taskRecord.id,
                agent: taskRecord.agent,
                panel_attempts: updatedTask.panel_attempts,
              }, { convoy_id: convoyId, task_id: taskRecord.id })

              if (onDispute === 'stop') {
                const allPending = store.getTasksByConvoy(convoyId).filter(t => t.status === 'pending')
                for (const t of allPending) {
                  skipTask(t.id, `on_dispute: stop — task "${taskRecord.id}" disputed`)
                }
              }

              completedCount++
              process.stdout.write(`  ${c.red('⚡')} ${c.bold(`[${taskRecord.id}]`)} disputed after ${updatedTask.panel_attempts} panel attempts\n`)
              taskAdapterMap.delete(taskRecord.id)
              return
            }

            const freshRecord = store.getTask(taskRecord.id, convoyId)!
            if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
              const contextPrefix = `Previous attempt was blocked by panel review (${panelBlocks}/3 reviewers).\nMUST-FIX:\n${blockFeedback}\n\nFix the issues and try again.\n\n`
              store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
                retries: freshRecord.retries + 1,
                worker_id: null,
                worktree: null,
                started_at: null,
                finished_at: null,
                prompt: contextPrefix + taskRecord.prompt,
              })
              store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} panel blocked (${panelBlocks}/3), retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`)
              taskAdapterMap.delete(taskRecord.id)
              return
            } else {
              store.withTransaction(() => {
                store.updateTaskStatus(taskRecord.id, convoyId, 'review-blocked', {
                  finished_at: finishedAt,
                  output: `Panel review blocked (${panelBlocks}/3): ${blockFeedback}`,
                  exit_code: 1,
                })
                store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
              })
              completedCount++
              process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} panel blocked ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
              events.emit('task_failed', { reason: 'review-blocked', worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
              handleExhaustion(freshRecord, 'review-blocked', blockFeedback || null)
              taskAdapterMap.delete(taskRecord.id)
              return
            }
          }
        }
      }

      // ── Intelligence: check discovered issues (Phase 18.4) ─────────────
      if (spec.defaults?.track_discovered_issues) {
        try {
          checkDiscoveredIssues(taskRecord.id, events, convoyId, worktreePath ?? basePath)
        } catch { /* non-critical */ }
      }

      // ── post_task hooks ───────────────────────────────────────────────────
      if (taskHooks.length > 0) {
        const postResult = await runHooks(taskHooks, 'post_task', {
          taskId: taskRecord.id,
          convoyId,
          cwd: worktreePath ?? basePath,
        })
        if (!postResult.passed) {
          await removeWorktree()
          const hookLabel = postResult.failedHook?.name ?? postResult.failedHook?.type ?? 'unknown'
          store.withTransaction(() => {
            store.updateTaskStatus(taskRecord.id, convoyId, 'hook-failed', {
              finished_at: finishedAt,
              output: `post_task hook "${hookLabel}" failed: ${postResult.error ?? ''}`,
              exit_code: 1,
            })
            store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
          })
          completedCount++
          process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} post_task hook failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
          events.emit('task_failed', { reason: 'hook-failed', hook: hookLabel, worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
          cascadeFailure(taskRecord.id)
          taskAdapterMap.delete(taskRecord.id)
          return
        }
      }

      // ── Symlink security scan (post-execution) ───────────────────────────
      if (taskFiles.length > 0 && worktreePath) {
        try {
          scanNewSymlinks(worktreePath, taskFiles)
        } catch (err) {
          await removeWorktree()
          store.withTransaction(() => {
            store.updateTaskStatus(taskRecord.id, convoyId, 'failed', {
              finished_at: finishedAt,
              output: `Post-execution symlink security check failed: ${(err as Error).message}`,
              exit_code: 1,
            })
            store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
          })
          completedCount++
          events.emit('task_failed', { reason: 'symlink-escape-post', worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
          cascadeFailure(taskRecord.id)
          taskAdapterMap.delete(taskRecord.id)
          return
        }
      }

      if (worktreePath) {
        let mergeAttempt = 0
        const maxMergeAttempts = 2
        let merged = false

        while (mergeAttempt < maxMergeAttempts && !merged) {
          try {
            await mergeQueue.merge(worktreePath, `convoy-${workerId}`, baseBranch)
            merged = true
          } catch (err) {
            if (err instanceof MergeConflictError) {
              mergeAttempt++
              events.emit('merge_conflict_detected', {
                attempt: mergeAttempt,
                conflicting_files: err.conflictingFiles,
              }, { convoy_id: convoyId, task_id: taskRecord.id })

              if (mergeAttempt >= maxMergeAttempts) {
                events.emit('merge_conflict_failed', {
                  attempts: mergeAttempt,
                  conflicting_files: err.conflictingFiles,
                }, { convoy_id: convoyId, task_id: taskRecord.id })

                const freshRecord = store.getTask(taskRecord.id, convoyId)!
                store.withTransaction(() => {
                  store.updateTaskStatus(taskRecord.id, convoyId, 'failed', {
                    finished_at: now(),
                    output: `Merge conflict could not be resolved after ${mergeAttempt} attempts. Files: ${err.conflictingFiles.join(', ')}`,
                    exit_code: 1,
                  })
                  store.updateWorkerStatus(workerId, 'failed', { finished_at: now() })
                })
                completedCount++
                process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} merge conflict unresolved ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
                events.emit('task_failed', { reason: 'merge-conflict', worker_id: workerId }, { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId })
                cascadeFailure(taskRecord.id)
                handleExhaustion(freshRecord, 'merge-conflict', err.conflictingFiles.join(', '))
                break
              }

              // Per spec: backoff on second attempt (unreachable with maxMergeAttempts=2 but follows spec)
              if (mergeAttempt === 2) {
                await new Promise<void>(resolve => setTimeout(resolve, 30_000))
              }

              // Inject a resolution task
              const fileHash = createHash('sha256')
                .update(err.conflictingFiles.sort().join(','))
                .digest('hex')
                .slice(0, 12)
              const idempotencyKey = `merge-conflict:${taskRecord.phase}:${fileHash}`
              const resolutionTaskId = `merge-fix-${taskRecord.id}-${mergeAttempt}`
              const conflictPrompt = `Resolve merge conflicts in: ${err.conflictingFiles.join(', ')}. Ensure no conflict markers remain (<<<<<<<, =======, >>>>>>>), syntax is valid, no duplicate imports.`

              const resolutionRecord: TaskRecord = {
                id: resolutionTaskId,
                convoy_id: convoyId,
                phase: taskRecord.phase,
                prompt: conflictPrompt,
                agent: taskRecord.agent,
                adapter: null,
                model: null,
                timeout_ms: 600_000,
                status: 'pending',
                worker_id: null,
                worktree: null,
                output: null,
                exit_code: null,
                started_at: null,
                finished_at: null,
                retries: 0,
                max_retries: 1,
                files: JSON.stringify(err.conflictingFiles),
                depends_on: null,
                prompt_tokens: null,
                completion_tokens: null,
                total_tokens: null,
                cost_usd: null,
                gates: null,
                on_exhausted: 'dlq',
                injected: 1,
                provenance: 'merge-conflict',
                idempotency_key: idempotencyKey,
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
                compaction_count: 0,
                outputs: null,
                inputs: null,
                discovered_issues: null,
              }

              store.insertInjectedTask(resolutionRecord)
              const storedResolutionRecord = store.getTask(resolutionTaskId, convoyId)!
              await executeOneTask(storedResolutionRecord)
              // Next loop iteration will retry the merge
            } else {
              // Non-conflict merge error — log warning and continue to done path
              if (verbose) {
                process.stderr.write(
                  `Warning: merge failed for ${taskRecord.id}: ${(err as Error).message}\n`,
                )
              }
              merged = true // Preserve original behavior: continue despite error
              break
            }
          }
        }

        await removeWorktree()

        if (!merged) {
          taskAdapterMap.delete(taskRecord.id)
          return
        }

        // ── Intelligence: update expertise post-merge (Phase 18.2) ─────────
        try {
          updateExpertise(taskRecord.agent, { taskId: taskRecord.id, success: true, retries: taskRecord.retries, files: taskRecord.files ? JSON.parse(taskRecord.files) as string[] : [] }, basePath)
        } catch { /* non-critical */ }
        // ── Intelligence: build knowledge graph post-merge (Phase 18.3) ────
        try {
          const { stdout: diffOut } = await execFile('git', ['diff', 'HEAD~1'], { cwd: basePath })
          buildKnowledgeGraph(diffOut, convoyId, basePath)
        } catch { /* non-critical */ }
      }

      const usageExtra: Partial<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }> = {}
      if (result.usage) {
        if (result.usage.prompt_tokens != null) usageExtra.prompt_tokens = result.usage.prompt_tokens
        if (result.usage.completion_tokens != null) usageExtra.completion_tokens = result.usage.completion_tokens
        if (result.usage.total_tokens != null) usageExtra.total_tokens = result.usage.total_tokens
      } else {
        // Estimate tokens from prompt/output text length (~4 chars per token)
        const estimatedPrompt = Math.ceil(taskRecord.prompt.length / 4)
        const estimatedCompletion = Math.ceil((result.output?.length ?? 0) / 4)
        usageExtra.prompt_tokens = estimatedPrompt
        usageExtra.completion_tokens = estimatedCompletion
        usageExtra.total_tokens = estimatedPrompt + estimatedCompletion
        if (verbose) {
          process.stdout.write(`    ${c.dim('ℹ')} Estimated ${usageExtra.total_tokens} tokens (adapter ${taskAdapter.name} returned no usage data)\n`)
        }
      }

      // ── Context compaction check (Phase 44) ─────────────────────────────
      const compactionConfig = spec.defaults?.compaction
      if (compactionConfig?.enabled && usageExtra.total_tokens != null && taskRecord.model) {
        if (shouldCompact(usageExtra.total_tokens, taskRecord.model, compactionConfig)) {
          if (canCompact(taskRecord.compaction_count)) {
            const newCount = taskRecord.compaction_count + 1
            store.updateTaskCompaction(taskRecord.id, convoyId, newCount)

            const summaryFromOutput = parseCompactionSummary(result.output, taskRecord.id, convoyId)
            let summaryPath: string | undefined
            if (summaryFromOutput) {
              try {
                summaryPath = saveCompaction(convoyId, taskRecord.id, summaryFromOutput, newCount, basePath)
              } catch { /* non-critical */ }
            }

            const compactionTaskFiles = taskRecord.files ? JSON.parse(taskRecord.files) as string[] : []
            const compactionDepIds = taskRecord.depends_on ? JSON.parse(taskRecord.depends_on) as string[] : []
            const compactionDepResults = resolveDependencyResults(store, convoyId, compactionDepIds)
            const compactionPreamble = buildIsolationPreamble(
              { id: taskRecord.id, description: taskRecord.prompt.slice(0, 200), prompt: taskRecord.prompt, files: compactionTaskFiles, agent: taskRecord.agent },
              compactionDepResults,
            )

            const continuationPrompt = summaryPath
              ? buildContinuationPrompt(taskRecord.prompt, summaryPath, compactionPreamble)
              : compactionPreamble + '\n\n' + generateCompactionPrompt(taskRecord.id) + '\n\n' + taskRecord.prompt

            store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
              worker_id: null,
              worktree: null,
              started_at: null,
              finished_at: null,
              prompt: continuationPrompt,
            })
            store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })

            events.emit('context_compacted', {
              task_id: taskRecord.id,
              compaction_count: newCount,
              summary_path: summaryPath ?? '',
              model: taskRecord.model,
              tokens_used: usageExtra.total_tokens,
            }, { convoy_id: convoyId, task_id: taskRecord.id })

            taskAdapterMap.delete(taskRecord.id)
            return
          } else {
            // Max compactions exceeded — fail the task
            const exhaustedAt = new Date().toISOString()
            store.updateTaskStatus(taskRecord.id, convoyId, 'failed', {
              finished_at: exhaustedAt,
              output: `Context exhausted: reached maximum ${getMaxCompactions()} compactions`,
              exit_code: 1,
            })
            store.updateWorkerStatus(workerId, 'failed', { finished_at: exhaustedAt })
            events.emit('task_failed', {
              reason: 'context_exhausted',
              worker_id: workerId,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
            taskAdapterMap.delete(taskRecord.id)
            return
          }
        }
      }

      // ── Capture outputs as artifacts ────────────────────────────────────────
      if (taskRecord.outputs) {
        const outputs: TaskOutput[] = JSON.parse(taskRecord.outputs)
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
              id: `artifact-${taskRecord.id}-${output.name}-${Date.now()}`,
              convoy_id: convoyId,
              task_id: taskRecord.id,
              name: output.name,
              type: output.type,
              content,
              created_at: new Date().toISOString(),
            })
          } catch (err) {
            if (err instanceof ConvoyArtifactLimitError) {
              events.emit('artifact_limit_reached', {
                task_id: taskRecord.id,
                artifact_name: output.name,
              }, { convoy_id: convoyId, task_id: taskRecord.id })
            } else {
              throw err
            }
          }
        }
      }

      // ── Extract filesystem artifacts (Phase 43) ────────────────────────
      try {
        const fsArtifactRefs = extractArtifactRefs(taskRecord.id, convoyId, result.output)
        if (fsArtifactRefs.length > 0) {
          events.emit('artifacts_extracted', {
            task_id: taskRecord.id,
            count: fsArtifactRefs.length,
            artifacts: fsArtifactRefs.map(r => ({ filename: r.filename, summary: r.summary })),
          }, { convoy_id: convoyId, task_id: taskRecord.id })
        }
      } catch (err) {
        process.stderr.write(`[artifacts] Warning: extraction failed for task ${taskRecord.id}: ${(err as Error).message}\n`)
      }

      // ── Create file artifacts from task file list ────────────────────────
      if (taskRecord.files && !taskRecord.outputs) {
        try {
          const fileList: string[] = JSON.parse(taskRecord.files)
          for (const filePath of fileList.slice(0, 20)) {
            try {
              store.insertArtifact({
                id: `artifact-${taskRecord.id}-file-${filePath.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`,
                convoy_id: convoyId,
                task_id: taskRecord.id,
                name: filePath,
                type: 'file',
                content: '',
                created_at: new Date().toISOString(),
              })
            } catch (err) {
              if (err instanceof ConvoyArtifactLimitError) break
              // Other errors are non-critical
            }
          }
        } catch { /* files not parseable */ }
      }

      // ── Output contract validation ────────────────────────────────────────
      const contractResult = validateOutput(taskRecord.agent, result.output)
      if (!contractResult.valid) {
        const freshRecordForContract = store.getTask(taskRecord.id, convoyId)!
        if (freshRecordForContract.retries < freshRecordForContract.max_retries) {
          const retryPrefix = buildContractRetryPrompt(contractResult) + '\n\n'
          store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
            retries: freshRecordForContract.retries + 1,
            worker_id: null,
            worktree: null,
            started_at: null,
            finished_at: null,
            prompt: retryPrefix + taskRecord.prompt,
          })
          store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
          process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} contract retry ${freshRecordForContract.retries + 1}/${freshRecordForContract.max_retries}\n`)
          taskAdapterMap.delete(taskRecord.id)
          return
        }
        events.emit('contract_violation', {
          task_id: taskRecord.id,
          agent: taskRecord.agent,
          missing: contractResult.missing,
          warnings: contractResult.warnings,
        }, { convoy_id: convoyId, task_id: taskRecord.id })
        process.stdout.write(`  ${c.yellow('⚠')} ${c.bold(`[${taskRecord.id}]`)} contract violation: missing ${contractResult.missing.join(', ')}\n`)
      }

      // ── Intelligence: capture persistent agent identity (Phase 17.2) ─────
      const specTaskForCapture = (spec.tasks ?? []).find(t => t.id === taskRecord.id)
      if (specTaskForCapture?.persistent && result.output) {
        try {
          // Extract last 300 words, cap at 4KB
          const words = result.output.split(/\s+/)
          const lastWords = words.slice(-300).join(' ')
          let summary = lastWords.length > 4096 ? lastWords.slice(-4096) : lastWords

          // Secret-scan the summary before storing
          const summaryScan = scanForSecrets(summary, `identity:${taskRecord.id}`)
          if (summaryScan.clean) {
            store.insertAgentIdentity({
              id: `identity-${taskRecord.id}-${Date.now()}`,
              agent: taskRecord.agent,
              convoy_id: convoyId,
              task_id: taskRecord.id,
              summary,
              created_at: new Date().toISOString(),
              retention_days: 90,
            })
            events.emit('agent_identity_captured', {
              agent: taskRecord.agent,
              summary_length: summary.length,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
          } else {
            events.emit('agent_identity_rejected', {
              agent: taskRecord.agent,
              reason: 'secrets_detected',
              findings_count: summaryScan.findings.length,
            }, { convoy_id: convoyId, task_id: taskRecord.id })
          }
        } catch { /* non-critical */ }
      }

      const taskModel = taskRecord.model ?? AGENT_MODEL_MAP[taskRecord.agent.toLowerCase()] ?? taskAdapter.name
      const taskCost = calculateCost(taskModel, usageExtra.prompt_tokens, usageExtra.completion_tokens)

      store.withTransaction(() => {
        store.updateTaskStatus(taskRecord.id, convoyId, 'done', {
          finished_at: finishedAt,
          output: result.output,
          exit_code: result.exitCode,
          ...usageExtra,
          model: taskModel,
          cost_usd: taskCost,
          contract_result: JSON.stringify(contractResult),
        })
        store.updateWorkerStatus(workerId, 'done', { finished_at: finishedAt })
      })
      // ── Circuit breaker: record success ────────────────────────────────────
      if (circuitBreakerConfig) {
        circuitBreaker.recordSuccess(taskRecord.agent)
        try { store.updateConvoyCircuitState(convoyId, circuitBreaker.serialize()) } catch { /* non-critical */ }
      }
      // ── Intelligence: capture retry lesson (Phase 18.1) ─────────────────
      if (taskRecord.retries > 0 && spec.defaults?.inject_lessons !== false) {
        try {
          captureLessons({
            title: `Retry success for ${taskRecord.agent} on ${taskRecord.id}`,
            category: 'convoy',
            agent: taskRecord.agent,
            problem: `Task ${taskRecord.id} required ${taskRecord.retries} retries`,
            solution: 'Succeeded after retry with adjusted approach',
            files: taskRecord.files ? JSON.parse(taskRecord.files) as string[] : undefined,
          }, basePath)
        } catch { /* non-critical */ }
      }
      completedCount++
      process.stdout.write(`  ${c.green('✓')} ${c.bold(`[${taskRecord.id}]`)} ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
      events.emit(
        'task_done',
        { exit_code: result.exitCode, worker_id: workerId },
        { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
      )
      events.emit('session', {
        agent: taskRecord.agent,
        model: taskRecord.model ?? taskAdapter.name,
        task: taskRecord.id,
        outcome: 'success',
        duration_min: Math.round((Date.now() - taskStartTime) / 60_000),
        files_changed: 0,
        retries: taskRecord.retries,
        convoy_id: convoyId,
      }, { convoy_id: convoyId, task_id: taskRecord.id })
      events.emit('delegation', {
        session_id: convoyId,
        agent: taskRecord.agent,
        model: taskRecord.model ?? taskAdapter.name,
        tier: 'standard',
        mechanism: 'convoy',
        outcome: 'success',
        retries: taskRecord.retries,
        phase: taskRecord.phase,
        convoy_id: convoyId,
      }, { convoy_id: convoyId, task_id: taskRecord.id })
      taskAdapterMap.delete(taskRecord.id)
      return
    }

    // ── Failure ─────────────────────────────────────────────────────────────
    if (typeof taskAdapter.kill === 'function') taskAdapter.kill(task)
    await removeWorktree()

    const freshRecord = store.getTask(taskRecord.id, convoyId)!
    if (freshRecord.retries < freshRecord.max_retries && spec.on_failure !== 'stop') {
      const failedOutput = result.output || '(no output)'
      const contextPrefix = `Previous attempt failed.\nExit code: ${result.exitCode}\nError output:\n${failedOutput}\n\nFix the issues and try again.\n\n`
      store.updateTaskStatus(taskRecord.id, convoyId, 'pending', {
        retries: freshRecord.retries + 1,
        worker_id: null,
        worktree: null,
        started_at: null,
        finished_at: null,
        prompt: contextPrefix + taskRecord.prompt,
      })
      store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
      process.stdout.write(`  ${c.yellow('⟳')} ${c.bold(`[${taskRecord.id}]`)} retry ${freshRecord.retries + 1}/${freshRecord.max_retries}\n`)
    } else {
      // Estimate tokens even for failed tasks — you still paid for them
      const estimatedPrompt = Math.ceil(taskRecord.prompt.length / 4)
      const estimatedCompletion = Math.ceil((result.output?.length ?? 0) / 4)
      const failModel = taskRecord.model ?? AGENT_MODEL_MAP[taskRecord.agent.toLowerCase()] ?? taskAdapter.name
      const failCost = calculateCost(failModel, estimatedPrompt, estimatedCompletion)
      store.withTransaction(() => {
        store.updateTaskStatus(taskRecord.id, convoyId, 'failed', {
          finished_at: finishedAt,
          output: result.output,
          exit_code: result.exitCode,
          prompt_tokens: estimatedPrompt,
          completion_tokens: estimatedCompletion,
          total_tokens: estimatedPrompt + estimatedCompletion,
          model: failModel,
          cost_usd: failCost,
        })
        store.updateWorkerStatus(workerId, 'failed', { finished_at: finishedAt })
      })
      // ── Intelligence: record failure in expertise (Phase 18.2) ──────────
      try {
        updateExpertise(taskRecord.agent, { taskId: taskRecord.id, success: false, retries: freshRecord.retries, files: taskRecord.files ? JSON.parse(taskRecord.files) as string[] : [] }, basePath)
      } catch { /* non-critical */ }
      // ── Circuit breaker: record failure ────────────────────────────────────
      if (circuitBreakerConfig) {
        const { tripped } = circuitBreaker.recordFailure(taskRecord.agent)
        try { store.updateConvoyCircuitState(convoyId, circuitBreaker.serialize()) } catch { /* non-critical */ }
        if (tripped) {
          events.emit('circuit_breaker_tripped', {
            agent: taskRecord.agent,
            state: circuitBreaker.getState(taskRecord.agent),
          }, { convoy_id: convoyId, task_id: taskRecord.id })
        }
      }
      completedCount++
      process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${taskRecord.id}]`)} failed ${elapsed} ${c.dim(`[${completedCount}/${totalTasks}]`)}\n`)
      if (verbose) {
        const outputPreview = result.output.split('\n').slice(0, 5).join('\n')
        process.stdout.write(`${outputPreview}\n`)
      }
      events.emit(
        'task_failed',
        { reason: 'error', exit_code: result.exitCode, worker_id: workerId },
        { convoy_id: convoyId, task_id: taskRecord.id, worker_id: workerId },
      )
      events.emit('session', {
        agent: taskRecord.agent,
        model: taskRecord.model ?? taskAdapter.name,
        task: taskRecord.id,
        outcome: 'failed',
        duration_min: Math.round((Date.now() - taskStartTime) / 60_000),
        files_changed: 0,
        retries: freshRecord.retries,
        convoy_id: convoyId,
      }, { convoy_id: convoyId, task_id: taskRecord.id })
      events.emit('delegation', {
        session_id: convoyId,
        agent: taskRecord.agent,
        model: taskRecord.model ?? taskAdapter.name,
        tier: 'standard',
        mechanism: 'convoy',
        outcome: 'failed',
        retries: freshRecord.retries,
        phase: taskRecord.phase,
        convoy_id: convoyId,
      }, { convoy_id: convoyId, task_id: taskRecord.id })
      handleExhaustion(freshRecord, 'error', result.output || null)
    }
    taskAdapterMap.delete(taskRecord.id)
  }

  // ── Main execution loop ───────────────────────────────────────────────────

  let lastPhase = -1
  const isSwarmMode = spec.concurrency === 'auto'
  const maxSwarmConcurrency = spec.defaults?.max_swarm_concurrency ?? 8
  let lastInjectPoll = 0
  const INJECT_POLL_INTERVAL = 2000 // 2 seconds
  try {
    let ready = store.getReadyTasks(convoyId)
    while (ready.length > 0) {
      // Compute effective concurrency for this phase
      const effectiveConcurrency = isSwarmMode
        ? Math.min(ready.length, maxSwarmConcurrency)
        : (typeof spec.concurrency === 'number' ? spec.concurrency : 1)

      for (const t of ready) {
        if (t.phase !== lastPhase) {
          lastPhase = t.phase
          const tasksInPhase = ready.filter(r => r.phase === t.phase)
          const ids = tasksInPhase.map(r => r.id).join(', ')
          process.stdout.write(`\n  ${c.bold(`Phase ${t.phase + 1}:`)} ${c.dim(ids)}\n`)
          if (isSwarmMode) {
            events.emit('swarm_concurrency_update', {
              phase: t.phase,
              pending_count: ready.length,
              effective_concurrency: effectiveConcurrency,
            }, { convoy_id: convoyId })
          }
        }
      }
      for (let i = 0; i < ready.length; i += effectiveConcurrency) {
        // Poll for file-based injection between batches
        const now = Date.now()
        if (now - lastInjectPoll >= INJECT_POLL_INTERVAL) {
          pollInjectFile(convoyId, store, events, basePath)
          lastInjectPoll = now
        }
        await Promise.all(ready.slice(i, i + effectiveConcurrency).map(t => executeOneTask(t)))
      }
      // Reset wait-for-input tasks to pending so they are re-evaluated after
      // upstream artifacts may have been captured in this batch
      const waitingTasks = store.getTasksByConvoy(convoyId).filter(t => t.status === ('wait-for-input' as ConvoyTaskStatus))
      for (const wt of waitingTasks) {
        store.updateTaskStatus(wt.id, convoyId, 'pending')
      }
      ready = store.getReadyTasks(convoyId)
    }
  } finally {
    healthMonitor.stop()
  }

  // ── Validation gates ──────────────────────────────────────────────────────

  const maxGateRetries = spec.gate_retries ?? 0
  let gateAttempt = 0
  let gateResults: Array<{ command: string; exitCode: number; passed: boolean; output?: string }> = []

  while (gateAttempt <= maxGateRetries) {
    if (!spec.gates || spec.gates.length === 0) break

    gateResults = []
    process.stdout.write(`\n  ${c.bold(gateAttempt === 0 ? 'Gates:' : `Gates (retry ${gateAttempt}/${maxGateRetries}):`)}\n`)

    for (const command of spec.gates) {
      try {
        // SECURITY: Gate/hook commands come from the .convoy.yml spec file, which is operator-controlled.
        // They are NOT user-supplied and are part of the trusted build configuration.
        await execFile('sh', ['-c', command], { cwd: basePath, maxBuffer: 10 * 1024 * 1024 })
        gateResults.push({ command, exitCode: 0, passed: true })
        process.stdout.write(`  ${c.green('✓')} ${c.dim(command)}\n`)
      } catch (err) {
        const execErr = err as Error & { code?: unknown; stderr?: string; stdout?: string }
        const code = typeof execErr.code === 'number' ? execErr.code : 1
        const output = [execErr.stderr, execErr.stdout].filter(Boolean).join('\n').trim() || execErr.message || ''
        gateResults.push({ command, exitCode: code, passed: false, output })
        process.stdout.write(`  ${c.red('✗')} ${c.dim(command)}\n`)
      }
    }

    const failedGates = gateResults.filter(g => !g.passed)
    if (failedGates.length === 0) break // All gates passed

    // Can we retry?
    if (gateAttempt >= maxGateRetries) break // No more retries

    // Create and execute a fix task
    gateAttempt++
    const failureSummary = failedGates
      .map(g => `Command: ${g.command}\nExit code: ${g.exitCode}\nOutput:\n${g.output ?? '(no output)'}`)
      .join('\n\n---\n\n')

    // Gather files touched by convoy tasks to give the fix agent context
    const allTasks = store.getTasksByConvoy(convoyId)
    const touchedFiles = allTasks
      .filter(t => t.files)
      .flatMap(t => { try { return JSON.parse(t.files as string) as string[] } catch { return [] } })
    const filesContext = touchedFiles.length > 0
      ? `\n\nFiles modified by the convoy tasks:\n${touchedFiles.map(f => `- ${f}`).join('\n')}\n`
      : ''

    const fixPrompt = `The following validation gates failed after all convoy tasks completed. Fix the issues so these commands pass.${filesContext}\n\n${failureSummary}`
    const fixTaskId = `gate-fix-${gateAttempt}`

    process.stdout.write(`\n  ${c.yellow('⟳')} ${c.bold(`[${fixTaskId}]`)} fixing gate failures (attempt ${gateAttempt}/${maxGateRetries})\n`)

    const fixTask: Task = {
      id: fixTaskId,
      prompt: fixPrompt,
      agent: spec.defaults?.agent ?? 'developer',
      timeout: spec.defaults?.timeout ?? '30m',
      depends_on: [],
      files: [],
      description: `Auto-fix gate failures (attempt ${gateAttempt})`,
      max_retries: 0,
    }

    const fixResult = await adapter.execute(fixTask, { verbose, cwd: basePath })

    if (fixResult.success) {
      process.stdout.write(`  ${c.green('✓')} ${c.bold(`[${fixTaskId}]`)} fix applied\n`)
    } else {
      process.stdout.write(`  ${c.red('✗')} ${c.bold(`[${fixTaskId}]`)} fix failed\n`)
      break // Don't retry if the fix task itself fails
    }
  }

  // ── post_convoy hooks ─────────────────────────────────────────────────────

  const specLevelHooks: Hook[] = spec.hooks ?? []
  if (specLevelHooks.length > 0) {
    const postConvoyResult = await runHooks(specLevelHooks, 'post_convoy', {
      convoyId,
      cwd: basePath,
    })
    if (!postConvoyResult.passed) {
      const hookLabel = postConvoyResult.failedHook?.name ?? postConvoyResult.failedHook?.type ?? 'unknown'
      events.emit('post_convoy_hook_failed', {
        hook: hookLabel,
        error: postConvoyResult.error,
      }, { convoy_id: convoyId })
      process.stdout.write(`  ${c.red('✗')} post_convoy hook "${hookLabel}" failed\n`)
    }
  }

  // ── Intelligence: post-convoy consolidation ──────────────────────────────
  if (spec.defaults?.inject_lessons !== false) {
    try { consolidateLessons(basePath) } catch { /* non-critical */ }
  }
  if (spec.defaults?.track_discovered_issues) {
    try { consolidateIssues(basePath) } catch { /* non-critical */ }
  }

  // ── Intelligence: skill refinement check ───────────────────────────────
  try {
    const proposals = runSkillRefinementCheck(convoyId, basePath)
    for (const p of proposals) {
      events.emit('skill_refinement_proposed', {
        skill_name: p.skill,
        proposal_path: p.proposalPath,
      }, { convoy_id: convoyId })
      process.stdout.write(`  ${c.yellow('◆')} Skill refinement proposed for "${p.skill}". Review at ${p.proposalPath}\n`)
    }
  } catch { /* non-critical */ }

  // ── Final status & summary ────────────────────────────────────────────────

  const allTasksFinal = store.getTasksByConvoy(convoyId)
  const summary = {
    total: allTasksFinal.length,
    done: allTasksFinal.filter(t => t.status === 'done').length,
    failed: allTasksFinal.filter(t => t.status === 'failed' || t.status === 'gate-failed' || t.status === 'review-blocked' || t.status === 'disputed').length,
    skipped: allTasksFinal.filter(t => t.status === 'skipped').length,
    timedOut: allTasksFinal.filter(t => t.status === 'timed-out').length,
  }

  const anyGateFailed = gateResults.some(g => !g.passed)
  const finalStatus: ConvoyStatus = anyGateFailed
    ? 'gate-failed'
    : summary.failed > 0 || summary.timedOut > 0
      ? 'failed'
      : 'done'

  // Aggregate token usage and cost across completed tasks
  let convoyTotalTokens: number | null = null
  let convoyTotalCost: number | null = null
  for (const t of allTasksFinal) {
    if (t.total_tokens != null) {
      convoyTotalTokens = (convoyTotalTokens ?? 0) + t.total_tokens
    }
    if (t.cost_usd != null) {
      convoyTotalCost = (convoyTotalCost ?? 0) + (typeof t.cost_usd === 'number' ? t.cost_usd : parseFloat(t.cost_usd))
    }
  }

  store.updateConvoyStatus(convoyId, finalStatus, {
    finished_at: new Date().toISOString(),
    total_tokens: convoyTotalTokens,
    total_cost_usd: convoyTotalCost,
  })

  if (finalStatus === 'done') {
    events.emit('convoy_finished', { status: 'done' }, { convoy_id: convoyId })
  } else {
    events.emit('convoy_failed', { status: finalStatus, reason: finalStatus === 'gate-failed' ? 'Gate check failed' : 'One or more tasks failed' }, { convoy_id: convoyId })
  }

  // Run convoy guard checks
  const guardResult = runConvoyGuard(store, convoyId, wtManager, ndjsonPath, spec.guard)
  if (guardResult.warnings.length > 0) {
    process.stdout.write(`\n  ${c.yellow('Guard warnings:')}\n`)
    for (const w of guardResult.warnings) {
      process.stdout.write(`    ${c.dim('⚠')} ${w}\n`)
    }
    events.emit('convoy_guard', {
      passed: guardResult.passed,
      warnings: guardResult.warnings,
    }, { convoy_id: convoyId })
  }

  return {
    convoyId,
    status: finalStatus,
    summary,
    duration: formatDuration(Date.now() - startTime),
    gateResults: spec.gates && spec.gates.length > 0 ? gateResults : undefined,
    cost: convoyTotalTokens != null || convoyTotalCost != null
      ? { total_tokens: convoyTotalTokens ?? 0, total_cost_usd: convoyTotalCost ?? undefined }
      : undefined,
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createConvoyEngine(options: ConvoyEngineOptions): ConvoyEngine {
  const { spec, specYaml, adapter, verbose = false } = options
  const basePath = resolve(options.basePath ?? process.cwd())
  const dbPath = options.dbPath ?? join(basePath, '.opencastle', 'convoy.db')

  async function getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: basePath,
      })
      return stdout.trim()
    } catch {
      return 'main'
    }
  }

  async function run(): Promise<ConvoyResult> {
    const startTime = Date.now()
    const convoyId = `convoy-${startTime}`
    const specHash = createHash('sha256').update(specYaml).digest('hex')
    const baseBranch = spec.branch ?? (await getCurrentBranch())

    // Create convoy-level worktree for branch isolation.
    // Skipped when _convoyWorktreeDir is null or _ensureBranch is injected (test mode).
    let effectiveBasePath = basePath
    let convoyWorktreeDir: string | undefined
    if (spec.branch !== undefined) {
      const skipWorktree = options._convoyWorktreeDir === null || options._ensureBranch !== undefined
      if (!skipWorktree) {
        if (typeof options._convoyWorktreeDir === 'string') {
          effectiveBasePath = options._convoyWorktreeDir
          convoyWorktreeDir = options._convoyWorktreeDir
        } else {
          const worktreeId = `convoy-root-${Date.now()}`
          convoyWorktreeDir = join(basePath, '.opencastle', 'worktrees', worktreeId)
          mkdirSync(dirname(convoyWorktreeDir), { recursive: true })
          let branchExists = false
          try {
            await execFile('git', ['rev-parse', '--verify', spec.branch], { cwd: basePath })
            branchExists = true
          } catch { /* branch doesn't exist */ }
          if (branchExists) {
            await execFile('git', ['worktree', 'add', convoyWorktreeDir, spec.branch], { cwd: basePath })
          } else {
            await execFile('git', ['worktree', 'add', '-b', spec.branch, convoyWorktreeDir], { cwd: basePath })
          }
          effectiveBasePath = convoyWorktreeDir
        }
      }
    }

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

    const lock = (() => {
      try {
        return acquireEngineLock(lockDb, dbPath)
      } catch (err) {
        lockDb.close()
        throw err
      }
    })()

    const versionRow = lockDb.prepare('SELECT sqlite_version() as v').get() as { v: string }
    const [major, minor] = versionRow.v.split('.').map(Number)
    if (major < 3 || (major === 3 && minor < 35)) {
      lock.release()
      lockDb.close()
      throw new Error(`SQLite version ${versionRow.v} is too old. Requires >= 3.35.0`)
    }

    lock.startHeartbeat()

    const store = createConvoyStore(dbPath)
    const ndjsonPath = options.logsDir
      ? join(options.logsDir, 'convoys', `${convoyId}.ndjson`)
      : ndjsonPathForConvoy(convoyId, effectiveBasePath)
    const events = createEventEmitter(store, { ndjsonPath })
    const wtManager = options._worktreeManager ?? createWorktreeManager(effectiveBasePath)
    const mergeQueue = options._mergeQueue ?? createMergeQueue(effectiveBasePath)

    let result: ConvoyResult
    try {
      store.insertConvoy({
        id: convoyId,
        name: spec.name,
        spec_hash: specHash,
        status: 'pending',
        branch: baseBranch,
        created_at: new Date().toISOString(),
        spec_yaml: specYaml,
        pipeline_id: options.pipelineId ?? null,
      })

      const tasks = spec.tasks ?? []
      const phases = buildPhases(tasks)

      // Validate file partitions before inserting tasks
      const partitionResult = validateFilePartitions(tasks, phases)
      if (!partitionResult.valid) {
        const conflictSummary = partitionResult.conflicts
          .map(
            (cf) =>
              `Phase ${cf.phase}: tasks "${cf.taskA}" and "${cf.taskB}" overlap on [${cf.overlapping.join(', ')}]`,
          )
          .join('\n')
        events.emit(
          'file_partition_conflict',
          { conflicts: partitionResult.conflicts },
          { convoy_id: convoyId },
        )
        throw new Error(`File partition conflicts detected:\n${conflictSummary}`)
      }

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

      store.updateConvoyStatus(convoyId, 'running', { started_at: new Date().toISOString() })
      events.emit('convoy_started', { name: spec.name }, { convoy_id: convoyId })

      result = await runConvoy(
        convoyId, spec, adapter, store, events,
        wtManager, mergeQueue, effectiveBasePath, baseBranch, verbose, startTime, ndjsonPath,
        options._reviewRunner,
      )
    } catch (err) {
      // Without this, an unexpected throw from runConvoy leaves the convoy row
      // reading 'running' forever, and a later resume() refuses to touch it.
      markConvoyCrashed(store, events, convoyId, err)
      throw err
    } finally {
      events.close()
      store.close()
      lock.release()
      lockDb.close()
      if (convoyWorktreeDir) {
        try {
          await execFile('git', ['worktree', 'remove', convoyWorktreeDir, '--force'], { cwd: basePath })
        } catch { /* ignore cleanup errors */ }
      }
    }
    return result
  }

  async function resume(convoyId: string): Promise<ConvoyResult> {
    const startTime = Date.now()

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

    const lock = (() => {
      try {
        return acquireEngineLock(lockDb, dbPath)
      } catch (err) {
        lockDb.close()
        throw err
      }
    })()

    const versionRow = lockDb.prepare('SELECT sqlite_version() as v').get() as { v: string }
    const [major, minor] = versionRow.v.split('.').map(Number)
    if (major < 3 || (major === 3 && minor < 35)) {
      lock.release()
      lockDb.close()
      throw new Error(`SQLite version ${versionRow.v} is too old. Requires >= 3.35.0`)
    }

    lock.startHeartbeat()

    const store = createConvoyStore(dbPath)
    let effectiveBasePath = basePath
    let convoyWorktreeDir: string | undefined
    let events: ConvoyEventEmitter | undefined

    let result: ConvoyResult
    try {
      const convoy = store.getConvoy(convoyId)
      if (!convoy) {
        throw new Error(`Convoy "${convoyId}" not found in store`)
      }

      const baseBranch = convoy.branch ?? spec.branch ?? (await getCurrentBranch())
      const convoyBranch = convoy.branch ?? spec.branch

      // Create convoy-level worktree for branch isolation.
      if (convoyBranch !== undefined) {
        const skipWorktree = options._convoyWorktreeDir === null || options._ensureBranch !== undefined
        if (!skipWorktree) {
          if (typeof options._convoyWorktreeDir === 'string') {
            effectiveBasePath = options._convoyWorktreeDir
            convoyWorktreeDir = options._convoyWorktreeDir
          } else {
            const worktreeId = `convoy-root-${Date.now()}`
            convoyWorktreeDir = join(basePath, '.opencastle', 'worktrees', worktreeId)
            mkdirSync(dirname(convoyWorktreeDir), { recursive: true })
            let branchExists = false
            try {
              await execFile('git', ['rev-parse', '--verify', convoyBranch], { cwd: basePath })
              branchExists = true
            } catch { /* branch doesn't exist */ }
            if (branchExists) {
              await execFile('git', ['worktree', 'add', convoyWorktreeDir, convoyBranch], { cwd: basePath })
            } else {
              await execFile('git', ['worktree', 'add', '-b', convoyBranch, convoyWorktreeDir], { cwd: basePath })
            }
            effectiveBasePath = convoyWorktreeDir
          }
        }
      }

      const ndjsonPath = options.logsDir
        ? join(options.logsDir, 'convoys', `${convoyId}.ndjson`)
        : ndjsonPathForConvoy(convoyId, effectiveBasePath)
      events = createEventEmitter(store, { ndjsonPath })
      const wtManager = options._worktreeManager ?? createWorktreeManager(effectiveBasePath)
      const mergeQueue = options._mergeQueue ?? createMergeQueue(effectiveBasePath)

      // Reset interrupted tasks and mark their workers as killed
      const allTasks = store.getTasksByConvoy(convoyId)
      for (const task of allTasks) {
        if (task.status === 'running' || task.status === 'assigned') {
          if (task.worker_id) {
            try {
              store.updateWorkerStatus(task.worker_id, 'killed', {
                finished_at: new Date().toISOString(),
              })
            } catch {
              // worker record may already be absent
            }
          }
          store.updateTaskStatus(task.id, convoyId, 'pending', {
            worker_id: null,
            worktree: null,
            started_at: null,
            finished_at: null,
          })
        }
      }

      // Remove all orphaned worktrees from the crashed run
      await wtManager.removeAll()

      // NDJSON recovery: truncate partial lines, replay missing events
      recoverNdjson(store, convoyId, ndjsonPath)

      events.emit(
        'convoy_resumed',
        { original_created_at: convoy.created_at },
        { convoy_id: convoyId },
      )

      result = await runConvoy(
        convoyId, spec, adapter, store, events,
        wtManager, mergeQueue, effectiveBasePath, baseBranch, verbose, startTime, ndjsonPath,
        options._reviewRunner,
      )
    } catch (err) {
      markConvoyCrashed(store, events ?? null, convoyId, err)
      throw err
    } finally {
      events?.close()
      store.close()
      lock.release()
      lockDb.close()
      if (convoyWorktreeDir) {
        try {
          await execFile('git', ['worktree', 'remove', convoyWorktreeDir, '--force'], { cwd: basePath })
        } catch { /* ignore cleanup errors */ }
      }
    }
    return result
  }

  async function retryFailed(convoyId: string, taskIds?: string[]): Promise<void> {
    mkdirSync(dirname(dbPath), { recursive: true })
    const store = createConvoyStore(dbPath)
    const ndjsonPath = options.logsDir
      ? join(options.logsDir, 'convoys', `${convoyId}.ndjson`)
      : ndjsonPathForConvoy(convoyId, basePath)
    const events = createEventEmitter(store, { ndjsonPath })
    try {
      const allTasks = store.getTasksByConvoy(convoyId)
      const retryableStatuses = ['failed', 'gate-failed', 'timed-out', 'review-blocked', 'disputed']

      const tasksToRetry = allTasks.filter(t => {
        if (!retryableStatuses.includes(t.status)) return false
        if (taskIds && taskIds.length > 0) return taskIds.includes(t.id)
        return true
      })

      for (const task of tasksToRetry) {
        store.updateTaskStatus(task.id, convoyId, 'pending', {
          retries: 0,
          worker_id: null,
          worktree: null,
          started_at: null,
          finished_at: null,
        })
        events.emit('task_retried', { previous_status: task.status }, { convoy_id: convoyId, task_id: task.id })
      }

      // Reset convoy status to running so resume can pick it up
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
      // Idempotency check
      if (task.idempotency_key) {
        const existing = store.getTaskByIdempotencyKey(convoyId, task.idempotency_key)
        if (existing) return existing
      }

      const allTasks = store.getTasksByConvoy(convoyId)

      // Check max injectable tasks (10)
      const injectedCount = allTasks.filter(t => t.injected === 1).length
      if (injectedCount >= 10) {
        throw new Error(`Max injectable tasks (10) reached for convoy ${convoyId}`)
      }

      // Validate ID uniqueness
      if (allTasks.some(t => t.id === task.id)) {
        throw new Error(`Task ID "${task.id}" already exists in convoy ${convoyId}`)
      }

      // Validate depends_on references exist
      const deps = task.depends_on ?? []
      for (const dep of deps) {
        if (!allTasks.some(t => t.id === dep)) {
          throw new Error(`Dependency "${dep}" not found in convoy ${convoyId}`)
        }
      }

      // Validate no file partition overlap with pending/running tasks
      const taskFiles = task.files ?? []
      if (taskFiles.length > 0) {
        // Normalize injected task file paths
        const normalizedTaskFiles = taskFiles.map(normalizePath)

        // Symlink pre-scan on injected files
        const basePath = options.basePath ?? process.cwd()
        try {
          scanSymlinks(normalizedTaskFiles, basePath)
        } catch (err) {
          throw new Error(`Injected task "${task.id}" failed symlink check: ${(err as Error).message}`)
        }

        // Full partition validation against active tasks
        const activeTasks = allTasks.filter(t => t.status === 'pending' || t.status === 'running' || t.status === 'assigned')
        for (const other of activeTasks) {
          const otherFiles = other.files ? (JSON.parse(other.files) as string[]) : []
          if (otherFiles.length === 0) continue
          const normalizedOther = otherFiles.map(normalizePath)
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

      // Detect dependency cycles
      const depGraph = new Map<string, string[]>()
      for (const t of allTasks) {
        depGraph.set(t.id, t.depends_on ? (JSON.parse(t.depends_on) as string[]) : [])
      }
      depGraph.set(task.id, deps)

      function hasCycle(nodeId: string, visited: Set<string>, stack: Set<string>): boolean {
        visited.add(nodeId)
        stack.add(nodeId)
        for (const dep of depGraph.get(nodeId) ?? []) {
          if (!visited.has(dep)) {
            if (hasCycle(dep, visited, stack)) return true
          } else if (stack.has(dep)) {
            return true
          }
        }
        stack.delete(nodeId)
        return false
      }

      const visited = new Set<string>()
      const stack = new Set<string>()
      for (const nodeId of depGraph.keys()) {
        if (!visited.has(nodeId)) {
          if (hasCycle(nodeId, visited, stack)) {
            throw new Error(`Dependency cycle detected when injecting task "${task.id}"`)
          }
        }
      }

      // Insert the task
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
        files: taskFiles.length > 0 ? JSON.stringify(taskFiles) : null,
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
        compaction_count: 0,
        outputs: null,
        inputs: null,
        discovered_issues: null,
      }

      store.insertInjectedTask(record)

      return record
    } finally {
      store.close()
    }
  }

  return { run, resume, retryFailed, injectTask }
}
