import { parseTimeout } from './schema.js'
import type {
  Task,
  TaskSpec,
  TaskStatus,
  TaskResult,
  RunReport,
  RunSummary,
  AgentAdapter,
  ExecuteResult,
  Reporter,
  Executor,
  TimeoutHandle,
} from '../convoy/spec-types.js'

/**
 * Topological sort of tasks based on `depends_on` edges.
 * Returns groups (phases) of tasks that can run in parallel.
 */
export function buildPhases(tasks: Task[]): Task[][] {
  const taskMap = new Map<string, Task>()
  for (const t of tasks) taskMap.set(t.id, t)

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const t of tasks) {
    inDegree.set(t.id, (t.depends_on || []).length)
    dependents.set(t.id, [])
  }

  for (const t of tasks) {
    for (const dep of t.depends_on || []) {
      dependents.get(dep)!.push(t.id)
    }
  }

  const phases: Task[][] = []
  const remaining = new Set(tasks.map((t) => t.id))

  while (remaining.size > 0) {
    const phase: Task[] = []
    for (const id of remaining) {
      if (inDegree.get(id) === 0) {
        phase.push(taskMap.get(id)!)
      }
    }

    if (phase.length === 0) {
      // Should not happen if cycle detection passed
      throw new Error('Cannot resolve task order — possible circular dependency')
    }

    phases.push(phase)

    for (const t of phase) {
      remaining.delete(t.id)
      for (const depId of dependents.get(t.id)!) {
        inDegree.set(depId, inDegree.get(depId)! - 1)
      }
    }
  }

  return phases
}

/**
 * Create a task executor.
 */
export function createExecutor(
  spec: TaskSpec,
  adapter: AgentAdapter,
  reporter: Reporter
): Executor {
  const phases = buildPhases(spec.tasks!)
  const statuses = new Map<string, TaskStatus>()
  const results = new Map<string, TaskResult | null>()
  const startTimes = new Map<string, number>()

  for (const t of spec.tasks!) {
    statuses.set(t.id, 'pending')
    results.set(t.id, null)
  }

  /**
   * Execute a single task with timeout enforcement.
   */
  async function executeTask(task: Task): Promise<TaskResult> {
    const timeoutMs = parseTimeout(task.timeout)
    statuses.set(task.id, 'running')
    startTimes.set(task.id, Date.now())
    reporter.onTaskStart(task)

    try {
      const timeout = timeoutPromise(timeoutMs, task.id)
      const result = await Promise.race([
        adapter.execute(task, { verbose: spec._verbose }),
        timeout.promise,
      ])

      const duration = Date.now() - startTimes.get(task.id)!

      if (result._timedOut) {
        // Kill the orphaned child process
        if (typeof adapter.kill === 'function') {
          adapter.kill(task)
        }
        statuses.set(task.id, 'timed-out')
        const taskResult: TaskResult = {
          id: task.id,
          status: 'timed-out',
          duration,
          output: `Task timed out after ${task.timeout}`,
          exitCode: -1,
        }
        results.set(task.id, taskResult)
        reporter.onTaskDone(task, taskResult)
        return taskResult
      }

      // Task completed normally — cancel the timeout timer
      timeout.clear()
      const status: TaskStatus = result.success ? 'done' : 'failed'
      statuses.set(task.id, status)
      const taskResult: TaskResult = {
        id: task.id,
        status,
        duration,
        output: result.output || '',
        exitCode: result.exitCode,
      }
      results.set(task.id, taskResult)
      reporter.onTaskDone(task, taskResult)
      return taskResult
    } catch (err: unknown) {
      const duration = Date.now() - startTimes.get(task.id)!
      statuses.set(task.id, 'failed')
      const taskResult: TaskResult = {
        id: task.id,
        status: 'failed',
        duration,
        output: (err as Error).message,
        exitCode: -1,
      }
      results.set(task.id, taskResult)
      reporter.onTaskDone(task, taskResult)
      return taskResult
    }
  }

  /**
   * Skip a task and all its transitive dependents.
   */
  function skipTask(taskId: string, reason: string): void {
    if (statuses.get(taskId) !== 'pending') return
    statuses.set(taskId, 'skipped')
    const task = spec.tasks!.find((t) => t.id === taskId)!
    results.set(taskId, {
      id: taskId,
      status: 'skipped',
      duration: 0,
      output: reason,
      exitCode: -1,
    })
    reporter.onTaskSkipped(task, reason)

    // Recursively skip dependents
    for (const t of spec.tasks!) {
      if ((t.depends_on || []).includes(taskId)) {
        skipTask(t.id, `dependency "${taskId}" was skipped/failed`)
      }
    }
  }

  /**
   * Run all tasks respecting phases and concurrency.
   */
  async function run(): Promise<RunReport> {
    const startedAt = new Date()
    let halted = false

    for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
      if (halted) break

      const phase = phases[phaseIdx]
      const eligible = phase.filter((t) => statuses.get(t.id) === 'pending')

      if (eligible.length === 0) continue

      reporter.onPhaseStart(phaseIdx + 1, eligible)

      // Process eligible tasks in batches limited by concurrency
      const concurrency = spec.concurrency === 'auto' ? eligible.length : spec.concurrency
      for (let i = 0; i < eligible.length; i += concurrency) {
        if (halted) break
        const batch = eligible.slice(i, i + concurrency)
        const batchResults = await Promise.all(batch.map(executeTask))

        for (const r of batchResults) {
          if (r.status === 'failed' || r.status === 'timed-out') {
            if (spec.on_failure === 'stop') {
              halted = true
              // Skip all remaining tasks
              for (const t of spec.tasks!) {
                if (statuses.get(t.id) === 'pending') {
                  skipTask(t.id, 'execution halted due to on_failure: stop')
                }
              }
            } else {
              // on_failure: continue — skip dependents of this failed task
              for (const t of spec.tasks!) {
                if ((t.depends_on || []).includes(r.id)) {
                  skipTask(t.id, `dependency "${r.id}" failed`)
                }
              }
            }
          }
        }
      }
    }

    const completedAt = new Date()
    const allResults: TaskResult[] = spec.tasks!.map(
      (t) =>
        results.get(t.id) || {
          id: t.id,
          status: statuses.get(t.id) as TaskStatus,
          duration: 0,
          output: '',
          exitCode: -1,
        }
    )

    const summary: RunSummary = {
      total: spec.tasks!.length,
      done: 0,
      failed: 0,
      skipped: 0,
      'timed-out': 0,
    }
    for (const r of allResults) {
      if (r.status in summary) {
        (summary as unknown as Record<string, number>)[r.status]++
      }
    }

    const finalReport: RunReport = {
      name: spec.name,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      duration: formatDuration(completedAt.getTime() - startedAt.getTime()),
      summary,
      tasks: allResults,
    }

    await reporter.onComplete(finalReport)

    return finalReport
  }

  return {
    run,
    getPhases: () => phases,
  }
}

/**
 * Create a timeout promise that resolves with a sentinel.
 * Returns { promise, clear } so the timer can be cancelled after normal completion.
 */
function timeoutPromise(ms: number, taskId: string): TimeoutHandle {
  let timerId: ReturnType<typeof setTimeout>
  const promise = new Promise<ExecuteResult>((resolve) => {
    timerId = setTimeout(() => resolve({ _timedOut: true, taskId, success: false, output: '', exitCode: -1 }), ms)
  })
  return { promise, clear: () => clearTimeout(timerId) }
}

/**
 * Format a duration in ms to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSec = seconds % 60
  if (minutes < 60) return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
}
