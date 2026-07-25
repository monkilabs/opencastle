import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { formatDuration } from './executor.js'
import { c } from '../prompt.js'
import { appendEvent } from '../log.js'
import type {
  TaskSpec,
  Task,
  TaskResult,
  RunReport,
  Reporter,
  ReporterOptions,
} from '../convoy/spec-types.js'

/**
 * Status icons for terminal output.
 */
const ICONS: Record<string, string> = {
  start: '▶',
  done: '✓',
  failed: '✗',
  skipped: '⊘',
  'timed-out': '⏱',
}

/**
 * Create a reporter that prints progress to the terminal and writes a JSON report.
 */
export function createReporter(spec: TaskSpec, options: ReporterOptions = {}): Reporter {
  const reportDir = options.reportDir || resolve(process.cwd(), '.opencastle', 'runs')
  const verbose = options.verbose || false

  return {
    onTaskStart(task: Task): void {
      console.log(`  ${ICONS.start} [${task.id}] ${task.description}`)
    },

    onTaskDone(task: Task, result: TaskResult): void {
      const dur = formatDuration(result.duration)
      if (result.status === 'done') {
        console.log(`  ${ICONS.done} [${task.id}] completed (${dur})`)
      } else if (result.status === 'timed-out') {
        console.log(`  ${ICONS['timed-out']} [${task.id}] timed out after ${task.timeout}`)
      } else {
        console.log(`  ${ICONS.failed} [${task.id}] failed (${dur})`)
        if (result.output) {
          const lines = result.output.split('\n').slice(0, 5)
          for (const line of lines) {
            console.log(`    ${line}`)
          }
          if (result.output.split('\n').length > 5) {
            console.log(`    ... (truncated)`)
          }
        }
      }

      if (verbose && result.output && result.status === 'done') {
        console.log(`    Output: ${result.output.slice(0, 500)}`)
      }

      appendEvent({
        type: 'delegation',
        timestamp: new Date().toISOString(),
        session_id: spec.name,
        agent: task.agent,
        task: `${task.id}: ${task.description}`,
        mechanism: 'run-task',
        outcome: result.status === 'done' ? 'success' : result.status,
        duration_sec: Math.round(result.duration / 1000),
      }).catch(() => {})
    },

    onTaskSkipped(task: Task, reason: string): void {
      console.log(`  ${ICONS.skipped} [${task.id}] skipped — ${reason}`)
    },

    onPhaseStart(phase: number, tasks: Task[]): void {
      const ids = tasks.map((t) => t.id).join(', ')
      console.log(`\n  Phase ${phase}: ${ids}`)
    },

    async onComplete(report: RunReport): Promise<void> {
      console.log(`\n  ──────────────────────────────────`)
      console.log(`  Run complete: ${report.name}`)
      console.log(`  Duration: ${report.duration}`)
      console.log()

      const s = report.summary
      const parts: string[] = []
      if (s.done > 0) parts.push(`${s.done} done`)
      if (s.failed > 0) parts.push(`${s.failed} failed`)
      if (s.skipped > 0) parts.push(`${s.skipped} skipped`)
      if (s['timed-out'] > 0) parts.push(`${s['timed-out']} timed out`)
      console.log(`  Tasks: ${s.total} total — ${parts.join(', ')}`)

      // Write JSON report
      try {
        await mkdir(reportDir, { recursive: true })
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19)
        const reportPath = resolve(reportDir, `${timestamp}.json`)
        await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
        console.log(`  Report: ${reportPath}`)
      } catch (err: unknown) {
        console.log(`  ${ICONS.failed} Could not write report: ${(err as Error).message}`)
      }

      await appendEvent({
        type: 'session',
        timestamp: new Date().toISOString(),
        agent: 'opencastle-run',
        model: spec.adapter,
        task: `Run: ${report.name}`,
        outcome: report.summary.failed > 0 || report.summary['timed-out'] > 0 ? 'failure' : 'success',
        duration_min: Math.round((new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime()) / 60000),
        files_changed: 0,
        retries: 0,
        mode: 'tasks',
        tasks_total: report.summary.total,
        tasks_done: report.summary.done,
        tasks_failed: report.summary.failed,
        tasks_skipped: report.summary.skipped,
      }).catch(() => {})

      console.log()
    },
  }
}

/**
 * Print the execution plan (dry-run mode).
 */
export function printExecutionPlan(spec: TaskSpec, phases: Task[][]): void {
  console.log(`\n  ${c.bold(c.cyan(`🏰 Execution Plan: ${spec.name}`))}`)  
  console.log(`  ${c.dim('Adapter:')}     ${c.cyan(spec.adapter)}`)
  console.log(`  ${c.dim('Concurrency:')} ${c.yellow(String(spec.concurrency))}`)
  console.log(`  ${c.dim('On failure:')}  ${c.yellow(spec.on_failure)}`)
  console.log(`  ${c.dim('Tasks:')}       ${c.yellow(String(spec.tasks?.length ?? 0))}`)
  console.log(`  ${c.dim('──────────────────────────────────')}`)

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    if (i > 0) console.log()
    console.log(`  ${c.bold(`Phase ${i + 1}:`)}`)
    for (const task of phase) {
      const deps =
        task.depends_on.length > 0
          ? c.yellow(` (after: ${task.depends_on.join(', ')})`)
          : ''
      const files =
        task.files.length > 0 ? c.dim(` [${task.files.join(', ')}]`) : ''
      console.log(
        `    ${c.green(task.id)} — ${task.description} ${c.dim(`[${task.agent}, ${task.timeout}]`)}${deps}${files}`
      )
    }
  }
  console.log()
}
