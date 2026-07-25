import { describe, it, expect, vi } from 'vitest'
import { buildPhases, createExecutor, formatDuration } from './executor.js'
import type { Task, TaskSpec, AgentAdapter, Reporter, TaskResult, RunReport } from '../convoy/spec-types.js'

// ── Helpers ────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string; prompt: string }): Task {
  return {
    agent: 'developer',
    timeout: '10m',
    depends_on: [],
    files: [],
    description: overrides.id,
    max_retries: 1,
    ...overrides,
  }
}

function makeAdapter(results?: Record<string, { success: boolean; exitCode: number }>): AgentAdapter {
  return {
    name: 'test-adapter',
    isAvailable: async () => true,
    execute: async (task) => {
      const r = results?.[task.id] ?? { success: true, exitCode: 0 }
      return { success: r.success, output: `output-${task.id}`, exitCode: r.exitCode }
    },
  }
}

function makeReporter(): Reporter & {
  started: string[]; done: TaskResult[]; skipped: string[]; phases: number[]; report: RunReport | null
} {
  const tracker = {
    started: [] as string[],
    done: [] as TaskResult[],
    skipped: [] as string[],
    phases: [] as number[],
    report: null as RunReport | null,
    onTaskStart(task: Task) { tracker.started.push(task.id) },
    onTaskDone(_task: Task, result: TaskResult) { tracker.done.push(result) },
    onTaskSkipped(task: Task, _reason: string) { tracker.skipped.push(task.id) },
    onPhaseStart(phase: number) { tracker.phases.push(phase) },
    onComplete: async (report: RunReport) => { tracker.report = report },
  }
  return tracker
}

// ── buildPhases ────────────────────────────────────────────────

describe('buildPhases', () => {
  it('puts independent tasks in the same phase', () => {
    const tasks = [
      makeTask({ id: 'a', prompt: 'x' }),
      makeTask({ id: 'b', prompt: 'y' }),
      makeTask({ id: 'c', prompt: 'z' }),
    ]
    const phases = buildPhases(tasks)
    expect(phases).toHaveLength(1)
    expect(phases[0]).toHaveLength(3)
  })

  it('orders dependent tasks into separate phases', () => {
    const tasks = [
      makeTask({ id: 'a', prompt: 'x' }),
      makeTask({ id: 'b', prompt: 'y', depends_on: ['a'] }),
      makeTask({ id: 'c', prompt: 'z', depends_on: ['b'] }),
    ]
    const phases = buildPhases(tasks)
    expect(phases).toHaveLength(3)
    expect(phases[0].map((t) => t.id)).toEqual(['a'])
    expect(phases[1].map((t) => t.id)).toEqual(['b'])
    expect(phases[2].map((t) => t.id)).toEqual(['c'])
  })

  it('handles diamond dependency pattern', () => {
    const tasks = [
      makeTask({ id: 'a', prompt: 'x' }),
      makeTask({ id: 'b', prompt: 'y', depends_on: ['a'] }),
      makeTask({ id: 'c', prompt: 'z', depends_on: ['a'] }),
      makeTask({ id: 'd', prompt: 'w', depends_on: ['b', 'c'] }),
    ]
    const phases = buildPhases(tasks)
    expect(phases).toHaveLength(3)
    expect(phases[0].map((t) => t.id)).toEqual(['a'])
    expect(phases[1].map((t) => t.id).sort()).toEqual(['b', 'c'])
    expect(phases[2].map((t) => t.id)).toEqual(['d'])
  })

  it('handles single task', () => {
    const phases = buildPhases([makeTask({ id: 'solo', prompt: 'x' })])
    expect(phases).toHaveLength(1)
    expect(phases[0]).toHaveLength(1)
  })

  it('handles complex fan-out/fan-in', () => {
    const tasks = [
      makeTask({ id: 'root', prompt: 'x' }),
      makeTask({ id: 'b1', prompt: 'y', depends_on: ['root'] }),
      makeTask({ id: 'b2', prompt: 'y', depends_on: ['root'] }),
      makeTask({ id: 'b3', prompt: 'y', depends_on: ['root'] }),
      makeTask({ id: 'join', prompt: 'z', depends_on: ['b1', 'b2', 'b3'] }),
    ]
    const phases = buildPhases(tasks)
    expect(phases).toHaveLength(3)
    expect(phases[1]).toHaveLength(3)
  })
})

// ── createExecutor ─────────────────────────────────────────────

describe('createExecutor', () => {
  it('executes all tasks and reports success', async () => {
    const spec: TaskSpec = {
      name: 'test-run',
      concurrency: 2,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y' }),
      ],
    }
    const reporter = makeReporter()
    const executor = createExecutor(spec, makeAdapter(), reporter)
    const report = await executor.run()

    expect(report.summary.total).toBe(2)
    expect(report.summary.done).toBe(2)
    expect(report.summary.failed).toBe(0)
    expect(reporter.started).toEqual(['a', 'b'])
  })

  it('skips dependents when a task fails (on_failure: continue)', async () => {
    const spec: TaskSpec = {
      name: 'test-run',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y', depends_on: ['a'] }),
      ],
    }
    const adapter = makeAdapter({ a: { success: false, exitCode: 1 } })
    const reporter = makeReporter()
    const executor = createExecutor(spec, adapter, reporter)
    const report = await executor.run()

    expect(report.summary.failed).toBe(1)
    expect(report.summary.skipped).toBe(1)
    expect(reporter.skipped).toContain('b')
  })

  it('halts all tasks on failure when on_failure: stop', async () => {
    const spec: TaskSpec = {
      name: 'test-run',
      concurrency: 1,
      on_failure: 'stop',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y' }),
        makeTask({ id: 'c', prompt: 'z' }),
      ],
    }
    const adapter = makeAdapter({ a: { success: false, exitCode: 1 } })
    const reporter = makeReporter()
    const executor = createExecutor(spec, adapter, reporter)
    const report = await executor.run()

    expect(report.summary.failed).toBe(1)
    expect(report.summary.skipped).toBe(2)
  })

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const adapter: AgentAdapter = {
      name: 'test',
      isAvailable: async () => true,
      execute: async (task) => {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        await new Promise((r) => setTimeout(r, 50))
        currentConcurrent--
        return { success: true, output: '', exitCode: 0 }
      },
    }

    const spec: TaskSpec = {
      name: 'test',
      concurrency: 2,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y' }),
        makeTask({ id: 'c', prompt: 'z' }),
        makeTask({ id: 'd', prompt: 'w' }),
      ],
    }

    const executor = createExecutor(spec, adapter, makeReporter())
    await executor.run()

    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('reports phase starts', async () => {
    const spec: TaskSpec = {
      name: 'test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y', depends_on: ['a'] }),
      ],
    }
    const reporter = makeReporter()
    const executor = createExecutor(spec, reporter as unknown as AgentAdapter, reporter)
    // Actually use the adapter
    const executor2 = createExecutor(spec, makeAdapter(), reporter)
    await executor2.run()

    expect(reporter.phases).toContain(1)
    expect(reporter.phases).toContain(2)
  })

  it('records duration on the report', async () => {
    const spec: TaskSpec = {
      name: 'test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [makeTask({ id: 'a', prompt: 'x' })],
    }
    const executor = createExecutor(spec, makeAdapter(), makeReporter())
    const report = await executor.run()

    expect(report.duration).toBeDefined()
    expect(report.startedAt).toBeDefined()
    expect(report.completedAt).toBeDefined()
    expect(report.name).toBe('test')
  })

  it('handles adapter throwing errors', async () => {
    const adapter: AgentAdapter = {
      name: 'failing',
      isAvailable: async () => true,
      execute: async () => { throw new Error('Adapter crashed') },
    }
    const spec: TaskSpec = {
      name: 'test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [makeTask({ id: 'a', prompt: 'x' })],
    }
    const reporter = makeReporter()
    const executor = createExecutor(spec, adapter, reporter)
    const report = await executor.run()

    expect(report.summary.failed).toBe(1)
    expect(report.tasks[0].output).toContain('Adapter crashed')
  })

  it('getPhases returns the computed phases', () => {
    const spec: TaskSpec = {
      name: 'test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y', depends_on: ['a'] }),
      ],
    }
    const executor = createExecutor(spec, makeAdapter(), makeReporter())
    const phases = executor.getPhases()
    expect(phases).toHaveLength(2)
  })

  it('skips transitive dependents on failure', async () => {
    const spec: TaskSpec = {
      name: 'test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      tasks: [
        makeTask({ id: 'a', prompt: 'x' }),
        makeTask({ id: 'b', prompt: 'y', depends_on: ['a'] }),
        makeTask({ id: 'c', prompt: 'z', depends_on: ['b'] }),
      ],
    }
    const adapter = makeAdapter({ a: { success: false, exitCode: 1 } })
    const reporter = makeReporter()
    const executor = createExecutor(spec, adapter, reporter)
    const report = await executor.run()

    expect(report.summary.failed).toBe(1)
    expect(report.summary.skipped).toBe(2)
    expect(reporter.skipped).toContain('b')
    expect(reporter.skipped).toContain('c')
  })
})

// ── formatDuration ─────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5s')
  })

  it('formats minutes', () => {
    expect(formatDuration(120_000)).toBe('2m')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(125_000)).toBe('2m 5s')
  })

  it('formats hours', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0ms')
  })
})
