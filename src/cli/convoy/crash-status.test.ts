/**
 * KI-003 regression: run() and resume() wrapped runConvoy in try/finally with no
 * catch, so an unexpected throw left the convoy row reading 'running' forever.
 * resume() then treats such a row as owned by a live engine and refuses it, which
 * is how the dogfood database ended up with a permanently stuck convoy.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyEngine } from './engine.js'
import type { ConvoyEngineOptions } from './engine.js'
import { createConvoyStore } from './store.js'
import type { AgentAdapter, Task, TaskSpec, ExecuteResult } from './spec-types.js'
import type { WorktreeManager } from './worktree.js'
import type { MergeQueue } from './merge.js'
import { getAdapter, detectAdapter } from '../run/adapters/index.js'

vi.mock('../run/adapters/index.js', () => ({
  getAdapter: vi.fn(),
  detectAdapter: vi.fn(),
}))

function makeAdapter(): AgentAdapter {
  return {
    name: 'test-adapter',
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({ success: true, output: 'ok', exitCode: 0 } satisfies ExecuteResult),
    kill: vi.fn(),
  } as unknown as AgentAdapter
}

function makeWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    create: vi.fn().mockResolvedValue('/tmp/worktree-mock'),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    removeAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as WorktreeManager
}

function makeMergeQueue(): MergeQueue {
  return {
    merge: vi.fn().mockResolvedValue({ success: true, conflicted: false, message: 'ok' }),
  } as unknown as MergeQueue
}

function task(id: string): Task {
  return {
    id,
    prompt: 'p',
    agent: 'developer',
    timeout: '30s',
    depends_on: [],
    files: [],
    description: '',
    max_retries: 0,
  }
}

describe('convoy status after an unexpected engine crash', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    vi.mocked(getAdapter).mockRejectedValue(new Error('unmocked getAdapter call'))
    vi.mocked(detectAdapter).mockRejectedValue(new Error('unmocked detectAdapter call'))
    tmpDir = mkdtempSync(join(tmpdir(), 'crash-status-'))
    dbPath = join(tmpDir, 'convoy.db')
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function engineFor(spec: TaskSpec, wt: WorktreeManager = makeWorktreeManager()) {
    return createConvoyEngine({
      spec,
      specYaml: 'name: crash-test',
      adapter: makeAdapter(),
      basePath: tmpDir,
      dbPath,
      logsDir: join(tmpDir, 'logs'),
      _worktreeManager: wt,
      _mergeQueue: makeMergeQueue(),
      _ensureBranch: vi.fn().mockResolvedValue(undefined),
      _convoyWorktreeDir: null,
    } as ConvoyEngineOptions)
  }

  const spec = (tasks: Task[]): TaskSpec => ({
    name: 'Crash Convoy',
    concurrency: 1,
    on_failure: 'continue',
    adapter: 'test',
    branch: 'main',
    tasks,
  })

  /**
   * run() derives its convoy id from Date.now(), so pinning the clock lets us
   * pre-seed a row with that id. insertConvoy is a plain INSERT, so the run then
   * throws a UNIQUE violation from inside run()'s try block — a deterministic
   * stand-in for any unexpected mid-run crash.
   */
  function seedIdCollision(): string {
    const fixed = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixed)
    const convoyId = `convoy-${fixed}`
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({
      id: convoyId,
      name: 'Pre-existing',
      spec_hash: 'seed',
      status: 'running',
      branch: 'main',
      created_at: new Date(fixed).toISOString(),
      spec_yaml: 'name: seed',
    })
    seeder.close()
    return convoyId
  }

  it('marks the convoy failed when run() throws, instead of leaving it running', async () => {
    const convoyId = seedIdCollision()
    const engine = engineFor(spec([task('task-1')]))

    await expect(engine.run()).rejects.toThrow()

    const store = createConvoyStore(dbPath)
    const convoy = store.getConvoy(convoyId)
    store.close()

    expect(convoy).toBeDefined()
    expect(convoy!.status).toBe('failed')
    expect(convoy!.finished_at).toBeTruthy()
  })

  it('marks the convoy failed when resume() throws during recovery', async () => {
    const convoyId = 'convoy-resume-crash'
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({
      id: convoyId,
      name: 'Crash Convoy',
      spec_hash: 'abc123',
      status: 'running',
      branch: 'main',
      created_at: new Date().toISOString(),
      spec_yaml: 'name: crash-test',
    })
    seeder.insertTask({
      id: 'task-1',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'p',
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

    // Orphaned-worktree cleanup runs before task execution and is not guarded.
    const wt = makeWorktreeManager({
      removeAll: vi.fn().mockRejectedValue(new Error('worktree cleanup exploded')),
    })
    const engine = engineFor(spec([task('task-1')]), wt)

    await expect(engine.resume(convoyId)).rejects.toThrow('worktree cleanup exploded')

    const store = createConvoyStore(dbPath)
    const convoy = store.getConvoy(convoyId)
    store.close()

    expect(convoy!.status).toBe('failed')
  })

  it('records the crash reason as a convoy_failed event', async () => {
    const convoyId = seedIdCollision()
    const engine = engineFor(spec([task('task-1')]))
    await expect(engine.run()).rejects.toThrow()

    const store = createConvoyStore(dbPath)
    const events = store.getEvents(convoyId)
    store.close()

    const failed = events.find(e => e.type === 'convoy_failed')
    expect(failed).toBeDefined()
    expect(failed!.data).toContain('engine crashed')
  })

  it('leaves a crashed convoy resumable rather than stuck', async () => {
    const convoyId = 'convoy-resumable-after-crash'
    const seeder = createConvoyStore(dbPath)
    seeder.insertConvoy({
      id: convoyId,
      name: 'Crash Convoy',
      spec_hash: 'abc123',
      status: 'running',
      branch: 'main',
      created_at: new Date().toISOString(),
      spec_yaml: 'name: crash-test',
    })
    seeder.insertTask({
      id: 'task-1',
      convoy_id: convoyId,
      phase: 0,
      prompt: 'p',
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

    // First resume crashes during orphaned-worktree cleanup.
    const exploding = makeWorktreeManager({
      removeAll: vi.fn().mockRejectedValue(new Error('worktree cleanup exploded')),
    })
    await expect(engineFor(spec([task('task-1')]), exploding).resume(convoyId)).rejects.toThrow()

    // A second resume with a healthy worktree manager now completes the convoy.
    const result = await engineFor(spec([task('task-1')])).resume(convoyId)
    expect(result.status).toBe('done')

    const store = createConvoyStore(dbPath)
    const convoy = store.getConvoy(convoyId)
    store.close()
    expect(convoy!.status).toBe('done')
  })
})
