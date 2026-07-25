import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyStore } from './store.js'
import type { ConvoyStore } from './store.js'
import type { ConvoyEventEmitter } from './events.js'
import { createHealthMonitor, detectDrift } from './health.js'
import type { HealthMonitorOptions } from './health.js'
import type { AgentAdapter } from './spec-types.js'

// ── fixtures ──────────────────────────────────────────────────────────────────

const CONVOY_ID = 'convoy-1'

type EmittedEvent = {
  type: string
  data?: Record<string, unknown>
  ids?: { convoy_id?: string; task_id?: string; worker_id?: string }
}

let tmpDir: string
let dbPath: string
let store: ConvoyStore
let emittedEvents: EmittedEvent[]
let mockEvents: ConvoyEventEmitter

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'))
  dbPath = join(tmpDir, 'test.db')
  store = createConvoyStore(dbPath)
  emittedEvents = []
  mockEvents = {
    emit(type, data, ids) {
      emittedEvents.push({ type, data, ids })
    },
    close() {},
  }
  store.insertConvoy({
    id: CONVOY_ID,
    name: 'Test Convoy',
    spec_hash: 'abc123',
    status: 'running',
    branch: null,
    created_at: new Date().toISOString(),
    spec_yaml: 'name: test',
  })
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeOptions(overrides: Partial<HealthMonitorOptions> = {}): HealthMonitorOptions {
  return { store, events: mockEvents, convoyId: CONVOY_ID, ...overrides }
}

function makeTask(
  overrides: Partial<Parameters<ConvoyStore['insertTask']>[0]> = {},
): Parameters<ConvoyStore['insertTask']>[0] {
  return {
    id: 'task-1',
    convoy_id: CONVOY_ID,
    phase: 0,
    prompt: 'Do something',
    agent: 'developer',
    adapter: null,
    model: null,
    timeout_ms: 60_000,
    status: 'running' as const,
    retries: 0,
    max_retries: 1,
    files: null,
    depends_on: null,
    gates: null as string | null,
    ...overrides,
  } as Parameters<ConvoyStore['insertTask']>[0]
}

function makeWorker(
  overrides: Partial<Parameters<ConvoyStore['insertWorker']>[0]> = {},
): Parameters<ConvoyStore['insertWorker']>[0] {
  return {
    id: 'worker-1',
    task_id: 'task-1',
    adapter: 'copilot',
    pid: null,
    session_id: null,
    status: 'running' as const,
    worktree: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

/** Insert a running task linked to a worker. */
function setupRunning(
  taskOverrides: Partial<Parameters<ConvoyStore['insertTask']>[0]> = {},
  workerOverrides: Partial<Parameters<ConvoyStore['insertWorker']>[0]> = {},
) {
  store.insertTask(makeTask(taskOverrides))
  store.insertWorker(makeWorker(workerOverrides))
  store.updateTaskStatus('task-1', CONVOY_ID, 'running', { worker_id: 'worker-1' })
}

/** ISO timestamp `msAgo` milliseconds in the past. */
function msBefore(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

// ── creation ──────────────────────────────────────────────────────────────────

describe('createHealthMonitor', () => {
  it('returns an object with start, stop, and check methods', () => {
    const monitor = createHealthMonitor(makeOptions())
    expect(typeof monitor.start).toBe('function')
    expect(typeof monitor.stop).toBe('function')
    expect(typeof monitor.check).toBe('function')
  })

  it('accepts custom intervalMs and stuckFactor without error', () => {
    expect(() =>
      createHealthMonitor(makeOptions({ intervalMs: 5_000, stuckFactor: 3 })),
    ).not.toThrow()
  })

  it('accepts an onKill callback', () => {
    expect(() => createHealthMonitor(makeOptions({ onKill: () => {} }))).not.toThrow()
  })
})

// ── start/stop lifecycle ──────────────────────────────────────────────────────

describe('start/stop lifecycle', () => {
  it('start() does not throw', () => {
    const monitor = createHealthMonitor(makeOptions())
    expect(() => monitor.start()).not.toThrow()
    monitor.stop()
  })

  it('stop() after start() does not throw', () => {
    const monitor = createHealthMonitor(makeOptions())
    monitor.start()
    expect(() => monitor.stop()).not.toThrow()
  })

  it('stop() without start() does not throw (idempotent)', () => {
    const monitor = createHealthMonitor(makeOptions())
    expect(() => monitor.stop()).not.toThrow()
  })

  it('calling start() twice does not create duplicate intervals', () => {
    vi.useFakeTimers()
    try {
      setupRunning()
      store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: new Date().toISOString() })
      const monitor = createHealthMonitor(makeOptions({ intervalMs: 1_000 }))
      monitor.start()
      monitor.start() // second call is no-op
      vi.advanceTimersByTime(1_000)
      // Only one interval fires; fresh heartbeat → zero events
      expect(emittedEvents).toHaveLength(0)
      monitor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('check() is invoked on each timer tick after start()', () => {
    vi.useFakeTimers()
    try {
      setupRunning({ timeout_ms: 60_000, max_retries: 5 })
      store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
      const monitor = createHealthMonitor(makeOptions({ intervalMs: 1_000, stuckFactor: 2 }))
      monitor.start()
      vi.advanceTimersByTime(1_000)
      expect(store.getTask('task-1', CONVOY_ID)!.status).toBe('pending')
      monitor.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── check() no-op cases ───────────────────────────────────────────────────────

describe('check() no-op cases', () => {
  it('does nothing when no tasks exist for the convoy', () => {
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing when all tasks are pending', () => {
    store.insertTask(makeTask({ status: 'pending' }))
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing when all tasks are done', () => {
    store.insertTask(makeTask({ status: 'done' }))
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing when all tasks are failed', () => {
    store.insertTask(makeTask({ status: 'failed' }))
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing for a running task with no worker_id', () => {
    store.insertTask(makeTask()) // worker_id stays NULL (insertTask always sets NULL)
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing for a running task when the worker record is not found', () => {
    store.insertTask(makeTask())
    store.updateTaskStatus('task-1', CONVOY_ID, 'running', { worker_id: 'ghost-worker' })
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing for a running task with fresh heartbeat and no pid', () => {
    setupRunning({ timeout_ms: 60_000 })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: new Date().toISOString() })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    expect(emittedEvents).toHaveLength(0)
  })

  it('does nothing for a running task with no heartbeat and no pid', () => {
    setupRunning() // no heartbeat set, no pid → neither check fires
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
  })
})

// ── stuck detection ───────────────────────────────────────────────────────────

describe('stuck detection', () => {
  function setupStuck(
    taskOverrides: Partial<Parameters<ConvoyStore['insertTask']>[0]> = {},
  ) {
    setupRunning({ timeout_ms: 60_000, ...taskOverrides })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
  }

  it('resets task to pending and increments retries when retries < max_retries', () => {
    setupStuck({ retries: 0, max_retries: 1 })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    const task = store.getTask('task-1', CONVOY_ID)!
    expect(task.status).toBe('pending')
    expect(task.retries).toBe(1)
  })

  it('marks worker as killed with a finished_at timestamp', () => {
    setupStuck()
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    const worker = store.getWorker('worker-1')!
    expect(worker.status).toBe('killed')
    expect(worker.finished_at).not.toBeNull()
  })

  it('marks task as failed when retries >= max_retries', () => {
    setupStuck({ retries: 1, max_retries: 1 })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    expect(store.getTask('task-1', CONVOY_ID)!.status).toBe('failed')
  })

  it('does NOT trigger when heartbeat is within the stuck threshold', () => {
    setupRunning({ timeout_ms: 60_000 })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(1_000) })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    expect(emittedEvents).toHaveLength(0)
    expect(store.getTask('task-1', CONVOY_ID)!.status).toBe('running')
  })

  it('also catches tasks in assigned status', () => {
    store.insertTask(makeTask({ timeout_ms: 60_000 }))
    store.insertWorker(makeWorker())
    store.updateTaskStatus('task-1', CONVOY_ID, 'assigned', { worker_id: 'worker-1' })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    const status = store.getTask('task-1', CONVOY_ID)!.status
    expect(['pending', 'failed']).toContain(status)
  })

  it('skips zombie check when stuck is already detected', () => {
    setupStuck()
    store.updateWorkerStatus('worker-1', 'running', { pid: 12_345 })
    const killSpy = vi.spyOn(process, 'kill')
    try {
      createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
      expect(killSpy).not.toHaveBeenCalled()
      expect(emittedEvents[0].data?.reason).toBe('stuck')
    } finally {
      killSpy.mockRestore()
    }
  })
})

// ── zombie detection ──────────────────────────────────────────────────────────

describe('zombie detection', () => {
  function setupZombie(
    taskOverrides: Partial<Parameters<ConvoyStore['insertTask']>[0]> = {},
  ) {
    setupRunning(taskOverrides, { pid: 999_999_999, status: 'running' })
  }

  it('resets task to pending and increments retries when retries < max_retries', () => {
    setupZombie({ retries: 0, max_retries: 1 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    try {
      createHealthMonitor(makeOptions()).check()
      const task = store.getTask('task-1', CONVOY_ID)!
      expect(task.status).toBe('pending')
      expect(task.retries).toBe(1)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('marks worker as killed with a finished_at timestamp', () => {
    setupZombie()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      throw new Error('ESRCH')
    })
    try {
      createHealthMonitor(makeOptions()).check()
      const worker = store.getWorker('worker-1')!
      expect(worker.status).toBe('killed')
      expect(worker.finished_at).not.toBeNull()
    } finally {
      killSpy.mockRestore()
    }
  })

  it('marks task as failed when retries >= max_retries', () => {
    setupZombie({ retries: 1, max_retries: 1 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      throw new Error('ESRCH')
    })
    try {
      createHealthMonitor(makeOptions()).check()
      expect(store.getTask('task-1', CONVOY_ID)!.status).toBe('failed')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('does NOT trigger when process is still alive', () => {
    setupRunning({}, { pid: process.pid, status: 'running' })
    // Real process.kill(process.pid, 0) must succeed — no mock needed
    createHealthMonitor(makeOptions()).check()
    expect(emittedEvents).toHaveLength(0)
    expect(store.getTask('task-1', CONVOY_ID)!.status).toBe('running')
  })

  it('does NOT trigger when worker status is not running (e.g. spawned)', () => {
    setupRunning({}, { pid: 999_999_999, status: 'spawned' })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      throw new Error('ESRCH')
    })
    try {
      createHealthMonitor(makeOptions()).check()
      expect(emittedEvents).toHaveLength(0)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('does NOT call process.kill when pid is null', () => {
    setupRunning({}, { pid: null })
    const killSpy = vi.spyOn(process, 'kill')
    try {
      createHealthMonitor(makeOptions()).check()
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })
})

// ── onKill callback ───────────────────────────────────────────────────────────

describe('onKill callback', () => {
  it('is called with workerId and taskId on stuck detection', () => {
    setupRunning({ timeout_ms: 60_000 })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
    const onKill = vi.fn()
    createHealthMonitor(makeOptions({ stuckFactor: 2, onKill })).check()
    expect(onKill).toHaveBeenCalledOnce()
    expect(onKill).toHaveBeenCalledWith('worker-1', 'task-1')
  })

  it('is called with workerId and taskId on zombie detection', () => {
    setupRunning({}, { pid: 999_999_999, status: 'running' })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      throw new Error('ESRCH')
    })
    try {
      const onKill = vi.fn()
      createHealthMonitor(makeOptions({ onKill })).check()
      expect(onKill).toHaveBeenCalledOnce()
      expect(onKill).toHaveBeenCalledWith('worker-1', 'task-1')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('does not throw when onKill is not provided', () => {
    setupRunning({ timeout_ms: 60_000 })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
    expect(() => createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()).not.toThrow()
  })
})

// ── event emission ────────────────────────────────────────────────────────────

describe('event emission', () => {
  it('emits worker_killed with reason stuck on stuck detection', () => {
    setupRunning({ timeout_ms: 60_000 })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    expect(emittedEvents).toHaveLength(1)
    expect(emittedEvents[0].type).toBe('worker_killed')
    expect(emittedEvents[0].data?.reason).toBe('stuck')
    expect(emittedEvents[0].data?.worker_id).toBe('worker-1')
    expect(emittedEvents[0].data?.task_id).toBe('task-1')
  })

  it('emits worker_killed with reason zombie on zombie detection', () => {
    setupRunning({}, { pid: 999_999_999, status: 'running' })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      throw new Error('ESRCH')
    })
    try {
      createHealthMonitor(makeOptions()).check()
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].type).toBe('worker_killed')
      expect(emittedEvents[0].data?.reason).toBe('zombie')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('includes convoy_id, task_id, worker_id in emitted event ids', () => {
    setupRunning({ timeout_ms: 60_000 })
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: msBefore(200_000) })
    createHealthMonitor(makeOptions({ stuckFactor: 2 })).check()
    const { ids } = emittedEvents[0]
    expect(ids?.convoy_id).toBe(CONVOY_ID)
    expect(ids?.task_id).toBe('task-1')
    expect(ids?.worker_id).toBe('worker-1')
  })
})

// ── detectDrift ───────────────────────────────────────────────────────────────

describe('detectDrift', () => {
  function makeTaskRecord(adapterName: string | null = null) {
    store.insertTask(makeTask({ id: 'drift-task', adapter: adapterName }))
    return store.getTask('drift-task', CONVOY_ID)!
  }

  function makeAgentAdapter(name: string, output: string): AgentAdapter {
    return {
      name,
      isAvailable: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({ success: true, output, exitCode: 0 }),
    } as unknown as AgentAdapter
  }

  it('non-streaming adapter returns score 1.0, drifted=false, and emits a warning', async () => {
    const taskRecord = makeTaskRecord(null)
    const adapter = makeAgentAdapter('vscode', 'ok')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const result = await detectDrift(taskRecord, adapter)
      expect(result.score).toBe(1.0)
      expect(result.drifted).toBe(false)
      expect(result.explanation).toContain('non-streaming adapter')
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('drift detection skipped'))
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('streaming adapter with high confidence score returns drifted=false', async () => {
    const taskRecord = makeTaskRecord('copilot')
    const adapter = makeAgentAdapter('copilot', '{"score": 0.95, "explanation": "very confident"}')
    const result = await detectDrift(taskRecord, adapter)
    expect(result.score).toBe(0.95)
    expect(result.drifted).toBe(false)
    expect(result.explanation).toBe('very confident')
  })

  it('streaming adapter with low confidence score returns drifted=true', async () => {
    const taskRecord = makeTaskRecord('copilot')
    const adapter = makeAgentAdapter('copilot', '{"score": 0.4, "explanation": "not confident"}')
    const result = await detectDrift(taskRecord, adapter)
    expect(result.score).toBe(0.4)
    expect(result.drifted).toBe(true)
    expect(result.threshold).toBe(0.8)
  })

  it('parse failure returns score 0.5 and drifted=true (below default threshold)', async () => {
    const taskRecord = makeTaskRecord('copilot')
    const adapter = makeAgentAdapter('copilot', 'I cannot rate myself')
    const result = await detectDrift(taskRecord, adapter)
    expect(result.score).toBe(0.5)
    expect(result.drifted).toBe(true)
    expect(result.explanation).toContain('Could not parse')
  })
})
