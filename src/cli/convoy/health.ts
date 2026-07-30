import type { ConvoyStore } from './store.js'
import type { ConvoyEventEmitter } from './events.js'
import type { TaskRecord } from './types.js'
import type { AgentAdapter } from './spec-types.js'

export interface HealthMonitorOptions {
  store: ConvoyStore
  events: ConvoyEventEmitter
  convoyId: string
  /** Interval between health checks in ms (default: 30000) */
  intervalMs?: number
  /** Factor of task timeout before declaring stuck (default: 2) */
  stuckFactor?: number
  /** Optional kill callback for killing a stuck worker's process */
  onKill?: (workerId: string, taskId: string) => void
}

export interface HealthMonitor {
  /** Start periodic health checks. Returns immediately. */
  start(): void
  /** Stop periodic health checks and clean up. */
  stop(): void
  /** Run a single health check cycle (useful for testing). */
  check(): void
}

export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {  const {
    store,
    events,
    convoyId,
    intervalMs = 30_000,
    stuckFactor = 2,
    onKill,
  } = options

  let timer: ReturnType<typeof setInterval> | null = null

  function check(): void {
    const activeTasks = store
      .getTasksByConvoy(convoyId)
      .filter(t => t.status === 'running' || t.status === 'assigned')

    for (const task of activeTasks) {
      if (!task.worker_id) continue

      const worker = store.getWorker(task.worker_id)
      if (!worker) continue

      let reason: 'stuck' | 'zombie' | null = null

      if (worker.last_heartbeat !== null) {
        const elapsed = Date.now() - new Date(worker.last_heartbeat).getTime()
        if (elapsed > task.timeout_ms * stuckFactor) {
          reason = 'stuck'
        }
      }

      if (reason === null && worker.pid !== null) {
        let processGone = false
        try {
          process.kill(worker.pid, 0)
        } catch {
          processGone = true
        }
        if (processGone && worker.status === 'running') {
          reason = 'zombie'
        }
      }

      if (reason !== null) {
        const workerId = worker.id
        const taskId = task.id

        onKill?.(workerId, taskId)

        store.withTransaction(() => {
          store.updateWorkerStatus(workerId, 'killed', {
            finished_at: new Date().toISOString(),
          })

          if (task.retries < task.max_retries) {
            store.updateTaskStatus(taskId, convoyId, 'pending', {
              retries: task.retries + 1,
            })
          } else {
            store.updateTaskStatus(taskId, convoyId, 'failed')
          }
        })

        events.emit(
          'worker_killed',
          { reason, worker_id: workerId, task_id: taskId },
          { convoy_id: convoyId, task_id: taskId, worker_id: workerId },
        )
      }
    }
  }

  return {
    start() {
      if (timer !== null) return
      timer = setInterval(check, intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    check,
  }
}

// ── Drift detection ───────────────────────────────────────────────────────────

export interface DriftCheckResult {
  score: number
  explanation: string
  drifted: boolean
  threshold: number
}

export async function detectDrift(
  taskRecord: TaskRecord,
  adapter: AgentAdapter,
  options?: { threshold?: number },
): Promise<DriftCheckResult> {
  // Streaming adapters: copilot (vscode adapter), cursor
  const streamingAdapters = ['copilot', 'cursor']
  const adapterName = taskRecord.adapter ?? adapter.name

  if (!streamingAdapters.includes(adapterName)) {
    process.stderr.write(
      `Warning: drift detection skipped for non-streaming adapter "${adapterName}"\n`,
    )
    return {
      score: 1.0,
      explanation: 'Drift detection skipped: non-streaming adapter',
      drifted: false,
      threshold: options?.threshold ?? 0.8,
    }
  }

  const threshold = options?.threshold ?? 0.8

  const confidencePrompt = `Review the work you just completed for task "${taskRecord.id}". Rate your confidence that the implementation is correct and complete on a scale of 0.0 to 1.0. Respond with ONLY a JSON object: {"score": <number>, "explanation": "<brief explanation>"}`

  const confidenceTask = {
    id: `drift-check-${taskRecord.id}`,
    prompt: confidencePrompt,
    agent: taskRecord.agent,
    timeout: '2m',
    depends_on: [] as string[],
    files: [] as string[],
    description: 'Drift confidence check',
    max_retries: 0,
  }

  try {
    const result = await adapter.execute(confidenceTask, { verbose: false })

    const jsonMatch = result.output.match(/\{[^}]*"score"\s*:\s*([\d.]+)[^}]*"explanation"\s*:\s*"([^"]*)"[^}]*\}/)
    if (jsonMatch) {
      const score = Math.max(0, Math.min(1, parseFloat(jsonMatch[1])))
      const explanation = jsonMatch[2]
      return { score, explanation, drifted: score < threshold, threshold }
    }

    const numberMatch = result.output.match(/(0\.\d+|1\.0|1)/)
    if (numberMatch) {
      const score = Math.max(0, Math.min(1, parseFloat(numberMatch[1])))
      return { score, explanation: 'Parsed from raw output', drifted: score < threshold, threshold }
    }

    return {
      score: 0.5,
      explanation: 'Could not parse confidence score from adapter response',
      drifted: 0.5 < threshold,
      threshold,
    }
  } catch (err) {
    return {
      score: 0.5,
      explanation: `Confidence check failed: ${(err as Error).message}`,
      drifted: 0.5 < threshold,
      threshold,
    }
  }
}
