import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyEngine, evaluateReviewLevel, runConvoyGuard } from './engine.js'
import { recoverNdjson, createEventEmitter } from './events.js'
import type { ConvoyEngineOptions, DiffStats } from './engine.js'
import { createConvoyStore } from './store.js'
import type { AgentAdapter, Task, TaskSpec, ExecuteResult } from './spec-types.js'
import type { WorktreeManager } from './worktree.js'
import type { MergeQueue } from './merge.js'
import type { TaskRecord } from './types.js'
import { getAdapter, detectAdapter } from '../run/adapters/index.js'
import * as gates from './gates.js'
import * as partition from './partition.js'

// ── Mock NDJSON log writes ────────────────────────────────────────────────────

vi.mock('../log.js', () => ({
  appendEvent: vi.fn().mockResolvedValue(undefined),
}))

// ── Mock runtime adapter registry ────────────────────────────────────────────

vi.mock('../run/adapters/index.js', () => ({
  getAdapter: vi.fn(),
  detectAdapter: vi.fn(),
}))

// ── Fixture helpers ───────────────────────────────────────────────────────────

type MockAdapter = AgentAdapter & {
  execute: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

type MockWorktreeManager = WorktreeManager & {
  create: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  removeAll: ReturnType<typeof vi.fn>
}

type MockMergeQueue = MergeQueue & { merge: ReturnType<typeof vi.fn> }

function makeAdapter(name = 'test-adapter'): MockAdapter {
  return {
    name,
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
    } satisfies ExecuteResult),
    kill: vi.fn(),
  } as unknown as MockAdapter
}

function makeWorktreeManager(): MockWorktreeManager {
  return {
    create: vi.fn().mockResolvedValue('/tmp/worktree-mock'),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    removeAll: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMergeQueue(): MockMergeQueue {
  return {
    merge: vi.fn().mockResolvedValue({ success: true, conflicted: false, message: 'ok' }),
  }
}

/** Build a minimal TaskSpec — branch:'main' avoids a git subprocess call. */
function makeSpec(
  specOverrides: Partial<TaskSpec> = {},
  taskOverrides: Partial<Task>[] = [{}],
): TaskSpec {
  const tasks: Task[] = taskOverrides.map((overrides, i) => ({
    id: `task-${i + 1}`,
    prompt: `Prompt for task ${i + 1}`,
    agent: 'developer',
    timeout: '30s',
    depends_on: [],
    files: [],
    description: '',
    max_retries: 0,
    ...overrides,
  }))
  return {
    name: 'Test Convoy',
    concurrency: 1,
    on_failure: 'continue',
    adapter: 'test',
    branch: 'main',
    tasks,
    ...specOverrides,
  }
}

/** A non-terminal output stream that remembers what the engine printed. */
function captureOutput(): { stream: { write(s: string): boolean; isTTY: boolean }; text(): string } {
  const chunks: string[] = []
  return {
    stream: { isTTY: false, write: (s: string) => { chunks.push(s); return true } },
    // Colour codes stripped, so assertions read like the terminal.
    // eslint-disable-next-line no-control-regex
    text: () => chunks.join('').replace(/\x1b\[[0-9;]*m/g, ''),
  }
}

/** Wraps createConvoyEngine with a default no-op _ensureBranch mock so tests never
 * run real git branch operations. Callers can override _ensureBranch if needed. */
function makeEngine(opts: ConvoyEngineOptions): ReturnType<typeof createConvoyEngine> {
  return createConvoyEngine({
    logsDir: join(tmpDir, 'logs'),  // prevents test data in production logs
    basePath: tmpDir,               // ditto for the .opencastle/ ledgers
    _ensureBranch: vi.fn().mockResolvedValue(undefined),
    _convoyWorktreeDir: null,
    handleSignals: false,
    output: captureOutput().stream,
    ...opts,
  })
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string

beforeEach(() => {
  // Throw by default so accidental unmocked getAdapter/detectAdapter calls surface immediately
  vi.mocked(getAdapter).mockRejectedValue(new Error('unmocked getAdapter call'))
  vi.mocked(detectAdapter).mockRejectedValue(new Error('unmocked detectAdapter call'))
  tmpDir = mkdtempSync(join(tmpdir(), 'engine-test-'))
  dbPath = join(tmpDir, 'convoy.db')
})

afterEach(() => {
  vi.clearAllMocks()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── 1. Single task success ────────────────────────────────────────────────────

describe('single task success', () => {
  it('returns status done with summary.done=1', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.summary.total).toBe(1)
    expect(result.summary.done).toBe(1)
    expect(result.summary.failed).toBe(0)
    expect(result.summary.skipped).toBe(0)
    expect(typeof result.convoyId).toBe('string')
    expect(typeof result.duration).toBe('string')
  })

  it('calls adapter.execute once with the correct task', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(adapter.execute).toHaveBeenCalledOnce()
    const [task] = adapter.execute.mock.calls[0] as [Task]
    expect(task.id).toBe('task-1')
  })
})

// ── 2. Single task failure ────────────────────────────────────────────────────

describe('single task failure', () => {
  it('returns status failed with summary.failed=1 when task errors and no retries allowed', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'boom', exitCode: 1 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
    expect(result.summary.done).toBe(0)
  })

  it('leaves a session that already exited alone', async () => {
    // kill() is for a session still running — a timeout or Ctrl+C. The old
    // engine also called it after every failure, on a process already gone.
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'boom', exitCode: 1 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(adapter.kill).not.toHaveBeenCalled()
  })

  it('prints the first line of the reason on the ✗ line', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'TypeError: x is undefined\n    at foo (a.ts:1)', exitCode: 1 })
    const out = captureOutput()
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      output: out.stream,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    await engine.run()
    const line = out.text().split('\n').find(l => l.includes('✗') && l.includes('[task-1]'))!
    expect(line).toContain('failed')
    expect(line).toContain('TypeError: x is undefined')
    expect(line).not.toContain('at foo')
  })
})

// ── 3. Two-phase DAG ─────────────────────────────────────────────────────────

describe('two-phase DAG (task-b depends on task-a)', () => {
  it('executes task-a before task-b and both succeed', async () => {
    const executeOrder: string[] = []
    const adapter = makeAdapter()
    adapter.execute.mockImplementation((task: Task) => {
      executeOrder.push(task.id)
      return Promise.resolve({ success: true, output: 'ok', exitCode: 0 })
    })

    const spec = makeSpec({}, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(2)
    expect(executeOrder).toEqual(['task-a', 'task-b'])
  })

  it('does not start dependent task until dependency is done', async () => {
    let maxConcurrent = 0
    let active = 0
    const adapter = makeAdapter()
    adapter.execute.mockImplementation(async () => {
      active++
      maxConcurrent = Math.max(maxConcurrent, active)
      await new Promise<void>(r => setTimeout(r, 5))
      active--
      return { success: true, output: 'ok', exitCode: 0 }
    })

    const spec = makeSpec({ concurrency: 4 }, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    // Even with high concurrency, dependent tasks may not overlap with their dependency
    expect(maxConcurrent).toBeLessThanOrEqual(1)
  })
})

// ── 4. on_failure:continue ────────────────────────────────────────────────────

describe('on_failure:continue', () => {
  it('skips dependents of the failed task but continues independent tasks', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockImplementation((task: Task) => {
      if (task.id === 'task-a') {
        return Promise.resolve({ success: false, output: 'fail', exitCode: 1 })
      }
      return Promise.resolve({ success: true, output: 'ok', exitCode: 0 })
    })

    // order by id: task-a and task-c are phase 0 (task-a first alphabetically)
    // task-b (depends task-a) is phase 1 and gets skipped
    const spec = makeSpec({ on_failure: 'continue' }, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] },
      { id: 'task-c', depends_on: [] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
    expect(result.summary.done).toBe(1)
    expect(result.summary.skipped).toBe(1)

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    const byId = Object.fromEntries(tasks.map(t => [t.id, t.status]))
    expect(byId['task-a']).toBe('failed')
    expect(byId['task-b']).toBe('skipped')
    expect(byId['task-c']).toBe('done')
  })

  it('skips transitive dependents recursively (chain a→b→c)', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockImplementation((task: Task) => {
      if (task.id === 'task-a') {
        return Promise.resolve({ success: false, output: 'fail', exitCode: 1 })
      }
      return Promise.resolve({ success: true, output: 'ok', exitCode: 0 })
    })

    const spec = makeSpec({ on_failure: 'continue' }, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] },
      { id: 'task-c', depends_on: ['task-b'] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.summary.failed).toBe(1)
    expect(result.summary.skipped).toBe(2)
    expect(result.summary.done).toBe(0)
  })
})

// ── 5. on_failure:stop ────────────────────────────────────────────────────────

describe('on_failure:stop', () => {
  it('skips all pending tasks when on_failure is stop', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'fail', exitCode: 1 })

    // task-b and task-c depend on task-a — both pending when task-a fails
    const spec = makeSpec({ on_failure: 'stop' }, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] },
      { id: 'task-c', depends_on: ['task-a'] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
    expect(result.summary.skipped).toBe(2)
    expect(result.summary.done).toBe(0)

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    const byId = Object.fromEntries(tasks.map(t => [t.id, t.status]))
    expect(byId['task-a']).toBe('failed')
    expect(byId['task-b']).toBe('skipped')
    expect(byId['task-c']).toBe('skipped')
  })

  it('still retries a task up to max_retries — stop is about what happens after it fails for good', async () => {
    // The spec builder's default was `stop`, and it used to turn off every
    // retry in every generated plan.
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'fail', exitCode: 1 })

    const spec = makeSpec({ on_failure: 'stop' }, [{ id: 'task-1', max_retries: 3 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(adapter.execute).toHaveBeenCalledTimes(4)
  })

  it('lets running tasks finish and starts nothing new once a task has failed for good', async () => {
    const started: string[] = []
    const adapter = makeAdapter()
    adapter.execute.mockImplementation(async (task: Task) => {
      started.push(task.id)
      if (task.id === 'a-fails') return { success: false, output: 'nope', exitCode: 1 }
      await new Promise(r => setTimeout(r, 60))
      return { success: true, output: 'ok', exitCode: 0 }
    })
    // Two slots: `fails` and `slow` start together; `later` is queued behind them.
    const spec = makeSpec({ on_failure: 'stop', concurrency: 2 }, [
      { id: 'a-fails' },
      { id: 'b-slow' },
      { id: 'c-later' },
    ])
    const engine = makeEngine({
      spec, specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(started.sort()).toEqual(['a-fails', 'b-slow'])
    const store = createConvoyStore(dbPath)
    const byId = Object.fromEntries(store.getTasksByConvoy(result.convoyId).map(t => [t.id, t.status]))
    store.close()
    expect(byId).toEqual({ 'a-fails': 'failed', 'b-slow': 'done', 'c-later': 'skipped' })
    expect(result.status).toBe('failed')
  })
})

// ── 6. Task retry ─────────────────────────────────────────────────────────────

describe('task retry', () => {
  it('re-runs a task that fails and succeeds on second attempt', async () => {
    const adapter = makeAdapter()
    // Add small delays so Date.now() advances between worker insertions on retry
    adapter.execute
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: false, output: 'first attempt failed', exitCode: 1 }
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: true, output: 'second attempt ok', exitCode: 0 }
      })

    const spec = makeSpec({}, [{ id: 'task-1', max_retries: 1 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(1)
    expect(adapter.execute).toHaveBeenCalledTimes(2)
  })

  it('marks task as failed when retries are exhausted', async () => {
    const adapter = makeAdapter()
    // Small delay ensures Date.now() advances between each worker insertion on retry
    adapter.execute.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 5))
      return { success: false, output: 'always fails', exitCode: 1 }
    })

    const spec = makeSpec({}, [{ id: 'task-1', max_retries: 2 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    // 1 original + 2 retries = 3 total calls
    expect(adapter.execute).toHaveBeenCalledTimes(3)
    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
  })
})

// ── 7. Validation gates ───────────────────────────────────────────────────────

describe('validation gates', () => {
  it('returns status done when all gates pass', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({ gates: ['echo gate-ok'] }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.gateResults).toHaveLength(1)
    expect(result.gateResults![0]).toMatchObject({ command: 'echo gate-ok', exitCode: 0, passed: true })
  })

  it('returns status gate-failed when a gate exits non-zero', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({ gates: ['false'] }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('gate-failed')
    expect(result.gateResults).toHaveLength(1)
    expect(result.gateResults![0].passed).toBe(false)
  })

  it('returns undefined gateResults when spec has no gates', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.gateResults).toBeUndefined()
  })

  it('runs multiple gates and reports each result individually', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({ gates: ['echo first', 'false', 'echo third'] }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('gate-failed')
    expect(result.gateResults).toHaveLength(3)
    expect(result.gateResults![0].passed).toBe(true)
    expect(result.gateResults![1].passed).toBe(false)
    expect(result.gateResults![2].passed).toBe(true)
  })
})

// ── 8. Resume (crash recovery) ────────────────────────────────────────────────

describe('resume (crash recovery)', () => {
  function seedCrashedConvoy(convoyId: string, taskStatus: 'running' | 'assigned') {
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({
      id: convoyId,
      name: 'Crashed Convoy',
      spec_hash: 'abc123',
      status: 'running',
      branch: 'main',
      created_at: new Date().toISOString(),
      spec_yaml: 'name: test',
    })
    seeder.insertTask({
      id: 'task-1',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'Do something',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 30_000,
      status: taskStatus,
      retries: 0,
      max_retries: 0,
      files: null,
      depends_on: null,
      gates: null,
    })
    if (taskStatus === 'running') {
      seeder.insertWorker({
        id: 'worker-orphan',
        task_id: 'task-1',
        adapter: 'test',
        pid: null,
        session_id: null,
        status: 'running',
        worktree: null,
        created_at: new Date().toISOString(),
      })
      seeder.updateTaskStatus('task-1', convoyId, 'running', { worker_id: 'worker-orphan' })
    }
    seeder.close()
  }

  it('resets running tasks to pending, calls removeAll, and re-executes them', async () => {
    const convoyId = 'convoy-crashed-running'
    seedCrashedConvoy(convoyId, 'running')

    const adapter = makeAdapter()
    const wtManager = makeWorktreeManager()
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1' }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.resume(convoyId)

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(1)
    expect(result.convoyId).toBe(convoyId)
    expect(wtManager.removeAll).toHaveBeenCalledOnce()
    expect(adapter.execute).toHaveBeenCalledOnce()
  })

  it('resets assigned (not yet running) tasks to pending on resume', async () => {
    const convoyId = 'convoy-crashed-assigned'
    seedCrashedConvoy(convoyId, 'assigned')

    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1' }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.resume(convoyId)
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledOnce()
  })

  it('throws an error when the convoy is not found', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await expect(engine.resume('convoy-does-not-exist')).rejects.toThrow(
      'Convoy "convoy-does-not-exist" not found in store',
    )
  })

  it('falls back to spec.branch when convoy.branch is null', async () => {
    // Seed a convoy with branch=null to exercise the ?? fallback chain in resume
    const convoyId = 'convoy-null-branch'
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({
      id: convoyId,
      name: 'Null Branch Convoy',
      spec_hash: 'abc123',
      status: 'running',
      branch: null, // convoy has no recorded branch
      created_at: new Date().toISOString(),
      spec_yaml: 'name: test',
    })
    seeder.insertTask({
      id: 'task-1',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'Do something',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 30_000,
      status: 'pending',
      retries: 0,
      max_retries: 0,
      files: null,
      depends_on: null,
      gates: null,
    })
    seeder.close()

    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec({ branch: 'feature-branch' }), // spec.branch used as fallback
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.resume(convoyId)
    expect(result.status).toBe('done')
    expect(result.convoyId).toBe(convoyId)
  })

  it('calls getCurrentBranch in resume when convoy.branch and spec.branch are both absent', async () => {
    // Seed a convoy with branch=null; spec also has no branch — triggers getCurrentBranch()
    const convoyId = 'convoy-git-branch-resume'
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({
      id: convoyId,
      name: 'Git Branch Convoy',
      spec_hash: 'abc123',
      status: 'running',
      branch: null,
      created_at: new Date().toISOString(),
      spec_yaml: 'name: test',
    })
    seeder.insertTask({
      id: 'task-1',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'Do something',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 30_000,
      status: 'pending',
      retries: 0,
      max_retries: 0,
      files: null,
      depends_on: null,
      gates: null,
    })
    seeder.close()

    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: {
        name: 'Git Branch Convoy',
        concurrency: 1,
        on_failure: 'continue',
        adapter: 'test',
        // branch not set — getCurrentBranch() will be called
        tasks: [{ id: 'task-1', prompt: 'p', agent: 'dev', timeout: '30s', depends_on: [], files: [], description: '', max_retries: 0 }],
      },
      specYaml: 'name: git-test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.resume(convoyId)
    expect(result.status).toBe('done')
  })
})

// ── 9. Worktree lifecycle for non-copilot adapters ────────────────────────────

describe('worktree lifecycle (non-copilot)', () => {
  it('creates, merges, and removes a worktree on task success', async () => {
    const adapter = makeAdapter('developer')
    const wtManager = makeWorktreeManager()
    const mergeQueue = makeMergeQueue()

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })

    await engine.run()

    expect(wtManager.create).toHaveBeenCalledOnce()
    expect(mergeQueue.merge).toHaveBeenCalledOnce()
    expect(wtManager.remove).toHaveBeenCalledOnce()
  })

  it('removes the worktree but skips merge when task fails', async () => {
    const adapter = makeAdapter('developer')
    adapter.execute.mockResolvedValue({ success: false, output: 'err', exitCode: 1 })
    const wtManager = makeWorktreeManager()
    const mergeQueue = makeMergeQueue()

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })

    await engine.run()

    expect(wtManager.create).toHaveBeenCalledOnce()
    expect(mergeQueue.merge).not.toHaveBeenCalled()
    expect(wtManager.remove).toHaveBeenCalledOnce()
  })

  it('fails the task, never running it in the user checkout, when worktree creation throws', async () => {
    // It used to fall back to running the agent in basePath — the user's own tree.
    const adapter = makeAdapter('developer')
    const wtManager = makeWorktreeManager()
    wtManager.create.mockRejectedValue(new Error('git worktree unavailable'))
    const mergeQueue = makeMergeQueue()

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })

    const result = await engine.run()
    expect(result.status).toBe('failed')
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('fails the task and keeps its branch when the merge throws', async () => {
    // A merge error used to be logged under --verbose, set `merged = true`, and
    // delete the branch: the task read "done" and its work was gone.
    const adapter = makeAdapter('developer')
    const wtManager = makeWorktreeManager()
    const mergeQueue = makeMergeQueue()
    mergeQueue.merge.mockRejectedValue(new Error('cannot lock ref HEAD'))
    const out = captureOutput()

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      output: out.stream,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })

    const result = await engine.run()
    expect(result.status).toBe('failed')
    expect(wtManager.remove).toHaveBeenCalledWith('/tmp/worktree-mock', { keepBranch: true })

    const store = createConvoyStore(dbPath)
    const task = store.getTask('task-1', result.convoyId)!
    const events = store.getEvents(result.convoyId)
    store.close()
    expect(task.status).toBe('failed')
    expect(task.branch).toMatch(/^convoy-/)
    expect(result.keptBranches).toEqual([{ taskId: 'task-1', branch: task.branch }])
    const mergeFailed = events.find(e => e.type === 'merge_failed')!
    expect(JSON.parse(mergeFailed.data!)).toMatchObject({ branch: task.branch, error: 'cannot lock ref HEAD' })
    // Said where the person will see it, not only under --verbose.
    expect(out.text()).toContain('cannot lock ref HEAD')
    expect(out.text()).toContain(task.branch!)
  })
})

// ── 10. Copilot gets a worktree like every runtime ────────────────────────────

describe('copilot adapter', () => {
  it('runs in a worktree and is merged like any other runtime', async () => {
    // Copilot used to skip worktrees and work in the shared directory, never merged.
    const adapter = makeAdapter('copilot')
    const wtManager = makeWorktreeManager()
    const mergeQueue = makeMergeQueue()

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })

    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(wtManager.create).toHaveBeenCalledOnce()
    expect(mergeQueue.merge).toHaveBeenCalledOnce()
    expect(adapter.execute.mock.calls[0][1]).toMatchObject({ cwd: '/tmp/worktree-mock' })
  })
})

// ── 11. Timeout handling ──────────────────────────────────────────────────────

describe('timeout handling', () => {
  it('marks a task as timed-out when adapter result carries _timedOut flag', async () => {
    const adapter = makeAdapter()
    // Mirror what makeTimeoutPromise resolves with to exercise the _timedOut branch
    adapter.execute.mockResolvedValue({
      _timedOut: true,
      success: false,
      output: 'Task timed out',
      exitCode: -1,
    } satisfies ExecuteResult)

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('failed')
    expect(result.summary.timedOut).toBe(1)
  })

  it('retries a timed-out task when retries remain', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { _timedOut: true, success: false, output: 'timed out', exitCode: -1 }
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: true, output: 'ok', exitCode: 0 }
      })

    const engine = makeEngine({
      spec: makeSpec({ on_failure: 'continue' }, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
  })

  it('retries a timed-out task under on_failure: stop too', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({
      _timedOut: true,
      success: false,
      output: 'timed out',
      exitCode: -1,
    })

    const engine = makeEngine({
      spec: makeSpec({ on_failure: 'stop' }, [{ id: 'task-1', max_retries: 2 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.summary.timedOut).toBe(1)
    expect(adapter.execute).toHaveBeenCalledTimes(3)
  })
})

// ── 12. Adapter without kill method ──────────────────────────────────────────

describe('adapter without kill method', () => {
  it('handles missing kill gracefully on task failure', async () => {
    const adapter: AgentAdapter = {
      name: 'no-kill-adapter',
      isAvailable: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({ success: false, output: 'err', exitCode: 1 }),
      // kill intentionally absent
    }

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('failed')
  })

  it('handles missing kill gracefully on timeout', async () => {
    const adapter: AgentAdapter = {
      name: 'no-kill-adapter',
      isAvailable: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({
        _timedOut: true,
        success: false,
        output: 'timed out',
        exitCode: -1,
      }),
    }

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.summary.timedOut).toBe(1)
  })
})

// ── 13. Parallel task execution ───────────────────────────────────────────────

describe('parallel task execution', () => {
  it('runs independent tasks concurrently when concurrency > 1', async () => {
    let maxActive = 0
    let active = 0
    const adapter = makeAdapter()
    adapter.execute.mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(r => setTimeout(r, 10))
      active--
      return { success: true, output: 'ok', exitCode: 0 }
    })

    const spec = makeSpec({ concurrency: 3 }, [
      { id: 'task-1', depends_on: [] },
      { id: 'task-2', depends_on: [] },
      { id: 'task-3', depends_on: [] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.summary.done).toBe(3)
    expect(maxActive).toBeGreaterThan(1)
  })
})

// ── 14. Executor error (adapter.execute throws) ───────────────────────────────

describe('executor error', () => {
  it('treats a thrown execute error as task failure', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockRejectedValue(new Error('adapter crashed'))

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
  })
})

// ── 15. Verbose mode — covers all if(verbose) branches ───────────────────────

describe('verbose mode', () => {
  it('runs a successful task with verbose=true without throwing', async () => {
    const adapter = makeAdapter('developer')
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1' }]),
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('runs a failed task with skip cascade with verbose=true without throwing', async () => {
    const adapter = makeAdapter('developer')
    adapter.execute.mockImplementation((task: Task) => {
      if (task.id === 'task-a') return Promise.resolve({ success: false, output: 'fail', exitCode: 1 })
      return Promise.resolve({ success: true, output: 'ok', exitCode: 0 })
    })

    const spec = makeSpec({ on_failure: 'continue' }, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] }, // gets skipped — also triggers verbose skip log
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.summary.failed).toBe(1)
    expect(result.summary.skipped).toBe(1)
  })

  it('logs verbose message when retrying a failed task', async () => {
    const adapter = makeAdapter('developer')
    adapter.execute
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: false, output: 'first fail', exitCode: 1 }
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: true, output: 'ok', exitCode: 0 }
      })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('logs verbose message on permanent timeout', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({
      _timedOut: true,
      success: false,
      output: 'timed out',
      exitCode: -1,
    })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.summary.timedOut).toBe(1)
  })

  it('logs verbose message when retrying a timed-out task', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { _timedOut: true, success: false, output: 'timed out', exitCode: -1 }
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: true, output: 'ok', exitCode: 0 }
      })

    const engine = makeEngine({
      spec: makeSpec({ on_failure: 'continue' }, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })
})

// ── 16. msToTimeout branch coverage ──────────────────────────────────────────

describe('msToTimeout — timeout string representation', () => {
  it('runs a task with 1-hour timeout (covers hours branch of msToTimeout)', async () => {
    const adapter = makeAdapter()
    // parseTimeout('1h') = 3600000ms; msToTimeout(3600000) = '1h'
    const spec = makeSpec({}, [{ id: 'task-1', timeout: '1h' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('runs a task with 1-minute timeout (covers minutes branch of msToTimeout)', async () => {
    const adapter = makeAdapter()
    // parseTimeout('1m') = 60000ms; msToTimeout(60000) = '1m'
    const spec = makeSpec({}, [{ id: 'task-1', timeout: '1m' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })
})

// ── 17. Per-task adapter resolution ─────────────────────────────────────────

describe('per-task adapter resolution', () => {
  it('uses per-task adapter when task has adapter field set', async () => {
    const mainAdapter = makeAdapter('test')
    const altAdapter = makeAdapter('alt-adapter')
    vi.mocked(getAdapter).mockResolvedValue(altAdapter)

    const spec = makeSpec({}, [{ adapter: 'alt-adapter' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter: mainAdapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(getAdapter).toHaveBeenCalledWith('alt-adapter')
    expect(altAdapter.execute).toHaveBeenCalledOnce()
    expect(mainAdapter.execute).not.toHaveBeenCalled()
  })

  it('uses convoy-level adapter when task has no adapter field', async () => {
    const adapter = makeAdapter('test')
    const spec = makeSpec()
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(adapter.execute).toHaveBeenCalledOnce()
    expect(getAdapter).not.toHaveBeenCalled()
  })

  it('uses convoy-level adapter when task adapter matches convoy adapter name', async () => {
    const adapter = makeAdapter('test')
    // task.adapter === adapter.name → no per-task resolution
    const spec = makeSpec({}, [{ adapter: 'test' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(adapter.execute).toHaveBeenCalledOnce()
    expect(getAdapter).not.toHaveBeenCalled()
  })

  it('treats adapter: auto as the run’s own runtime, without detecting again', async () => {
    // `auto` used to re-run detection for every task and could land on a
    // runtime the user never chose.
    const mainAdapter = makeAdapter('test')

    const spec = makeSpec({}, [{ adapter: 'auto' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter: mainAdapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    expect(detectAdapter).not.toHaveBeenCalled()
    expect(getAdapter).not.toHaveBeenCalled()
    expect(mainAdapter.execute).toHaveBeenCalledOnce()
  })

  it('refuses an unknown per-task runtime before anything runs or is recorded', async () => {
    vi.mocked(getAdapter).mockRejectedValue(new Error('Unknown adapter "claud"'))
    const adapter = makeAdapter('test')
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'a' }, { id: 'b', adapter: 'claud' }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await expect(engine.run()).rejects.toThrow('Unknown adapter "claud"')
    expect(adapter.execute).not.toHaveBeenCalled()
    const store = createConvoyStore(dbPath)
    expect(store.getLatestConvoy()).toBeUndefined()
    store.close()
  })

  it('stores per-task adapter name in worker record', async () => {
    const altAdapter = makeAdapter('alt-adapter')
    vi.mocked(getAdapter).mockResolvedValue(altAdapter)

    const spec = makeSpec({}, [{ adapter: 'alt-adapter' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter: makeAdapter('test'),
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    const worker = store.getWorker(tasks[0].worker_id!)
    store.close()

    expect(worker!.adapter).toBe('alt-adapter')
  })
})

// ── 18. getCurrentBranch fallback ─────────────────────────────────────────────

describe('getCurrentBranch', () => {
  it('resolves the base branch from git when spec.branch is not set', async () => {
    const adapter = makeAdapter()
    // No spec.branch — forces getCurrentBranch() to call git
    const spec: TaskSpec = {
      name: 'Branch Test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      // branch intentionally omitted
      tasks: [{ id: 'task-1', prompt: 'p', agent: 'dev', timeout: '30s', depends_on: [], files: [], description: '', max_retries: 0 }],
    }

    const engine = makeEngine({
      spec,
      specYaml: 'name: branch-test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('falls back to "main" when git command fails (non-git basePath)', async () => {
    const adapter = makeAdapter()
    const spec: TaskSpec = {
      name: 'Fallback Branch Test',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      // branch not set — getCurrentBranch will fail because basePath is /tmp
      tasks: [{ id: 'task-1', prompt: 'p', agent: 'dev', timeout: '30s', depends_on: [], files: [], description: '', max_retries: 0 }],
    }

    const engine = makeEngine({
      spec,
      specYaml: 'name: fallback-test',
      adapter,
      basePath: tmpdir(), // not a git repo — git command will fail → fallback to 'main'
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })
})

// ── 19. Real timer timeout (covers makeTimeoutPromise callback at line 71) ────

describe('real timer timeout path', () => {
  it('marks task timed-out when the real internal timer fires via fake timers', async () => {
    vi.useFakeTimers()

    const adapter = makeAdapter()
    // adapter.execute returns a promise that never resolves — real timer wins the race
    adapter.execute.mockImplementation(() => new Promise<ExecuteResult>(() => {}))

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', timeout: '1s', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const runPromise = engine.run()
    // Advance time past the 1s timeout to trigger the internal setTimeout callback
    await vi.advanceTimersByTimeAsync(2000)
    const result = await runPromise

    vi.useRealTimers()

    expect(result.status).toBe('failed')
    expect(result.summary.timedOut).toBe(1)
  })
})

describe('diamond dependency skip', () => {
  it('handles diamond deps gracefully (task-c skipped via two paths)', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockImplementation((task: Task) => {
      if (task.id === 'task-a') return Promise.resolve({ success: false, output: 'fail', exitCode: 1 })
      return Promise.resolve({ success: true, output: 'ok', exitCode: 0 })
    })

    // Diamond: task-a → task-b → task-c AND task-a → task-c directly
    // When task-a fails, cascadeFailure tries to skip task-b and task-c directly.
    // skipTask(task-b) recursively skips task-c first.
    // Then when cascadeFailure tries skipTask(task-c) directly, task-c.status !== 'pending' → early return.
    const spec = makeSpec({ on_failure: 'continue' }, [
      { id: 'task-a', depends_on: [] },
      { id: 'task-b', depends_on: ['task-a'] },
      { id: 'task-c', depends_on: ['task-a', 'task-b'] }, // diamond
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.summary.failed).toBe(1)
    expect(result.summary.skipped).toBe(2) // task-b and task-c both skipped
    expect(result.summary.done).toBe(0)

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    const byId = Object.fromEntries(tasks.map(t => [t.id, t.status]))
    expect(byId['task-a']).toBe('failed')
    expect(byId['task-b']).toBe('skipped')
    expect(byId['task-c']).toBe('skipped')
  })
})

// ── 21. Cost tracking (usage propagation) ────────────────────────────────────

describe('cost tracking', () => {
  it('persists usage data to task record when adapter returns usage', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    } satisfies ExecuteResult)

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    expect(tasks[0].prompt_tokens).toBe(100)
    expect(tasks[0].completion_tokens).toBe(50)
    expect(tasks[0].total_tokens).toBe(150)
  })

  it('estimates token usage when adapter returns no usage', async () => {
    const adapter = makeAdapter()
    // default makeAdapter returns no usage field

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    expect(tasks[0].prompt_tokens).toBeGreaterThan(0)
    expect(tasks[0].completion_tokens).toBeGreaterThanOrEqual(0)
    expect(tasks[0].total_tokens).toBeGreaterThan(0)
  })

  it('aggregates total_tokens from multiple tasks to convoy record', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'ok', exitCode: 0, usage: { total_tokens: 100 } })
      .mockResolvedValueOnce({ success: true, output: 'ok', exitCode: 0, usage: { total_tokens: 200 } })

    const spec = makeSpec({ concurrency: 2 }, [
      { id: 'task-1', depends_on: [] },
      { id: 'task-2', depends_on: [] },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const convoy = store.getConvoy(result.convoyId)
    store.close()
    expect(convoy!.total_tokens).toBe(300)
  })

  it('includes cost in ConvoyResult when usage is available', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
      usage: { total_tokens: 75 },
    } satisfies ExecuteResult)

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    // No cost reported and no model named: the tokens are real, the cost is
    // unknown, and the total says it is incomplete.
    expect(result.cost).toEqual({ total_tokens: 75, estimated: true })
  })

  it('records what the runtime reported: cost, model and cache tokens', async () => {
    const adapter = makeAdapter('claude')
    adapter.execute.mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
      usage: { prompt_tokens: 45_000, completion_tokens: 812, total_tokens: 45_812, cache_read_tokens: 40_000, cache_write_tokens: 4_000 },
      costUsd: 0.1234,
      model: 'claude-sonnet-4-6',
    } satisfies ExecuteResult)

    const engine = makeEngine({
      spec: makeSpec(), specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const task = store.getTasksByConvoy(result.convoyId)[0]
    const convoy = store.getConvoy(result.convoyId)!
    store.close()
    expect(task).toMatchObject({
      total_tokens: 45_812,
      cache_read_tokens: 40_000,
      cache_write_tokens: 4_000,
      cost_usd: 0.1234,
      cost_estimated: 0,
      model: 'claude-sonnet-4-6',
    })
    expect(convoy.total_cost_usd).toBeCloseTo(0.1234)
    expect(convoy.cost_estimated).toBe(0)
    expect(convoy.adapter).toBe('claude')
    expect(result.cost).toEqual({ total_tokens: 45_812, total_cost_usd: 0.1234, estimated: false })
  })

  it('never prices by the adapter’s name, and flags an estimate as one', async () => {
    // "claude" is a runtime, not a model; pricing it as Sonnet produced figures
    // that looked measured and were not.
    const adapter = makeAdapter('claude')
    const engine = makeEngine({
      spec: makeSpec(), specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const task = store.getTasksByConvoy(result.convoyId)[0]
    const convoy = store.getConvoy(result.convoyId)!
    store.close()
    expect(task.model).toBeNull()
    expect(task.cost_usd).toBeNull()
    expect(task.cost_estimated).toBe(1)
    expect(task.total_tokens).toBeGreaterThan(0)
    expect(convoy.cost_estimated).toBe(1)
  })

  it('prices the model it was asked for when the runtime reports tokens but no cost — marked estimated', async () => {
    const adapter = makeAdapter('codex')
    adapter.execute.mockResolvedValue({
      success: true, output: 'ok', exitCode: 0,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    } satisfies ExecuteResult)
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', model: 'gpt-4o' }]), specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    const store = createConvoyStore(dbPath)
    const task = store.getTasksByConvoy(result.convoyId)[0]
    store.close()
    expect(task.cost_usd).toBeCloseTo(2.5)
    expect(task.cost_estimated).toBe(1)
    // The model is handed to the runtime as well.
    expect(adapter.execute.mock.calls[0][1]).toMatchObject({ model: 'gpt-4o' })
  })

  it('adds up every attempt, not only the last', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockResolvedValueOnce({ success: false, output: 'no', exitCode: 1, usage: { total_tokens: 100 }, costUsd: 0.01 })
      .mockResolvedValueOnce({ success: true, output: 'ok', exitCode: 0, usage: { total_tokens: 50 }, costUsd: 0.02 })
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 1 }]), specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    const store = createConvoyStore(dbPath)
    const task = store.getTasksByConvoy(result.convoyId)[0]
    store.close()
    expect(task.total_tokens).toBe(150)
    expect(task.cost_usd).toBeCloseTo(0.03)
  })

  it('includes estimated cost in ConvoyResult when adapter returns no usage data', async () => {
    const adapter = makeAdapter()
    // default makeAdapter returns no usage

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    expect(result.cost).toBeDefined()
    expect(result.cost!.total_tokens).toBeGreaterThan(0)
  })

  it('partial usage fields are persisted correctly (only total_tokens set)', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
      usage: { total_tokens: 42 },
    } satisfies ExecuteResult)

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    expect(tasks[0].total_tokens).toBe(42)
    expect(tasks[0].prompt_tokens).toBeNull()
    expect(tasks[0].completion_tokens).toBeNull()
  })

  it('convoy total_tokens uses estimated values when no task has usage', async () => {
    const adapter = makeAdapter()
    // default adapter returns no usage

    const engine = makeEngine({
      spec: makeSpec({ concurrency: 2 }, [
        { id: 'task-1', depends_on: [] },
        { id: 'task-2', depends_on: [] },
      ]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const convoy = store.getConvoy(result.convoyId)
    store.close()
    expect(convoy!.total_tokens).toBeGreaterThan(0)
    expect(result.cost).toBeDefined()
    expect(result.cost!.total_tokens).toBeGreaterThan(0)
  })
})

// ── 22. Progress reporting (always-on output) ─────────────────────────────────

describe('progress reporting', () => {
  function engineWith(out: ReturnType<typeof captureOutput>, spec: TaskSpec, adapter: MockAdapter) {
    return makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      output: out.stream,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
  }

  it('prints a start line and a finish line for each task', async () => {
    const out = captureOutput()
    await engineWith(out, makeSpec(), makeAdapter()).run()
    const text = out.text()
    expect(text).toMatch(/▶ \[task-1\] developer/)
    expect(text).toMatch(/✓ \[task-1\] \(\d+ms\)/)
  })

  it('does not print phases as barriers', async () => {
    const out = captureOutput()
    const spec = makeSpec({}, [{ id: 'task-a' }, { id: 'task-b', depends_on: ['task-a'] }])
    await engineWith(out, spec, makeAdapter()).run()
    expect(out.text()).not.toContain('Phase 1:')
  })

  it('prints no internal noise about missing output contracts', async () => {
    const out = captureOutput()
    await engineWith(out, makeSpec(), makeAdapter()).run()
    expect(out.text()).not.toContain('__contract_block')
    expect(out.text()).not.toContain('contract violation')
  })

  it('ends with the convoy id, the branch, the totals and the log path', async () => {
    const out = captureOutput()
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: 'ok', exitCode: 0, usage: { total_tokens: 1500 } })
    const result = await engineWith(out, makeSpec({ branch: 'feat/x' }), adapter).run()
    const text = out.text()
    expect(text).toContain(`Convoy: ${result.convoyId}`)
    expect(text).toContain('Branch: feat/x')
    expect(text).toContain('Merge:  git merge feat/x')
    expect(text).toMatch(/Spent: 1\.5K tokens \(est\.\)/)
    expect(text).toContain(`${result.convoyId}.ndjson`)
    expect(result.logPath).toBe(join(tmpDir, 'logs', 'convoys', `${result.convoyId}.ndjson`))
  })

  it('names every task that is not done, with its reason, and how to resume', async () => {
    const out = captureOutput()
    const adapter = makeAdapter()
    adapter.execute.mockImplementation(async (task: Task) =>
      task.id === 'task-a' ? { success: false, output: 'compile error in a.ts', exitCode: 2 } : { success: true, output: 'ok', exitCode: 0 })
    const spec = makeSpec({}, [{ id: 'task-a' }, { id: 'task-b', depends_on: ['task-a'] }])
    await engineWith(out, spec, adapter).run()
    const text = out.text()
    expect(text).toContain('• task-a (failed): compile error in a.ts')
    expect(text).toContain('• task-b (skipped): dependency "task-a" failed')
    expect(text).toContain('Resume with: opencastle convoy resume')
  })

  it('prints gate results with pass/fail indicators', async () => {
    const out = captureOutput()
    const spec = makeSpec({ gates: ['echo gate-ok', 'false'] }, [{ id: 'task-1' }])
    await engineWith(out, spec, makeAdapter()).run()
    const text = out.text()
    expect(text).toContain('Gates:')
    expect(text).toContain('✓ echo gate-ok')
    expect(text).toContain('✗ false')
  })

  it('prints retries with their reason', async () => {
    const out = captureOutput()
    const adapter = makeAdapter()
    adapter.execute
      .mockResolvedValueOnce({ success: false, output: 'flaky network', exitCode: 1 })
      .mockResolvedValueOnce({ success: true, output: 'ok', exitCode: 0 })
    await engineWith(out, makeSpec({}, [{ id: 'task-1', max_retries: 1 }]), adapter).run()
    expect(out.text()).toContain('⟳ [task-1] failed, retry 1/1: flaky network')
  })

  it('keeps one status line, redrawn in place, on a terminal', async () => {
    const chunks: string[] = []
    const tty = { isTTY: true, columns: 120, write: (s: string) => { chunks.push(s); return true } }
    const adapter = makeAdapter()
    adapter.execute.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20))
      return { success: true, output: 'ok', exitCode: 0 }
    })
    await makeEngine({
      spec: makeSpec({ concurrency: 2 }, [{ id: 'build-api' }, { id: 'write-tests' }, { id: 'docs' }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      output: tty,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    }).run()
    // eslint-disable-next-line no-control-regex
    const statuses = chunks.filter(ch => ch.startsWith('\r\x1b[2K') && ch.includes('▸')).map(ch => ch.replace(/\x1b\[[0-9;]*m/g, ''))
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.some(s => /▸ build-api, write-tests · 1 queued · 0\/3 done/.test(s))).toBe(true)
    // Nothing of the status line is left once the run has ended.
    expect(chunks.join('')).not.toMatch(/▸[^\n]*$/)
  })
})

// ── 23. Gate retry mechanism ──────────────────────────────────────────────────

describe('gate retry mechanism', () => {
  let tmpDir: string
  let adapter: MockAdapter
  let wtManager: MockWorktreeManager
  let mergeQueue: MockMergeQueue

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'convoy-gate-retry-'))
    adapter = makeAdapter()
    wtManager = makeWorktreeManager()
    mergeQueue = makeMergeQueue()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('gates pass on first attempt when gate_retries > 0 — no fix task run', async () => {
    const spec = makeSpec(
      { gates: [`node -e "process.exit(0)"`], gate_retries: 1 },
      [{ id: 'task-1' }],
    )
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      basePath: tmpDir,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    // Only task-1 executed, no fix task needed
    expect(adapter.execute).toHaveBeenCalledTimes(1)
  })

  it('defaults gate_retries to 0 (no retry on gate failure)', async () => {
    const spec = makeSpec({ gates: ['false'] }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      basePath: tmpDir,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()
    expect(result.status).toBe('gate-failed')
    // No fix task attempted — only task-1 was executed
    expect(adapter.execute).toHaveBeenCalledTimes(1)
  })

  it('calls adapter.execute with fix prompt when gates fail and retries available', async () => {
    const spec = makeSpec({ gates: ['false'], gate_retries: 1 }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      basePath: tmpDir,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()
    // The fix task should have been called (adapter.execute called for task-1 + gate-fix-1)
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    // The second call should be the fix task
    const fixCall = adapter.execute.mock.calls[1] as [Task]
    expect(fixCall[0].id).toBe('gate-fix-1')
    expect(fixCall[0].prompt).toContain('These checks failed after every task was merged')
    expect(fixCall[0].prompt).toContain('Command: false')
    // Gates still fail after fix, so final status is gate-failed
    expect(result.status).toBe('gate-failed')
  })

  it('stops retrying when fix task fails', async () => {
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'ok', exitCode: 0 }) // task-1
      .mockResolvedValueOnce({ success: false, output: 'fix failed', exitCode: 1 }) // gate-fix-1
    const spec = makeSpec({ gates: ['false'], gate_retries: 2 }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      basePath: tmpDir,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()
    // Only 2 adapter calls: task-1 + one failed fix attempt (no second retry)
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('gate-failed')
  })
})

// ── evaluateReviewLevel ───────────────────────────────────────────────────────

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    convoy_id: 'convoy-1',
    phase: 0,
    prompt: '',
    agent: 'developer',
    adapter: null,
    model: null,
    timeout_ms: 1_800_000,
    status: 'pending',
    worker_id: null,
    worktree: null,
    output: null,
    exit_code: null,
    started_at: null,
    finished_at: null,
    retries: 0,
    max_retries: 1,
    files: null,
    depends_on: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    cost_usd: null,
    gates: null,
    on_exhausted: 'dlq',
    injected: 0,
    provenance: null,
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
    ...overrides,
  }
}

function makeDiffStats(overrides: Partial<DiffStats> = {}): DiffStats {
  return {
    linesChanged: 5,
    filesChanged: 1,
    filePaths: ['src/components/Button.tsx'],
    ...overrides,
  }
}

describe('evaluateReviewLevel', () => {
  it('never picks a panel on its own — sensitive paths get a fast review, even when small', () => {
    // A panel is three reviewer sessions; only a spec that asks for one gets one.
    for (const filePaths of [['auth/session.ts'], ['src/auth/session.ts'], ['security/policy.ts']]) {
      expect(evaluateReviewLevel(makeTaskRecord(), makeDiffStats({ filePaths, linesChanged: 3, filesChanged: 1 }), undefined, true)).toBe('fast')
    }
  })

  it('gives sensitive agents a fast review rather than waving them through', () => {
    expect(evaluateReviewLevel(makeTaskRecord({ agent: 'security-expert' }), makeDiffStats())).toBe('fast')
    expect(evaluateReviewLevel(makeTaskRecord({ agent: 'data-engineer' }), makeDiffStats())).toBe('fast')
  })

  it('routes to auto-pass for writer agent', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'writer' }),
      makeDiffStats(),
    )
    expect(level).toBe('auto-pass')
  })

  it('routes to auto-pass for small diff (<=10 lines, <=2 files) with gates passing', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ linesChanged: 8, filesChanged: 2, filePaths: ['src/Button.tsx', 'src/Button.test.tsx'] }),
      undefined,
      true,
    )
    expect(level).toBe('auto-pass')
  })

  it('routes to fast for large diff (>200 lines)', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ linesChanged: 250, filesChanged: 3, filePaths: ['src/Big.tsx', 'src/Big.test.tsx', 'src/types.ts'] }),
    )
    expect(level).toBe('fast')
  })

  it('routes to fast for many files (>5)', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ linesChanged: 50, filesChanged: 6, filePaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }),
    )
    expect(level).toBe('fast')
  })

  it('defaults to fast for medium diff with developer agent', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'developer' }),
      makeDiffStats({ linesChanged: 50, filesChanged: 3, filePaths: ['src/Feature.tsx', 'src/Feature.test.tsx', 'src/types.ts'] }),
    )
    expect(level).toBe('fast')
  })

  it('custom heuristics: panel_paths mark a path sensitive', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ filePaths: ['billing/invoice.ts'], linesChanged: 2, filesChanged: 1 }),
      { panel_paths: ['billing/'] },
      true,
    )
    expect(level).toBe('fast')
  })

  it('custom heuristics: overrides auto_pass_agents', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'designer' }),
      makeDiffStats(),
      { auto_pass_agents: ['designer'] },
    )
    expect(level).toBe('auto-pass')
  })

  it('custom heuristics: smaller auto_pass_max_lines threshold', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ linesChanged: 5, filesChanged: 1, filePaths: ['src/x.ts'] }),
      { auto_pass_max_lines: 3 },
      true,
    )
    expect(level).toBe('fast') // 5 > 3 → not auto-pass
  })
})

// ── Review pipeline integration ───────────────────────────────────────────────

describe('review pipeline', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let wtManager: ReturnType<typeof makeWorktreeManager>
  let mergeQueue: ReturnType<typeof makeMergeQueue>

  beforeEach(() => {
    adapter = makeAdapter()
    wtManager = makeWorktreeManager()
    mergeQueue = makeMergeQueue()
  })

  function reviewEngine(spec: TaskSpec, runner?: ConvoyEngineOptions['_reviewRunner']) {
    return makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      ...(runner ? { _reviewRunner: runner } : {}),
    })
  }

  function readTasks(convoyId: string) {
    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(convoyId)
    const events = store.getEvents(convoyId)
    store.close()
    return { tasks, events }
  }

  it('task with review: none — reviewer not called, task succeeds', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 100, model: 'test' })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'none' } }, [{ review: 'none' }]), runner).run()
    expect(result.status).toBe('done')
    expect(runner).not.toHaveBeenCalled()
  })

  it('fast review is one reviewer session, and a pass lets the task merge', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 50, model: 'reviewer' })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } }), runner).run()
    expect(result.status).toBe('done')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'developer' }),
      'fast',
      'default',
      expect.objectContaining({ cwd: '/tmp/worktree-mock', prompt: 'Prompt for task 1', canRunReadOnly: true }),
    )
    expect(mergeQueue.merge).toHaveBeenCalledOnce()
  })

  it('a block with retries left re-runs the task with the feedback and its original prompt', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ verdict: 'block', feedback: 'Missing tests', tokens: 50, model: 'reviewer' })
      .mockResolvedValueOnce({ verdict: 'pass', feedback: '', tokens: 50, model: 'reviewer' })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } }, [{ max_retries: 1 }]), runner).run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    expect(runner).toHaveBeenCalledTimes(2)
    const secondPrompt = (adapter.execute.mock.calls[1] as [Task])[0].prompt
    expect(secondPrompt).toContain('Missing tests')
    expect(secondPrompt).toContain('Prompt for task 1')
  })

  it('a block with no retries left ends review-blocked', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'Insecure code', tokens: 50, model: 'reviewer' })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } }, [{ max_retries: 0 }]), runner).run()
    expect(result.status).toBe('failed')
    expect(readTasks(result.convoyId).tasks[0].status).toBe('review-blocked')
    expect(mergeQueue.merge).not.toHaveBeenCalled()
  })

  it('records a review that reached no verdict as skipped — never as a pass', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'skipped', feedback: 'the reviewer gave no verdict', tokens: 30, model: null })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } }), runner).run()
    expect(result.status).toBe('done')
    const { tasks, events } = readTasks(result.convoyId)
    expect(tasks[0].review_verdict).toBe('skipped')
    expect(events.some(e => e.type === 'review_verdict')).toBe(false)
    const skipped = events.find(e => e.type === 'review_skipped')!
    expect(JSON.parse(skipped.data!)).toEqual({ level: 'fast', reason: 'the reviewer gave no verdict' })
  })

  it('uses the default reviewer when none is injected: the task’s runtime, read-only, in its worktree', async () => {
    adapter.execute.mockImplementation(async (task: Task) =>
      task.id.endsWith('-review')
        ? { success: true, output: 'Looks fine.\n<!-- REVIEW_VERDICT { "verdict": "pass", "issues": [] } -->', exitCode: 0, usage: { total_tokens: 900 } }
        : { success: true, output: 'ok', exitCode: 0 })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } })).run()
    expect(result.status).toBe('done')
    const reviewCall = adapter.execute.mock.calls.find(([t]) => (t as Task).id === 'task-1-review')!
    expect(reviewCall[1]).toMatchObject({ cwd: '/tmp/worktree-mock', permissionMode: 'plan' })
    expect((reviewCall[0] as Task).prompt).toContain('Prompt for task 1')
    const task = readTasks(result.convoyId).tasks[0]
    expect(task).toMatchObject({ review_level: 'fast', review_verdict: 'pass', review_tokens: 900 })
  })

  it('panel: three reviewers, majority wins', async () => {
    let n = 0
    const runner = vi.fn().mockImplementation(() => {
      n++
      return Promise.resolve(n === 3
        ? { verdict: 'block', feedback: 'Minor issue', tokens: 30, model: 'reviewer' }
        : { verdict: 'pass', feedback: '', tokens: 30, model: 'reviewer' })
    })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'panel' } }), runner).run()
    expect(result.status).toBe('done')
    expect(runner).toHaveBeenCalledTimes(3)
    const task = readTasks(result.convoyId).tasks[0]
    expect(task).toMatchObject({ review_level: 'panel', review_verdict: 'pass', review_tokens: 90, panel_attempts: 1 })
  })

  it('panel: 2/3 block → retried with the blocking feedback', async () => {
    let n = 0
    const runner = vi.fn().mockImplementation(() => {
      n++
      return Promise.resolve(n <= 2
        ? { verdict: 'block', feedback: 'Critical bug', tokens: 30, model: 'reviewer' }
        : { verdict: 'pass', feedback: '', tokens: 30, model: 'reviewer' })
    })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'panel' } }, [{ max_retries: 1 }]), runner).run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    expect(runner).toHaveBeenCalledTimes(6)
    const secondPrompt = (adapter.execute.mock.calls[1] as [Task])[0].prompt
    expect(secondPrompt).toContain('Critical bug')
  })

  it('auto route: developer agent with an empty diff → auto-pass, no reviewer', async () => {
    const runner = vi.fn()
    const result = await reviewEngine(makeSpec({ defaults: { review: 'auto' } }), runner).run()
    expect(result.status).toBe('done')
    expect(runner).not.toHaveBeenCalled()
    expect(readTasks(result.convoyId).tasks[0]).toMatchObject({ review_level: 'auto-pass', review_verdict: 'pass', review_model: null })
  })

  it('review tokens are tracked on the task and the reviewer cost is added to it', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 77, model: 'reviewer', costUsd: 0.05 })
    adapter.execute.mockResolvedValue({ success: true, output: 'ok', exitCode: 0, usage: { total_tokens: 10 }, costUsd: 0.1 })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } }), runner).run()
    const task = readTasks(result.convoyId).tasks[0]
    expect(task.review_tokens).toBe(77)
    expect(task.cost_usd).toBeCloseTo(0.15)
    expect(result.cost?.total_tokens).toBe(87)
  })

  it('review_started and review_verdict events emitted', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 10, model: 'reviewer' })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'fast' } }), runner).run()
    const { events } = readTasks(result.convoyId)
    expect(events.find(e => e.type === 'review_started')).toBeDefined()
    expect(events.find(e => e.type === 'review_verdict')).toBeDefined()
  })

  it('review sessions do NOT count against concurrency limit', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 10, model: 'reviewer' })
    const result = await reviewEngine(makeSpec({ concurrency: 1, defaults: { review: 'fast' } }, [{ id: 'task-1' }, { id: 'task-2' }]), runner).run()
    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(2)
  })

  it('dispute: three blocked panels open a dispute whose id matches the task', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'broken', tokens: 5, model: 'r' })
    const result = await reviewEngine(makeSpec({ defaults: { review: 'panel' } }, [{ id: 'task-1', max_retries: 3 }]), runner).run()
    const { tasks, events } = readTasks(result.convoyId)
    const task = tasks[0]
    expect(task.status).toBe('disputed')
    expect(task.dispute_id).not.toBeNull()
    expect(task.panel_attempts).toBe(3)
    const eventData = JSON.parse(events.find(e => e.type === 'dispute_opened')!.data!) as Record<string, unknown>
    expect(eventData['dispute_id']).toBe(task.dispute_id)
    expect(eventData['panel_attempts']).toBe(3)
  })

  it('review budget spent with skip — later reviews are recorded as skipped, not passed', async () => {
    const runner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 200, model: 'reviewer' })
    const spec = makeSpec(
      { defaults: { review: 'fast', review_budget: 100, on_review_budget_exceeded: 'skip' } },
      [{ id: 'task-1' }, { id: 'task-2', depends_on: ['task-1'] }],
    )
    const result = await reviewEngine(spec, runner).run()
    expect(result.status).toBe('done')
    expect(runner).toHaveBeenCalledTimes(1)
    const byId = Object.fromEntries(readTasks(result.convoyId).tasks.map(t => [t.id, t.review_verdict]))
    expect(byId).toEqual({ 'task-1': 'pass', 'task-2': 'skipped' })
  })

  it('review budget spent with stop: the task is review-blocked and nothing new starts', async () => {
    const runner = vi.fn()
    const spec = makeSpec(
      { defaults: { review: 'fast', review_budget: 0, on_review_budget_exceeded: 'stop' } },
      [{ id: 'task-1' }, { id: 'task-2', depends_on: ['task-1'] }],
    )
    const result = await reviewEngine(spec, runner).run()
    const byId = Object.fromEntries(readTasks(result.convoyId).tasks.map(t => [t.id, t.status]))
    expect(byId['task-1']).toBe('review-blocked')
    expect(byId['task-2']).toBe('skipped')
    expect(runner).not.toHaveBeenCalled()
  })
})


// ── Dispute protocol ──────────────────────────────────────────────────────────

describe('dispute protocol', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let wtManager: ReturnType<typeof makeWorktreeManager>
  let mergeQueue: ReturnType<typeof makeMergeQueue>

  beforeEach(() => {
    adapter = makeAdapter()
    wtManager = makeWorktreeManager()
    mergeQueue = makeMergeQueue()
  })

  it('3 panel blocks mark task as disputed', async () => {
    // Each round: 3 calls to panel runner (all block) → retry until max_retries
    // 3 panel blocks with max_retries=3 → 3 panel rounds → after 3rd: panel_attempts=3 → disputed
    let panelCall = 0
    const mockReviewRunner = vi.fn().mockImplementation(() => {
      panelCall++
      return Promise.resolve({ verdict: 'block', feedback: 'critical bug', tokens: 10, model: 'r' })
    })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'panel' } }, [{ id: 'task-1', max_retries: 3 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()

    expect(tasks[0].status).toBe('disputed')
    expect(tasks[0].dispute_id).not.toBeNull()
    expect(result.summary.failed).toBe(1) // disputed counts as failed in summary
  })

  it('dispute_opened event emitted after 3 panel blocks', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'bug', tokens: 5, model: 'r' })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'panel' } }, [{ id: 'task-1', max_retries: 3 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    store.close()

    const disputeEvent = events.find(e => e.type === 'dispute_opened')
    expect(disputeEvent).toBeDefined()
    const data = JSON.parse(disputeEvent!.data!) as Record<string, unknown>
    expect(data.task_id).toBe('task-1')
    expect(data.panel_attempts).toBe(3)
  })

  it('on_dispute: stop halts all pending tasks', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'bug', tokens: 5, model: 'r' })

    const engine = makeEngine({
      spec: makeSpec(
        { defaults: { review: 'panel', on_dispute: 'stop' } },
        [
          { id: 'task-1', depends_on: [], max_retries: 3 },
          { id: 'task-2', depends_on: ['task-1'] },  // depends on task-1, so queued after
        ],
      ),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    const byId = Object.fromEntries(tasks.map(t => [t.id, t.status]))
    expect(byId['task-1']).toBe('disputed')
    expect(byId['task-2']).toBe('skipped')
  })

  it('on_dispute: continue keeps other tasks running', async () => {
    // task-1 always fails panel (will be disputed), task-2 succeeds
    adapter.execute.mockResolvedValue({ success: true, output: 'ok', exitCode: 0 })
    const mockReviewRunner = vi.fn().mockImplementation((_task: TaskRecord) => {
      if (_task.id === 'task-1') {
        return Promise.resolve({ verdict: 'block', feedback: 'bug', tokens: 5, model: 'r' })
      }
      return Promise.resolve({ verdict: 'pass', feedback: '', tokens: 5, model: 'r' })
    })

    const engine = makeEngine({
      spec: makeSpec(
        { defaults: { review: 'panel', on_dispute: 'continue' } },
        [
          { id: 'task-1', depends_on: [], max_retries: 3 },
          { id: 'task-2', depends_on: [] },
        ],
      ),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    const byId = Object.fromEntries(tasks.map(t => [t.id, t.status]))
    expect(byId['task-1']).toBe('disputed')
    expect(byId['task-2']).toBe('done')
  })
})


describe('NDJSON recovery', () => {
  it('truncates partial trailing line in NDJSON file', () => {
    const convoyId = 'convoy-ndjson-1'
    const ndjsonPath = join(tmpDir, 'recover-partial.ndjson')
    const firstLine = JSON.stringify({ _event_id: 1, convoy_id: convoyId, type: 'task_started' })
    writeFileSync(ndjsonPath, `${firstLine}\n{"_event_id":2`, 'utf8')

    const mockStore = {
      getEvents: vi.fn().mockReturnValue([]),
    }

    recoverNdjson(mockStore as unknown as ReturnType<typeof createConvoyStore>, convoyId, ndjsonPath)

    const content = readFileSync(ndjsonPath, 'utf8')
    expect(content).toBe(`${firstLine}\n`)
  })

  it('replays SQLite events missing from NDJSON file', () => {
    const convoyId = 'convoy-ndjson-2'
    const ndjsonPath = join(tmpDir, 'recover-replay.ndjson')
    writeFileSync(
      ndjsonPath,
      `${JSON.stringify({ _event_id: 1, convoy_id: convoyId, type: 'task_started' })}\n`,
      'utf8',
    )

    const mockStore = {
      getEvents: vi.fn().mockReturnValue([
        {
          id: 1,
          type: 'task_started',
          convoy_id: convoyId,
          task_id: 'task-1',
          worker_id: null,
          data: JSON.stringify({ phase: 0 }),
          created_at: '2026-03-11T10:00:00.000Z',
        },
        {
          id: 2,
          type: 'task_finished',
          convoy_id: convoyId,
          task_id: 'task-1',
          worker_id: null,
          data: JSON.stringify({ success: true }),
          created_at: '2026-03-11T10:00:01.000Z',
        },
      ]),
    }

    recoverNdjson(mockStore as unknown as ReturnType<typeof createConvoyStore>, convoyId, ndjsonPath)

    const lines = readFileSync(ndjsonPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const eventIds = lines.map((line) => line._event_id)
    expect(eventIds).toEqual([1, 2])
  })

  it('does not let event.data override canonical fields', () => {
    const convoyId = 'convoy-ndjson-canonical'
    const ndjsonPath = join(tmpDir, 'recover-canonical.ndjson')
    writeFileSync(ndjsonPath, '', 'utf8')

    const mockStore = {
      getEvents: vi.fn().mockReturnValue([
        {
          id: 99,
          type: 'task_started',
          convoy_id: convoyId,
          task_id: 'task-legit',
          worker_id: 'w1',
          data: JSON.stringify({
            _event_id: 'EVIL',
            convoy_id: 'EVIL-CONVOY',
            task_id: 'EVIL-TASK',
            type: 'EVIL-TYPE',
            timestamp: 'EVIL-TIME',
            worker_id: 'EVIL-WORKER',
            safe_field: 'this-is-fine',
          }),
          created_at: '2026-03-11T10:00:00.000Z',
        },
      ]),
    }

    recoverNdjson(mockStore as unknown as ReturnType<typeof createConvoyStore>, convoyId, ndjsonPath)

    const lines = readFileSync(ndjsonPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(parsed._event_id).toBe(99)
    expect(parsed.convoy_id).toBe(convoyId)
    expect(parsed.task_id).toBe('task-legit')
    expect(parsed.type).toBe('task_started')
    expect(parsed.worker_id).toBe('w1')
    expect(parsed.timestamp).toBe('2026-03-11T10:00:00.000Z')
    expect(parsed.safe_field).toBe('this-is-fine')
  })
})

describe('runConvoyGuard', () => {
  it('returns passed: false when non-terminal tasks exist', () => {
    const guardConvoyId = 'convoy-guard-1'
    const guardStore = createConvoyStore(dbPath)
    guardStore.insertConvoy({
      id: guardConvoyId,
      name: 'Guard test',
      spec_hash: 'hash',
      spec_yaml: 'name: guard test',
      status: 'running',
      branch: null,
      created_at: new Date().toISOString(),
    })
    guardStore.insertTask({
      id: 'task-guard-1',
      convoy_id: guardConvoyId,
      phase: 0,
      prompt: 'test',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 60000,
      status: 'running',
      retries: 0,
      max_retries: 1,
      files: null,
      depends_on: null,
      gates: null,
    })

    const ndjsonPathGuard = join(tmpDir, 'guard-test.ndjson')
    writeFileSync(ndjsonPathGuard, '')
    const wtManager = makeWorktreeManager()
    const result = runConvoyGuard(guardStore, guardConvoyId, wtManager, ndjsonPathGuard)
    expect(result.passed).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
    guardStore.close()
  })

  it('returns passed: true when all tasks are terminal', () => {
    const guardConvoyId2 = 'convoy-guard-2'
    const guardStore2 = createConvoyStore(dbPath)
    guardStore2.insertConvoy({
      id: guardConvoyId2,
      name: 'Guard test ok',
      spec_hash: 'hash',
      spec_yaml: 'name: guard test ok',
      status: 'done',
      branch: null,
      created_at: new Date().toISOString(),
    })
    guardStore2.insertTask({
      id: 'task-guard-2',
      convoy_id: guardConvoyId2,
      phase: 0,
      prompt: 'test',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 60000,
      status: 'done',
      retries: 0,
      max_retries: 1,
      files: null,
      depends_on: null,
      gates: null,
    })

    const ndjsonPathGuard2 = join(tmpDir, 'guard-pass.ndjson')
    writeFileSync(ndjsonPathGuard2, JSON.stringify({ _event_id: 1, convoy_id: guardConvoyId2, type: 'task_done' }) + '\n')
    const wtManager2 = makeWorktreeManager()
    const result2 = runConvoyGuard(guardStore2, guardConvoyId2, wtManager2, ndjsonPathGuard2)
    expect(result2.passed).toBe(true)
    guardStore2.close()
  })
})

describe('injectTask partition validation', () => {
  it('rejects injected tasks with normalized path overlap', () => {
    const symlinkSpy = vi.spyOn(partition, 'scanSymlinks').mockImplementation(() => {})

    const convoyId = 'convoy-inject-overlap-1'
    const seedStore = createConvoyStore(dbPath)
    seedStore.insertConvoy({
      id: convoyId,
      name: 'Inject overlap test',
      spec_hash: 'hash-1',
      status: 'pending',
      branch: null,
      created_at: new Date().toISOString(),
      spec_yaml: 'name: inject-overlap',
      pipeline_id: null,
    })
    seedStore.insertTask({
      id: 'task-owner',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'Owns auth partition',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 30_000,
      status: 'pending',
      retries: 0,
      max_retries: 1,
      files: JSON.stringify(['src/auth/']),
      depends_on: null,
      gates: null,
    })
    seedStore.close()

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: inject-overlap',
      adapter: makeAdapter(),
      dbPath,
      basePath: tmpDir,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    try {
      expect(() => engine.injectTask(convoyId, {
        id: 'task-injected',
        prompt: 'Injected overlap task',
        agent: 'developer',
        phase: 0,
        files: ['src/auth/service.ts'],
      })).toThrow(/File partition overlap/i)
    } finally {
      symlinkSpy.mockRestore()
    }
  })

  it('rejects injected task with unnormalized paths that overlap', () => {
    const symlinkSpy = vi.spyOn(partition, 'scanSymlinks').mockImplementation(() => {})

    const convoyId = 'convoy-inject-overlap-2'
    const seedStore = createConvoyStore(dbPath)
    seedStore.insertConvoy({
      id: convoyId,
      name: 'Inject overlap test 2',
      spec_hash: 'hash-2',
      status: 'pending',
      branch: null,
      created_at: new Date().toISOString(),
      spec_yaml: 'name: inject-overlap-2',
      pipeline_id: null,
    })
    seedStore.insertTask({
      id: 'task-owner',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'Owns auth partition',
      agent: 'developer',
      adapter: null,
      model: null,
      timeout_ms: 30_000,
      status: 'pending',
      retries: 0,
      max_retries: 1,
      files: JSON.stringify(['src/auth/']),
      depends_on: null,
      gates: null,
    })
    seedStore.close()

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: inject-overlap-2',
      adapter: makeAdapter(),
      dbPath,
      basePath: tmpDir,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    try {
      expect(() => engine.injectTask(convoyId, {
        id: 'task-injected-dot-path',
        prompt: 'Injected overlap task',
        agent: 'developer',
        phase: 0,
        files: ['./src/auth/service.ts'],
      })).toThrow(/File partition overlap/i)
    } finally {
      symlinkSpy.mockRestore()
    }
  })
})

// ── Swarm mode ─────────────────────────────────────────────────────────────

describe('swarm mode (concurrency: auto)', () => {
  it('runs all tasks with auto concurrency', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec(
      { concurrency: 'auto' as unknown as number },
      [
        { id: 'task-1', prompt: 'First' },
        { id: 'task-2', prompt: 'Second' },
        { id: 'task-3', prompt: 'Third' },
      ],
    )

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(3)
    expect(result.summary.total).toBe(3)
  })

  it('respects max_swarm_concurrency from defaults', async () => {
    const adapter = makeAdapter()
    let maxConcurrent = 0
    let currentConcurrent = 0

    adapter.execute.mockImplementation(async () => {
      currentConcurrent++
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent
      await new Promise(resolve => setTimeout(resolve, 50))
      currentConcurrent--
      return { success: true, output: 'ok', exitCode: 0 }
    })

    const spec = makeSpec(
      {
        concurrency: 'auto' as unknown as number,
        defaults: { max_swarm_concurrency: 2 },
      },
      [
        { id: 'task-1', prompt: 'T1' },
        { id: 'task-2', prompt: 'T2' },
        { id: 'task-3', prompt: 'T3' },
        { id: 'task-4', prompt: 'T4' },
      ],
    )

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(4)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('runs at most four at once when the spec gives no number', async () => {
    const adapter = makeAdapter()
    let maxConcurrent = 0
    let current = 0
    adapter.execute.mockImplementation(async () => {
      current++
      maxConcurrent = Math.max(maxConcurrent, current)
      await new Promise(r => setTimeout(r, 20))
      current--
      return { success: true, output: 'ok', exitCode: 0 }
    })

    const spec = makeSpec(
      { concurrency: 'auto' as unknown as number },
      Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i + 1}`,
        prompt: `Task ${i + 1}`,
      })),
    )

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(10)
    expect(maxConcurrent).toBe(4)
  })
})

// ── Step retry context prepending ───────────────────────────────────────────

describe('step retry context prepending', () => {
  it('prepends prior failure output to the prompt on step retry', async () => {
    const adapter = makeAdapter()
    const capturedPrompts: string[] = []

    adapter.execute.mockImplementation(async (task: { prompt: string }) => {
      capturedPrompts.push(task.prompt)
      if (capturedPrompts.length === 1) {
        return { success: false, output: 'step error detail', exitCode: 2 }
      }
      return { success: true, output: 'ok', exitCode: 0 }
    })

    const spec = makeSpec({}, [
      {
        id: 'task-1',
        prompt: 'original task prompt',
        max_retries: 0,
        steps: [{ prompt: 'step prompt text', max_retries: 1 }],
      },
    ])

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    // First call: the step, inside the shared context and the task's role
    expect(capturedPrompts[0]).toContain('### Instructions\nstep prompt text')
    expect(capturedPrompts[0]).toContain('# Convoy: Test Convoy')
    expect(capturedPrompts[0]).toContain('You are the developer agent for this task.')
    expect(capturedPrompts[0]).not.toContain('Previous attempt failed.')
    // Second call (retry) adds the failure context
    expect(capturedPrompts[1]).toContain('Previous attempt failed.')
    expect(capturedPrompts[1]).toContain('Exit code: 2')
    expect(capturedPrompts[1]).toContain('step error detail')
    expect(capturedPrompts[1]).toContain('step prompt text')
  })
})

// ── Security: symlink scan (issue #2) ─────────────────────────────────────────

describe('symlink security scan', () => {
  it('marks task failed when pre-execution scanSymlinks throws', async () => {
    const scanSpy = vi.spyOn(partition, 'scanSymlinks').mockImplementation(() => {
      throw new Error('symlink_escape: "evil.ts" is a symlink that resolves outside the partition')
    })

    try {
      const adapter = makeAdapter()
      const spec = makeSpec({}, [{ files: ['src/evil.ts'] }])
      const engine = makeEngine({
        spec,
        specYaml: 'name: test',
        adapter,
        dbPath,
        _worktreeManager: makeWorktreeManager(),
        _mergeQueue: makeMergeQueue(),
      })

      const result = await engine.run()
      expect(result.status).toBe('failed')
    } finally {
      scanSpy.mockRestore()
    }
  })

  it('succeeds when files is empty (symlink scan skipped)', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({}, [{ files: [] }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })
})

// ── Security: convoy-level worktree when branch is set ───────────────────────

describe('convoy-level worktree when branch is set', () => {
  it('runs successfully when _convoyWorktreeDir is null and branch is set', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({ branch: 'feature-x' })
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
      _convoyWorktreeDir: null,
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('does not attempt worktree creation when spec has no branch', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({ branch: undefined })
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })
})

// ── Security: secret scan in markdown dual-write (issue #4) ──────────────────

describe('secret scan in DLQ/dispute markdown write', () => {
  it('task failure still recorded in DB even if DLQ markdown write is silently skipped', async () => {
    // The engine marks a task as failed; DLQ markdown write with secret scan
    // silently skips if secrets detected. The DB record is authoritative.
    const adapter = makeAdapter()
    vi.mocked(adapter.execute).mockResolvedValue({ success: false, output: 'error', exitCode: 1 })
    const spec = makeSpec({}, [{ max_retries: 0 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
  })

  it('emits secret_leak_prevented when DLQ markdown write detects secrets', async () => {
    const scanSpy = vi.spyOn(gates, 'scanForSecrets').mockImplementation((content: string, filePath = '') => {
      if (filePath === 'AGENT-FAILURES.md') {
        return {
          clean: false,
          findings: [{ pattern: 'Mock Secret', file: filePath, line: 1, snippet: content.slice(0, 20) }],
        }
      }
      return { clean: true, findings: [] }
    })

    try {
      const adapter = makeAdapter()
      vi.mocked(adapter.execute).mockResolvedValue({ success: false, output: 'fatal', exitCode: 1 })
      const spec = makeSpec({}, [{ id: 'task-1', max_retries: 0 }])
      const engine = makeEngine({
        spec,
        specYaml: 'name: secret-dlq',
        adapter,
        dbPath,
        _worktreeManager: makeWorktreeManager(),
        _mergeQueue: makeMergeQueue(),
      })

      const result = await engine.run()

      const store = createConvoyStore(dbPath)
      const events = store.getEvents(result.convoyId)
      store.close()

      const leakEvent = events.find((event) => event.type === 'secret_leak_prevented')
      expect(leakEvent).toBeDefined()
      const data = JSON.parse(leakEvent!.data ?? '{}') as Record<string, unknown>
      // context changed from 'dlq_markdown_write' to 'dlq_dual_write' (MF-2 atomicity fix)
      expect(data.context).toBe('dlq_dual_write')
    } finally {
      scanSpy.mockRestore()
    }
  })

  it('DLQ entry is NOT inserted into SQLite when secret scan blocks (MF-2 atomicity)', async () => {
    const scanSpy = vi.spyOn(gates, 'scanForSecrets').mockImplementation((content: string, filePath = '') => {
      if (filePath === 'AGENT-FAILURES.md') {
        return {
          clean: false,
          findings: [{ pattern: 'Mock Secret', file: filePath, line: 1, snippet: content.slice(0, 20) }],
        }
      }
      return { clean: true, findings: [] }
    })

    try {
      const adapter = makeAdapter()
      vi.mocked(adapter.execute).mockResolvedValue({ success: false, output: 'fatal', exitCode: 1 })
      const spec = makeSpec({}, [{ id: 'task-dlq-atomic', max_retries: 0 }])
      const engine = makeEngine({
        spec,
        specYaml: 'name: dlq-atomic-test',
        adapter,
        dbPath,
        _worktreeManager: makeWorktreeManager(),
        _mergeQueue: makeMergeQueue(),
      })

      const result = await engine.run()

      const s = createConvoyStore(dbPath)
      const dlqEntries = s.listDlqEntries(result.convoyId)
      s.close()

      // When scan blocks: SQLite DLQ row must NOT be written (atomic consistency)
      expect(dlqEntries).toHaveLength(0)
    } finally {
      scanSpy.mockRestore()
    }
  })

  it('emits secret_leak_prevented when dispute markdown write detects secrets', async () => {
    const scanSpy = vi.spyOn(gates, 'scanForSecrets').mockImplementation((content: string, filePath = '') => {
      if (filePath === '.opencastle/DISPUTES.md') {
        return {
          clean: false,
          findings: [{ pattern: 'Mock Secret', file: filePath, line: 1, snippet: content.slice(0, 20) }],
        }
      }
      return { clean: true, findings: [] }
    })

    try {
      const adapter = makeAdapter()
      vi.mocked(adapter.execute).mockResolvedValue({ success: true, output: 'ok', exitCode: 0 })
      const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'secret found', tokens: 5, model: 'r' })

      const engine = makeEngine({
        spec: makeSpec({ defaults: { review: 'panel' } }, [{ id: 'task-1', max_retries: 3 }]),
        specYaml: 'name: secret-dispute',
        adapter,
        dbPath,
        _worktreeManager: makeWorktreeManager(),
        _mergeQueue: makeMergeQueue(),
        _reviewRunner: mockReviewRunner,
      })

      const result = await engine.run()

      const store = createConvoyStore(dbPath)
      const events = store.getEvents(result.convoyId)
      store.close()

      const leakEvent = events.find((event) => event.type === 'secret_leak_prevented')
      expect(leakEvent).toBeDefined()
      const data = JSON.parse(leakEvent!.data ?? '{}') as Record<string, unknown>
      expect(data.context).toBe('dispute_markdown_write')
    } finally {
      scanSpy.mockRestore()
    }
  })
})

// ── Security: fileExists path traversal (issue #5) ────────────────────────────

describe('fileExists step condition path traversal', () => {
  it('step with fileExists using relative path executes normally when file absent', async () => {
    const adapter = makeAdapter()
    const capturedPrompts: string[] = []
    vi.mocked(adapter.execute).mockImplementation(async (task) => {
      capturedPrompts.push(task.prompt)
      return { success: true, output: 'ok', exitCode: 0 }
    })

    const spec = makeSpec({}, [{
      steps: [
        {
          prompt: 'conditional prompt',
          if: { step: 'prev', fileExists: { path: 'some-nonexistent-file.txt' } },
        },
        {
          prompt: 'always runs',
        },
      ],
    }])

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('step condition with path traversal attempt does not throw (returns false)', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({}, [{
      steps: [
        {
          prompt: 'should be skipped',
          if: { step: 'prev', fileExists: { path: '../../../etc/passwd' } },
        },
        {
          prompt: 'safe step',
        },
      ],
    }])

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    // Engine should not crash; traversal step is skipped (fileExists returns false)
    expect(result.status).toBe('done')
  })
})

// ── Circuit breaker ───────────────────────────────────────────────────────────

describe('circuit breaker', () => {
  it('allows task when no circuit_breaker config is set', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({}, [{}])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(1)
    expect(adapter.execute).toHaveBeenCalledTimes(1)
  })

  it('allows task when agent circuit is closed', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({
      defaults: { circuit_breaker: { threshold: 3, cooldown_ms: 300_000 } },
    }, [{ id: 'task-ok', agent: 'developer', max_retries: 0 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(1)
  })

  it('blocks subsequent tasks when circuit trips after threshold failures', async () => {
    const adapter = makeAdapter()
    // task-1 fails, task-2 and task-3 should be blocked by open circuit
    adapter.execute
      .mockResolvedValueOnce({ success: false, output: 'err', exitCode: 1 })
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 })

    // threshold=1: one failure opens the circuit before task-2 and task-3 start.
    // (Each failure used to be counted twice, and this test was written around that.)
    const spec = makeSpec({
      on_failure: 'continue',
      defaults: { circuit_breaker: { threshold: 1, cooldown_ms: 999_999_999 } },
    }, [
      { id: 'task-1', agent: 'developer', max_retries: 0 },
      { id: 'task-2', agent: 'developer', max_retries: 0 },
      { id: 'task-3', agent: 'developer', max_retries: 0 },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    // Only task-1 should have hit the adapter (circuit opens after task-1 fails)
    expect(adapter.execute).toHaveBeenCalledTimes(1)
    // task-2 and task-3 should be skipped by the circuit breaker
    expect(result.summary.skipped).toBeGreaterThanOrEqual(2)
  })

  it('records success and persists closed circuit state to store', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({
      defaults: { circuit_breaker: { threshold: 3, cooldown_ms: 300_000 } },
    }, [{ id: 'task-s', agent: 'developer', max_retries: 0 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')

    const store = createConvoyStore(dbPath)
    const record = store.getLatestConvoy()
    if (record?.circuit_state) {
      const state = JSON.parse(record.circuit_state)
      expect(state.developer?.status ?? 'closed').toBe('closed')
    }
    store.close()
  })

  it('records failure and persists open circuit state to store after threshold', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'err', exitCode: 1 })

    // threshold=2, two failures: counted once each, the second opens it
    const spec = makeSpec({
      on_failure: 'continue',
      defaults: { circuit_breaker: { threshold: 2, cooldown_ms: 999_999_999 } },
    }, [
      { id: 'task-f1', agent: 'developer', max_retries: 0 },
      { id: 'task-f2', agent: 'developer', max_retries: 0 },
    ])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    await engine.run()

    const store = createConvoyStore(dbPath)
    const record = store.getLatestConvoy()
    expect(record?.circuit_state).not.toBeNull()
    if (record?.circuit_state) {
      const state = JSON.parse(record.circuit_state)
      expect(state.developer?.status).toBe('open')
    }
    store.close()
  })

  it('circuit state is persisted to the store after a successful task', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({
      defaults: { circuit_breaker: { threshold: 2, cooldown_ms: 60_000 } },
    }, [{ id: 'task-persist', agent: 'developer', max_retries: 0 }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    await engine.run()

    const store = createConvoyStore(dbPath)
    const record = store.getLatestConvoy()
    expect(record?.circuit_state).not.toBeNull()
    store.close()
  })
})

describe('convoy lifecycle events', () => {
  it('emits convoy_finished event on successful run', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    store.close()

    const finishedEvent = events.find(e => e.type === 'convoy_finished')
    expect(finishedEvent).toBeDefined()
    expect(finishedEvent!.convoy_id).toBe(result.convoyId)
    expect(JSON.parse(finishedEvent!.data as string).status).toBe('done')
  })

  it('emits convoy_failed event when a task fails', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({
      success: false,
      output: 'error',
      exitCode: 1,
    })
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'fail-task', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('failed')

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    store.close()

    const failedEvent = events.find(e => e.type === 'convoy_failed')
    expect(failedEvent).toBeDefined()
    expect(failedEvent!.convoy_id).toBe(result.convoyId)
    expect(JSON.parse(failedEvent!.data as string).status).toBe('failed')
  })

  it('emits convoy_failed with gate-failed status when gates fail', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec({ gates: ['false'] }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('gate-failed')

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    store.close()

    const failedEvent = events.find(e => e.type === 'convoy_failed')
    expect(failedEvent).toBeDefined()
    expect(JSON.parse(failedEvent!.data as string).status).toBe('gate-failed')
  })
})

describe('createEventEmitter callsite safety', () => {
  it('rejects a raw string argument', () => {
    const testStore = createConvoyStore(dbPath)
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEventEmitter(testStore, 'some-path' as any)
    }).toThrow('createEventEmitter options must be an object, not a string')
    testStore.close()
  })

  it('accepts an options object with ndjsonPath', () => {
    const testStore = createConvoyStore(dbPath)
    const testNdjsonPath = join(tmpDir, 'callsite-test.ndjson')
    const emitter = createEventEmitter(testStore, { ndjsonPath: testNdjsonPath })
    expect(emitter).toBeDefined()
    expect(typeof emitter.emit).toBe('function')
    expect(typeof emitter.close).toBe('function')
    emitter.close()
    testStore.close()
  })
})

// ── Contract retry ────────────────────────────────────────────────────────────

describe('output contract', () => {
  it('only warns about a missing contract — the task is never run again', async () => {
    // The re-run used to happen after the first attempt had already merged:
    // two tasks produced four agent sessions and four commits.
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: 'no contract here', exitCode: 0 })
    const mergeQueue = makeMergeQueue()

    const engine = makeEngine({
      spec: makeSpec({}, [{ agent: 'developer', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(1)
    expect(mergeQueue.merge).toHaveBeenCalledTimes(1)
  })

  it('emits contract_violation and marks done', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: 'no contract here', exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ agent: 'developer', max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(1)

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()

    const violationEvent = events.find(e => e.type === 'contract_violation')
    expect(violationEvent).toBeDefined()
    expect(tasks[0].status).toBe('done')
  })
})

// ── No-op gate ────────────────────────────────────────────────────────────────

/**
 * A task blocked from writing anything, which said so in its OUTPUT_CONTRACT,
 * was recorded as `done` with exit code 0 and the convoy reported "Tasks: 1/1
 * done" over an empty branch. Success was inferred from the adapter's exit
 * status alone; the contract the engine asks for was never consulted.
 */
describe('no-op gate', () => {
  const BLOCKED_OUTPUT = [
    'I tried Write, then a heredoc, then mkdir. Each was refused.',
    '<!-- OUTPUT_CONTRACT',
    '{ "files_changed": [], "tests_added": [], "summary": "BLOCKED: could not create PILOT.md" }',
    '-->',
  ].join('\n')

  const WROTE_OUTPUT = [
    'Created the file.',
    '<!-- OUTPUT_CONTRACT',
    '{ "files_changed": ["PILOT.md"], "tests_added": [], "summary": "created PILOT.md" }',
    '-->',
  ].join('\n')

  /** A worktree directory outside any repository, so git has no say and the gate
   *  falls back to what the agent reported about itself. */
  function makeUntrackedWorktreeManager(): MockWorktreeManager {
    return {
      create: vi.fn().mockImplementation(() => {
        const path = join(tmpDir, 'worktree-untracked')
        mkdirSync(path, { recursive: true })
        return Promise.resolve(path)
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      removeAll: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('does not report a blocked task as done', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: BLOCKED_OUTPUT, exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'pilot-marker', agent: 'developer', files: ['PILOT.md'], max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeUntrackedWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()

    expect(result.status).not.toBe('done')
    expect(result.summary.done).toBe(0)
    expect(result.summary.failed).toBe(1)

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    const events = store.getEvents(result.convoyId)
    store.close()

    expect(tasks[0].status).toBe('gate-failed')
    expect(tasks[0].exit_code).toBe(1)
    const failure = events.find(e => e.type === 'task_failed')
    expect(JSON.parse(failure!.data as string).reason).toBe('no-op')
  })

  it('lets a task that reported files through', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: WROTE_OUTPUT, exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'pilot-marker', agent: 'developer', files: ['PILOT.md'], max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeUntrackedWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(1)
  })

  it('retries once with the reason before giving up', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: BLOCKED_OUTPUT, exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: WROTE_OUTPUT, exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'pilot-marker', agent: 'developer', files: ['PILOT.md'], max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeUntrackedWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    const secondPrompt = (adapter.execute.mock.calls[1] as [Task])[0].prompt
    expect(secondPrompt).toContain('produced no changes')
  })

  it('can be switched off per spec', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: BLOCKED_OUTPUT, exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { built_in_gates: { no_op: false } } }, [
        { id: 'pilot-marker', agent: 'developer', files: ['PILOT.md'], max_retries: 0 },
      ]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeUntrackedWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(1)
  })
})

// ── Permission mode ───────────────────────────────────────────────────────────

/**
 * The spec can say how much a worker may do unattended, but only if the value
 * survives the trip to the adapter — the adapter is where it becomes a flag on
 * the agent process, and a worker that never receives one cannot write a file.
 */
describe('permission mode', () => {
  it('reaches the adapter from spec defaults', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec({ defaults: { permission_mode: 'bypassPermissions' } }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    await engine.run()

    const [, options] = adapter.execute.mock.calls[0] as [Task, { permissionMode?: string }]
    expect(options.permissionMode).toBe('bypassPermissions')
  })

  it('leaves the adapter to pick when the spec says nothing', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    await engine.run()

    const [, options] = adapter.execute.mock.calls[0] as [Task, { permissionMode?: string }]
    expect(options.permissionMode).toBeUndefined()
  })

  it('reaches the adapter for each step of a multi-step task', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec({ defaults: { permission_mode: 'acceptEdits' } }, [
        { id: 'task-1', steps: [{ prompt: 'step one' }, { prompt: 'step two' }] },
      ]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    await engine.run()

    expect(adapter.execute).toHaveBeenCalledTimes(2)
    for (const call of adapter.execute.mock.calls) {
      const [, options] = call as [Task, { permissionMode?: string }]
      expect(options.permissionMode).toBe('acceptEdits')
    }
  })
})

// ── Compaction continuation ───────────────────────────────────────────────────


// ── Scheduler: a ready queue, not phase barriers ──────────────────────────────

describe('ready-queue scheduler', () => {
  it('runs the audit’s demo in about 6s, not 8.6s', async () => {
    // slow 6s, fast1 1s, fast2 (after fast1) 1s, indep 1s, two slots. With
    // phase barriers fast2 waited for slow: 6 + 1 + 1 ≈ 8.6s measured. With a
    // ready queue it starts the moment fast1 is done, and the run takes as
    // long as its slowest task.
    vi.useFakeTimers()
    try {
      const durations: Record<string, number> = { slow: 6000, fast1: 1000, fast2: 1000, indep: 1000 }
      const timeline: Record<string, { start: number; end: number }> = {}
      const adapter = makeAdapter()
      adapter.execute.mockImplementation(async (task: Task) => {
        const start = Date.now()
        await new Promise(r => setTimeout(r, durations[task.id]))
        timeline[task.id] = { start, end: Date.now() }
        return { success: true, output: 'ok', exitCode: 0 }
      })
      const spec = makeSpec({ concurrency: 2 }, [
        { id: 'slow' },
        { id: 'fast1' },
        { id: 'fast2', depends_on: ['fast1'] },
        { id: 'indep' },
      ])
      const t0 = Date.now()
      let finished = false
      const run = makeEngine({
        spec, specYaml: 'name: test', adapter, dbPath,
        _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
      }).run().finally(() => { finished = true })
      while (!finished) await vi.advanceTimersByTimeAsync(50)
      const result = await run
      const total = Date.now() - t0

      expect(result.status).toBe('done')
      expect(total).toBeGreaterThanOrEqual(6000)
      expect(total).toBeLessThan(6500)
      // fast2 ran while slow was still running.
      expect(timeline.fast2.start).toBeLessThan(timeline.slow.end)
      expect(timeline.fast2.start - t0).toBeLessThan(1500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never runs a task next to a running task whose files overlap, though both are ready', async () => {
    // `writer` becomes ready while `owner` still holds src/ — the dynamic form
    // of the per-phase partition check, which only compared tasks in one phase.
    const timeline: Record<string, { start: number; end: number }> = {}
    const adapter = makeAdapter()
    adapter.execute.mockImplementation(async (task: Task) => {
      const start = Date.now()
      await new Promise(r => setTimeout(r, task.id === 'owner' ? 120 : 10))
      timeline[task.id] = { start, end: Date.now() }
      return { success: true, output: 'ok', exitCode: 0 }
    })
    const spec = makeSpec({ concurrency: 3 }, [
      { id: 'owner', files: ['src/'] },
      { id: 'gate', files: [] },
      { id: 'writer', files: ['src/api.ts'], depends_on: ['gate'] },
    ])
    // Real (empty) directories: tasks with files are symlink-scanned in their worktree.
    const wt = makeWorktreeManager()
    wt.create.mockImplementation(async (id: string) => {
      const dir = join(tmpDir, 'wt', id)
      mkdirSync(dir, { recursive: true })
      return dir
    })
    const result = await makeEngine({
      spec, specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: wt, _mergeQueue: makeMergeQueue(),
    }).run()
    expect(result.status).toBe('done')
    expect(timeline.writer.start).toBeGreaterThanOrEqual(timeline.owner.end)
  })

  it('refuses a plan whose same-phase tasks overlap, before recording anything', async () => {
    const adapter = makeAdapter()
    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'a', files: ['src/'] }, { id: 'b', files: ['src/x.ts'] }]),
      specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })
    await expect(engine.run()).rejects.toThrow('File partition conflicts detected')
    const store = createConvoyStore(dbPath)
    expect(store.getLatestConvoy()).toBeUndefined()
    store.close()
    expect(adapter.execute).not.toHaveBeenCalled()
  })
})

// ── Resume resets everything retry did ────────────────────────────────────────

describe('resume resets every unfinished task', () => {
  it('reopens failed, timed-out, gate-failed, review-blocked, disputed, interrupted and skipped tasks', async () => {
    const convoyId = 'convoy-mixed'
    const statuses = ['done', 'failed', 'timed-out', 'gate-failed', 'review-blocked', 'disputed', 'running', 'assigned', 'skipped'] as const
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({ id: convoyId, name: 'Mixed', spec_hash: 'x', status: 'failed', branch: 'feat/mixed', created_at: new Date().toISOString(), spec_yaml: 'name: m' })
    for (const status of statuses) {
      seeder.insertTask({
        id: `t-${status}`, convoy_id: convoyId, phase: 0, prompt: `p ${status}`, agent: 'developer', adapter: null, model: null,
        timeout_ms: 30_000, status, retries: 1, max_retries: 1, files: null, depends_on: null, gates: null,
      })
    }
    seeder.close()

    const adapter = makeAdapter()
    const result = await makeEngine({
      spec: makeSpec({ concurrency: 4 }, statuses.map(s => ({ id: `t-${s}` }))),
      specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    }).resume(convoyId)

    expect(result.status).toBe('done')
    const ran = adapter.execute.mock.calls.map(([t]) => (t as Task).id).sort()
    expect(ran).toEqual(statuses.filter(s => s !== 'done').map(s => `t-${s}`).sort())
    const store = createConvoyStore(dbPath)
    const events = store.getEvents(convoyId).filter(e => e.type === 'task_retried')
    store.close()
    expect(events).toHaveLength(8)
  })

  it('retryFailed with task ids brings the dependents a failure skipped along', async () => {
    const convoyId = 'convoy-chain'
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({ id: convoyId, name: 'Chain', spec_hash: 'x', status: 'done', branch: 'feat/chain', created_at: new Date().toISOString(), spec_yaml: 'name: c' })
    const task = (id: string, status: 'failed' | 'skipped' | 'done', deps: string[] = []) => seeder.insertTask({
      id, convoy_id: convoyId, phase: deps.length, prompt: id, agent: 'developer', adapter: null, model: null,
      timeout_ms: 30_000, status, retries: 0, max_retries: 0, files: null, depends_on: deps.length ? JSON.stringify(deps) : null, gates: null,
    })
    task('a', 'failed')
    task('b', 'skipped', ['a'])
    task('c', 'skipped', ['b'])
    task('other', 'failed')
    seeder.close()

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'a' }]), specYaml: 'name: test', adapter: makeAdapter(), dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    })
    await engine.retryFailed(convoyId, ['a'])

    const store = createConvoyStore(dbPath)
    const byId = Object.fromEntries(store.getTasksByConvoy(convoyId).map(t => [t.id, t.status]))
    store.close()
    expect(byId).toEqual({ a: 'pending', b: 'pending', c: 'pending', other: 'failed' })
  })
})

// ── Telemetry ─────────────────────────────────────────────────────────────────

describe('telemetry', () => {
  it('records the agent’s real tier, not a hard-coded "standard"', async () => {
    const result = await makeEngine({
      spec: makeSpec({}, [{ id: 'sec', agent: 'security-expert' }, { id: 'doc', agent: 'writer' }]),
      specYaml: 'name: test', adapter: makeAdapter(), dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    }).run()
    const store = createConvoyStore(dbPath)
    const tiers = Object.fromEntries(store.getEvents(result.convoyId)
      .filter(e => e.type === 'delegation')
      .map(e => [e.task_id, (JSON.parse(e.data!) as { tier: string }).tier]))
    store.close()
    expect(tiers).toEqual({ sec: 'premium', doc: 'economy' })
  })

  it('counts a failure once toward the circuit breaker', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: 'err', exitCode: 1 })
    const result = await makeEngine({
      spec: makeSpec({ defaults: { circuit_breaker: { threshold: 5 } } }, [{ id: 'only', max_retries: 0 }]),
      specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    }).run()
    const store = createConvoyStore(dbPath)
    const state = JSON.parse(store.getConvoy(result.convoyId)!.circuit_state!) as Record<string, { failures: number }>
    store.close()
    expect(state.developer.failures).toBe(1)
  })

  it('masks a secret in a failure before it reaches the task row, the DLQ and the ledger', async () => {
    gates._setAllowlistConfigPath('/nonexistent/secret-scan-config.yml')
    gates._resetAllowlistCache()
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB'
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: false, output: `auth failed with token ${token}`, exitCode: 1 })
    const result = await makeEngine({
      spec: makeSpec({}, [{ id: 'leaky', max_retries: 0 }]),
      specYaml: 'name: test', adapter, dbPath,
      _worktreeManager: makeWorktreeManager(), _mergeQueue: makeMergeQueue(),
    }).run()
    const store = createConvoyStore(dbPath)
    const task = store.getTask('leaky', result.convoyId)!
    const dlq = store.listDlqEntries(result.convoyId)
    const events = store.getEvents(result.convoyId)
    store.close()
    expect(task.output).not.toContain(token)
    expect(dlq).toHaveLength(1)
    expect(dlq[0].error_output).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(token)
    expect(readFileSync(join(tmpDir, '.opencastle', 'AGENT-FAILURES.md'), 'utf8')).not.toContain(token)
  })
})
