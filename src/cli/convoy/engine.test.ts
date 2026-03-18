import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyEngine, evaluateReviewLevel, runConvoyGuard } from './engine.js'
import { recoverNdjson, createEventEmitter } from './events.js'
import type { ConvoyEngineOptions, DiffStats } from './engine.js'
import { createConvoyStore } from './store.js'
import type { AgentAdapter, Task, TaskSpec, ExecuteResult, ExecuteOptions } from '../types.js'
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

/** Wraps createConvoyEngine with a default no-op _ensureBranch mock so tests never
 * run real git branch operations. Callers can override _ensureBranch if needed. */
function makeEngine(opts: ConvoyEngineOptions): ReturnType<typeof createConvoyEngine> {
  return createConvoyEngine({
    logsDir: join(tmpDir, 'logs'),  // prevents test data in production logs
    _ensureBranch: vi.fn().mockResolvedValue(undefined),
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

  it('calls adapter.kill when the task fails', async () => {
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

    expect(adapter.kill).toHaveBeenCalledOnce()
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

  it('does not retry when on_failure is stop even if max_retries > 0', async () => {
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

    // No retries — stop mode skips them
    expect(adapter.execute).toHaveBeenCalledOnce()
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

  it('continues task execution when worktree creation throws', async () => {
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

    // Task should still succeed even without a worktree
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledOnce()
  })

  it('task still succeeds when merge throws', async () => {
    const adapter = makeAdapter('developer')
    const wtManager = makeWorktreeManager()
    const mergeQueue = makeMergeQueue()
    mergeQueue.merge.mockRejectedValue(new Error('merge conflict'))

    const engine = makeEngine({
      spec: makeSpec(),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })

    const result = await engine.run()
    // task is still marked done despite the merge warning
    expect(result.status).toBe('done')
    expect(wtManager.remove).toHaveBeenCalledOnce()
  })
})

// ── 10. Copilot adapter skips worktree ────────────────────────────────────────

describe('copilot adapter', () => {
  it('skips worktree create, merge, and remove for copilot adapter', async () => {
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
    expect(wtManager.create).not.toHaveBeenCalled()
    expect(mergeQueue.merge).not.toHaveBeenCalled()
    expect(wtManager.remove).not.toHaveBeenCalled()
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
    expect(adapter.kill).toHaveBeenCalledOnce()
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

  it('does not retry a timed-out task when on_failure is stop', async () => {
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
    expect(adapter.execute).toHaveBeenCalledOnce()
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

  it('logs verbose warning when worktree creation fails', async () => {
    const adapter = makeAdapter('developer')
    const wtManager = makeWorktreeManager()
    wtManager.create.mockRejectedValue(new Error('no worktrees'))

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1' }]),
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
  })

  it('logs verbose warning when merge fails', async () => {
    const adapter = makeAdapter('developer')
    const mergeQueue = makeMergeQueue()
    mergeQueue.merge.mockRejectedValue(new Error('merge conflict'))

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1' }]),
      specYaml: 'name: test',
      adapter,
      verbose: true,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: mergeQueue,
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

  it('resolves adapter: auto to detected adapter', async () => {
    const mainAdapter = makeAdapter('test')
    const autoAdapter = makeAdapter('claude-code')
    vi.mocked(detectAdapter).mockResolvedValue('claude-code')
    vi.mocked(getAdapter).mockResolvedValue(autoAdapter)

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

    expect(detectAdapter).toHaveBeenCalled()
    expect(getAdapter).toHaveBeenCalledWith('claude-code')
    expect(autoAdapter.execute).toHaveBeenCalledOnce()
    expect(mainAdapter.execute).not.toHaveBeenCalled()
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

    expect(result.cost).toEqual({ total_tokens: 75 })
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
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let writtenChunks: string[]

  beforeEach(() => {
    writtenChunks = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      writtenChunks.push(String(data))
      return true
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('prints task start message without verbose flag', async () => {
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

    const written = writtenChunks.join('')
    expect(written).toContain('[task-1]')
    expect(written).toMatch(/▶/)
  })

  it('prints task completion with counter', async () => {
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

    const written = writtenChunks.join('')
    expect(written).toContain('[1/1]')
    expect(written).toMatch(/✓/)
  })

  it('prints task failure with counter', async () => {
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

    const written = writtenChunks.join('')
    expect(written).toContain('[1/1]')
    expect(written).toMatch(/✗/)
  })

  it('prints phase headers when tasks span multiple phases', async () => {
    const adapter = makeAdapter()
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

    await engine.run()

    const written = writtenChunks.join('')
    expect(written).toContain('Phase 1:')
    expect(written).toContain('Phase 2:')
  })

  it('prints gate results with pass/fail indicators', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec({ gates: ['echo gate-ok', 'false'] }, [{ id: 'task-1' }])
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    const written = writtenChunks.join('')
    expect(written).toContain('Gates:')
    expect(written).toContain('echo gate-ok')
    expect(written).toContain('false')
  })

  it('prints retry messages when a task fails and is retried', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: false, output: 'fail', exitCode: 1 }
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 5))
        return { success: true, output: 'ok', exitCode: 0 }
      })

    const engine = makeEngine({
      spec: makeSpec({}, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    await engine.run()

    const written = writtenChunks.join('')
    expect(written).toMatch(/⟳/)
    expect(written).toContain('retry 1/1')
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
    expect(fixCall[0].prompt).toContain('validation gates failed')
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
    compaction_count: 0,
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
  it('routes to panel when a changed file is under auth/', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ filePaths: ['auth/session.ts'] }),
    )
    expect(level).toBe('panel')
  })

  it('routes to panel when a changed file path contains /auth/', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ filePaths: ['src/auth/session.ts'] }),
    )
    expect(level).toBe('panel')
  })

  it('routes to panel for security/ path', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ filePaths: ['security/policy.ts'] }),
    )
    expect(level).toBe('panel')
  })

  it('routes to panel for security-expert agent', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'security-expert' }),
      makeDiffStats(),
    )
    expect(level).toBe('panel')
  })

  it('routes to panel for database-engineer agent', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'database-engineer' }),
      makeDiffStats(),
    )
    expect(level).toBe('panel')
  })

  it('routes to auto-pass for documentation-writer agent', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'documentation-writer' }),
      makeDiffStats(),
    )
    expect(level).toBe('auto-pass')
  })

  it('routes to auto-pass for copywriter agent', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord({ agent: 'copywriter' }),
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

  it('custom heuristics: overrides panel_paths', () => {
    const level = evaluateReviewLevel(
      makeTaskRecord(),
      makeDiffStats({ filePaths: ['billing/invoice.ts'] }),
      { panel_paths: ['billing/'] },
    )
    expect(level).toBe('panel')
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

  it('task with review: none — reviewer not called, task succeeds', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 100, model: 'test' })
    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'none' } }, [{ review: 'none' }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(mockReviewRunner).not.toHaveBeenCalled()
  })

  it('fast review PASS — task proceeds to merge (status done)', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 50, model: 'reviewer' })
    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'fast' } }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    // Two-stage review: stage 1 (spec compliance) + stage 2 (code quality) = 2 calls
    expect(mockReviewRunner).toHaveBeenCalledTimes(2)
    expect(mockReviewRunner).toHaveBeenCalledWith(expect.objectContaining({ agent: 'developer' }), 'fast', 'default')
  })

  it('fast review BLOCK + retries remaining — task retried with feedback prepended', async () => {
    let callCount = 0
    adapter.execute.mockImplementation(() => {
      callCount++
      return Promise.resolve({ success: true, output: 'ok', exitCode: 0 })
    })
    const mockReviewRunner = vi.fn()
      .mockResolvedValueOnce({ verdict: 'block', feedback: 'Missing tests', tokens: 50, model: 'reviewer' }) // round 1 stage 1 → block (short-circuits)
      .mockResolvedValueOnce({ verdict: 'pass', feedback: '', tokens: 50, model: 'reviewer' })               // round 2 stage 1 → pass
      .mockResolvedValueOnce({ verdict: 'pass', feedback: '', tokens: 50, model: 'reviewer' })               // round 2 stage 2 → pass

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'fast' } }, [{ max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    // Round 1: stage 1 blocks (1 call). Round 2: stage 1 pass + stage 2 pass (2 calls). Total: 3
    expect(mockReviewRunner).toHaveBeenCalledTimes(3)
    // Prompt on second attempt should contain feedback
    const secondPrompt = (adapter.execute.mock.calls[1] as [Task])[0].prompt
    expect(secondPrompt).toContain('Missing tests')
  })

  it('fast review BLOCK + retries exhausted — status review-blocked', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'Insecure code', tokens: 50, model: 'reviewer' })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'fast' } }, [{ max_retries: 0 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
    // Verify the task itself is review-blocked
    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    expect(tasks[0].status).toBe('review-blocked')
  })

  it('panel review 2/3 PASS — task proceeds (status done)', async () => {
    let callCount = 0
    const mockReviewRunner = vi.fn().mockImplementation(() => {
      callCount++
      // Reviewer C blocks at stage 1 (call 3); reviewers A and B pass both stages (calls 1,2,4,5)
      return Promise.resolve(callCount === 3
        ? { verdict: 'block', feedback: 'Minor issue', tokens: 30, model: 'reviewer' }
        : { verdict: 'pass', feedback: '', tokens: 30, model: 'reviewer' })
    })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'panel' } }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    // Two-stage panel: 2 pass reviewers × 2 stages + 1 block reviewer × 1 stage = 5 calls
    expect(mockReviewRunner).toHaveBeenCalledTimes(5)
  })

  it('panel review 2/3 BLOCK — task retried with MUST-FIX', async () => {
    let reviewCallCount = 0
    const mockReviewRunner = vi.fn().mockImplementation(() => {
      reviewCallCount++
      // First round: 2 block; second round: 3 pass
      if (reviewCallCount <= 3) {
        return Promise.resolve(reviewCallCount <= 2
          ? { verdict: 'block', feedback: 'Critical bug', tokens: 30, model: 'reviewer' }
          : { verdict: 'pass', feedback: '', tokens: 30, model: 'reviewer' })
      }
      return Promise.resolve({ verdict: 'pass', feedback: '', tokens: 30, model: 'reviewer' })
    })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'panel' } }, [{ max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    // Prompt on second attempt contains MUST-FIX
    const secondPrompt = (adapter.execute.mock.calls[1] as [Task])[0].prompt
    expect(secondPrompt).toContain('MUST-FIX')
    expect(secondPrompt).toContain('Critical bug')
  })

  it('review budget exceeded with skip — review skipped, task done', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 200, model: 'reviewer' })

    const engine = makeEngine({
      spec: makeSpec({
        defaults: { review: 'fast', review_budget: 100, on_review_budget_exceeded: 'skip', reviewer_model: 'r1' },
        tasks: [
          { id: 'task-1', prompt: 'Prompt 1', agent: 'developer', timeout: '30s', depends_on: [], files: [], description: '', max_retries: 0 },
          { id: 'task-2', prompt: 'Prompt 2', agent: 'developer', timeout: '30s', depends_on: ['task-1'], files: [], description: '', max_retries: 0 },
        ],
      }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    // first task: budget not exceeded (0 < 100), two-stage review runs (2 calls, total 400 tokens)
    // second task: budget exceeded (400 >= 100), review skipped
    expect(mockReviewRunner).toHaveBeenCalledTimes(2)
  })

  it('auto route: developer agent with empty diff → auto-pass (no reviewer call)', async () => {
    // Given: 'auto' review setting, developer agent, empty diff (git will fail on mock path)
    const mockReviewRunner = vi.fn()
    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'auto' } }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(mockReviewRunner).not.toHaveBeenCalled()
  })

  it('review tokens tracked on task record', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 77, model: 'reviewer' })
    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'fast' } }),
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
    expect(tasks[0].review_tokens).toBe(154) // two-stage: 77 (stage 1) + 77 (stage 2)
    expect(tasks[0].review_level).toBe('fast')
    expect(tasks[0].review_verdict).toBe('pass')
  })

  it('review_started and review_verdict events emitted', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 10, model: 'reviewer' })
    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'fast' } }),
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
    const startedEvent = events.find(e => e.type === 'review_started')
    const verdictEvent = events.find(e => e.type === 'review_verdict')
    expect(startedEvent).toBeDefined()
    expect(verdictEvent).toBeDefined()
  })

  it('review sessions do NOT count against concurrency limit', async () => {
    // Concurrency=1, 2 tasks in parallel. Both should complete with review.
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'pass', feedback: '', tokens: 10, model: 'reviewer' })
    const engine = makeEngine({
      spec: makeSpec(
        { concurrency: 1, defaults: { review: 'fast' } },
        [{ id: 'task-1' }, { id: 'task-2' }],
      ),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(2)
  })

  it('full fast-review flow: BLOCK on first attempt → retry → PASS → done with complete events', async () => {
    const mockReviewRunner = vi.fn()
      .mockResolvedValueOnce({ verdict: 'block', feedback: 'Add more tests', tokens: 40, model: 'reviewer' }) // round 1 stage 1 → block
      .mockResolvedValueOnce({ verdict: 'pass', feedback: '', tokens: 35, model: 'reviewer' })               // round 2 stage 1 → pass
      .mockResolvedValueOnce({ verdict: 'pass', feedback: '', tokens: 35, model: 'reviewer' })               // round 2 stage 2 → pass

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'fast' } }, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    // Round 1: 1 call (block short-circuits). Round 2: 2 calls (stage 1 + stage 2). Total: 3
    expect(mockReviewRunner).toHaveBeenCalledTimes(3)

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    const events = store.getEvents(result.convoyId)
    store.close()

    const task = tasks[0]
    expect(task.review_level).toBe('fast')
    expect(task.review_verdict).toBe('pass')
    expect(task.retries).toBe(1)

    const reviewStartedEvents = events.filter(e => e.type === 'review_started')
    const reviewVerdictEvents = events.filter(e => e.type === 'review_verdict')
    expect(reviewStartedEvents.length).toBe(2)
    expect(reviewVerdictEvents.length).toBe(2)

    const firstVerdict = JSON.parse(reviewVerdictEvents[0].data!) as Record<string, unknown>
    const secondVerdict = JSON.parse(reviewVerdictEvents[1].data!) as Record<string, unknown>
    expect(firstVerdict['verdict']).toBe('block')
    expect(secondVerdict['verdict']).toBe('pass')
  })

  it('panel flow: 2/3 BLOCK first round → retry → 3/3 PASS second round → done', async () => {
    let reviewCallCount = 0
    const mockReviewRunner = vi.fn().mockImplementation(() => {
      reviewCallCount++
      // Round 1 (calls 1-3): BLOCK, BLOCK, PASS → majority block → retry
      if (reviewCallCount <= 3) {
        return Promise.resolve(reviewCallCount <= 2
          ? { verdict: 'block', feedback: 'Critical issue', tokens: 20, model: 'reviewer' }
          : { verdict: 'pass', feedback: '', tokens: 20, model: 'reviewer' })
      }
      // Round 2 (calls 4-6): all PASS
      return Promise.resolve({ verdict: 'pass', feedback: '', tokens: 20, model: 'reviewer' })
    })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { review: 'panel' } }, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
    // Two-stage panel round 1: 2 blocks ×1 call + 1 pass ×2 calls = 4 calls
    // Two-stage panel round 2: 3 pass ×2 calls = 6 calls. Total: 10
    expect(mockReviewRunner).toHaveBeenCalledTimes(10)

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()

    expect(tasks[0].review_verdict).toBe('pass')
    expect(tasks[0].panel_attempts).toBeGreaterThanOrEqual(1)
  })

  it('dispute: task dispute_id matches the dispute_opened event and panel_attempts is 3', async () => {
    const mockReviewRunner = vi.fn().mockResolvedValue({ verdict: 'block', feedback: 'broken', tokens: 5, model: 'r' })

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
    const events = store.getEvents(result.convoyId)
    store.close()

    const task = tasks[0]
    expect(task.status).toBe('disputed')
    expect(task.dispute_id).not.toBeNull()
    expect(task.panel_attempts).toBe(3)

    const disputeEvent = events.find(e => e.type === 'dispute_opened')
    expect(disputeEvent).toBeDefined()
    const eventData = JSON.parse(disputeEvent!.data!) as Record<string, unknown>
    // Verify the dispute_id on the task record matches the one in the event
    expect(eventData['dispute_id']).toBe(task.dispute_id)
    expect(eventData['panel_attempts']).toBe(3)
  })

  it('review budget exceeded: stop marks task review-blocked and skips all pending tasks', async () => {
    const mockReviewRunner = vi.fn()

    const engine = makeEngine({
      spec: makeSpec(
        { defaults: { review: 'fast', review_budget: 0, on_review_budget_exceeded: 'stop' } },
        [
          { id: 'task-1', depends_on: [] },
          { id: 'task-2', depends_on: ['task-1'] },
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
    expect(byId['task-1']).toBe('review-blocked')
    expect(byId['task-2']).toBe('skipped')
    expect(mockReviewRunner).not.toHaveBeenCalled()
  })

  it('review budget exceeded: downgrade auto-passes task without calling reviewer', async () => {
    const mockReviewRunner = vi.fn()

    const engine = makeEngine({
      spec: makeSpec(
        { defaults: { review: 'fast', review_budget: 0, on_review_budget_exceeded: 'downgrade' } },
      ),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
      _reviewRunner: mockReviewRunner,
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(mockReviewRunner).not.toHaveBeenCalled()

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()

    expect(tasks[0].review_verdict).toBe('pass')
    expect(tasks[0].review_level).toBe('fast')
  })
})

// ── Drift detection ───────────────────────────────────────────────────────────

describe('drift detection', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let wtManager: ReturnType<typeof makeWorktreeManager>
  let mergeQueue: ReturnType<typeof makeMergeQueue>

  beforeEach(() => {
    adapter = makeAdapter('copilot')
    wtManager = makeWorktreeManager()
    mergeQueue = makeMergeQueue()
  })

  it('detect_drift=true triggers drift check and retries on low confidence', async () => {
    // Call sequence: main task → drift check (low score) → main task retry
    const driftRetryOutput = [
      'done retry',
      '<!-- OUTPUT_CONTRACT',
      '{ "files_changed": ["src/foo.ts"], "tests_added": ["src/foo.test.ts"], "summary": "done" }',
      '-->',
    ].join('\n')
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'done', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: '{"score": 0.3, "explanation": "uncertain"}', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: driftRetryOutput, exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { detect_drift: true } }, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(result.summary.done).toBe(1)
    expect(adapter.execute).toHaveBeenCalledTimes(3)

    // Verify drift_score and drift_retried stored
    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    expect(tasks[0].drift_score).toBe(0.3)
    expect(tasks[0].drift_retried).toBe(1)
  })

  it('detect_drift=true does NOT re-check on drift retry (drift_retried=1)', async () => {
    // On second execution drift_retried=1 so no third call for drift check
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'done', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: '{"score": 0.9, "explanation": "confident"}', exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { detect_drift: true } }),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()

    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)
  })

  it('drift_check_result and drift_detected events emitted when drifted', async () => {
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'done', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: '{"score": 0.2, "explanation": "very unsure"}', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: 'done', exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({ defaults: { detect_drift: true } }, [{ id: 'task-1', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: wtManager,
      _mergeQueue: mergeQueue,
    })
    const result = await engine.run()

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    store.close()

    expect(events.some(e => e.type === 'drift_check_result')).toBe(true)
    expect(events.some(e => e.type === 'drift_detected')).toBe(true)
  })

  it('non-copilot adapter skips drift detection (returns done without extra call)', async () => {
    // adapter name is 'test-adapter' — not a streaming adapter; drift check should be skipped
    const nonStreamingAdapter = makeAdapter('test-adapter')
    nonStreamingAdapter.execute.mockResolvedValue({ success: true, output: 'ok', exitCode: 0 })

    // Suppress the stderr warning
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const engine = makeEngine({
        spec: makeSpec({ defaults: { detect_drift: true } }),
        specYaml: 'name: test',
        adapter: nonStreamingAdapter,
        dbPath,
        _worktreeManager: wtManager,
        _mergeQueue: mergeQueue,
      })
      const result = await engine.run()
      expect(result.status).toBe('done')
      // Only 1 call: main task (no drift check call) because non-streaming adapter
      expect(nonStreamingAdapter.execute).toHaveBeenCalledTimes(1)
    } finally {
      stderrSpy.mockRestore()
    }
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

// ── File-based injection ───────────────────────────────────────────────────

describe('file-based injection', () => {
  it('picks up tasks from inject file and ingests them', async () => {
    const adapter = makeAdapter()
    adapter.execute.mockResolvedValue({ success: true, output: 'ok', exitCode: 0 })

    const spec = makeSpec({ concurrency: 1 }, [
      { id: 'task-1', prompt: 'Original task', timeout: '5s' },
    ])

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      basePath: tmpDir,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.summary.done).toBeGreaterThanOrEqual(1)
  })

  it('respects convoy_id path traversal guard', async () => {
    const adapter = makeAdapter()
    const spec = makeSpec()

    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      basePath: tmpDir,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })

    const result = await engine.run()
    expect(result.status).toBe('done')
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

  it('defaults max_swarm_concurrency to 8', async () => {
    const adapter = makeAdapter()

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

    // First call uses the original step prompt
    expect(capturedPrompts[0]).toBe('step prompt text')
    // Second call (retry) prepends failure context
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

// ── Security: ensureBranch fallback (issue #3) ────────────────────────────────

describe('ensureBranch fallback when _ensureBranch not provided', () => {
  it('calls the injected _ensureBranch when branch is set in spec', async () => {
    const branchFn = vi.fn().mockResolvedValue(undefined)
    const adapter = makeAdapter()
    const spec = makeSpec({ branch: 'feature-x' })
    const engine = createConvoyEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
      _ensureBranch: branchFn,
    })

    await engine.run()
    expect(branchFn).toHaveBeenCalledWith('feature-x', expect.any(String))
  })

  it('does not call ensureBranch when spec has no branch', async () => {
    const branchFn = vi.fn().mockResolvedValue(undefined)
    const adapter = makeAdapter()
    const spec = makeSpec({ branch: undefined })
    const engine = makeEngine({
      spec,
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
      _ensureBranch: branchFn,
    })

    await engine.run()
    expect(branchFn).not.toHaveBeenCalled()
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

    // threshold=2: task-1 failure is recorded twice (failure path + handleExhaustion),
    // reaching threshold=2 → circuit opens before task-2 and task-3 execute
    const spec = makeSpec({
      on_failure: 'continue',
      defaults: { circuit_breaker: { threshold: 2, cooldown_ms: 999_999_999 } },
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

    // threshold=2: first failure double-records → count reaches 2 → circuit opens
    const spec = makeSpec({
      on_failure: 'continue',
      defaults: { circuit_breaker: { threshold: 2, cooldown_ms: 999_999_999 } },
    }, [
      { id: 'task-f1', agent: 'developer', max_retries: 0 },
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

describe('contract retry', () => {
  it('retries when output is missing OUTPUT_CONTRACT and retries remain', async () => {
    const validContractOutput = [
      'Work done.',
      '<!-- OUTPUT_CONTRACT',
      '{ "files_changed": ["src/foo.ts"], "tests_added": ["src/foo.test.ts"], "summary": "implemented" }',
      '-->',
    ].join('\n')

    const adapter = makeAdapter()
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'no contract here', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, output: validContractOutput, exitCode: 0 })

    const engine = makeEngine({
      spec: makeSpec({}, [{ agent: 'developer', max_retries: 1 }]),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)

    // Second prompt should contain the contract retry message
    const secondPrompt = (adapter.execute.mock.calls[1] as [Task])[0].prompt
    expect(secondPrompt).toContain('OUTPUT_CONTRACT')
    expect(secondPrompt).toContain('Missing fields')

    const store = createConvoyStore(dbPath)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()
    expect(tasks[0].status).toBe('done')
  })

  it('emits contract_violation and marks done when retries exhausted', async () => {
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

// ── Compaction continuation ───────────────────────────────────────────────────

describe('compaction continuation', () => {
  it('re-enqueues without incrementing retries when threshold exceeded', async () => {
    const adapter = makeAdapter()
    adapter.execute
      .mockResolvedValueOnce({ success: true, output: 'phase 1 done', exitCode: 0, usage: { total_tokens: 170_000 } })
      .mockResolvedValueOnce({ success: true, output: 'all done', exitCode: 0, usage: { total_tokens: 1_000 } })

    const engine = makeEngine({
      spec: makeSpec(
        { defaults: { compaction: { enabled: true, token_threshold_pct: 80, summary_max_tokens: 2000 } } },
        [{ model: 'claude-sonnet-4-6', max_retries: 0 }],
      ),
      specYaml: 'name: test',
      adapter,
      dbPath,
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
    })
    const result = await engine.run()
    expect(result.status).toBe('done')
    expect(adapter.execute).toHaveBeenCalledTimes(2)

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(result.convoyId)
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()

    // Compaction event emitted
    const compactedEvent = events.find(e => e.type === 'context_compacted')
    expect(compactedEvent).toBeDefined()

    // Task completed successfully and retries were NOT incremented by compaction
    expect(tasks[0].status).toBe('done')
    expect(tasks[0].retries).toBe(0)
  })

  it('fails with context_exhausted when max compactions reached', async () => {
    const adapter = makeAdapter()
    // All calls return high token count — will exhaust compaction budget after 3+1 calls
    adapter.execute.mockResolvedValue({
      success: true,
      output: 'partial work',
      exitCode: 0,
      usage: { total_tokens: 170_000 },
    })

    const engine = makeEngine({
      spec: makeSpec(
        { defaults: { compaction: { enabled: true, token_threshold_pct: 80, summary_max_tokens: 2000 } } },
        [{ model: 'claude-sonnet-4-6', max_retries: 0 }],
      ),
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
    const tasks = store.getTasksByConvoy(result.convoyId)
    store.close()

    const exhaustedEvent = events.find(e => {
      if (e.type !== 'task_failed') return false
      try { return (JSON.parse(e.data as string) as { reason: string }).reason === 'context_exhausted' } catch { return false }
    })
    expect(exhaustedEvent).toBeDefined()
    expect(tasks[0].status).toBe('failed')
  })
})
