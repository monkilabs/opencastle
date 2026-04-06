import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPipelineOrchestrator } from './pipeline.js'
import { createConvoyStore } from './store.js'
import type { AgentAdapter, TaskSpec, ExecuteResult, Task } from '../types.js'
import type { ConvoyEngine, ConvoyResult, ConvoyEngineOptions } from './engine.js'
import type { ConvoyStatus } from './types.js'

// ── Suppress NDJSON log writes ────────────────────────────────────────────────

vi.mock('../log.js', () => ({
  appendEvent: vi.fn().mockResolvedValue(undefined),
}))

// ── Mock fs/promises readFile ─────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeAdapter(): AgentAdapter {
  return {
    name: 'test-adapter',
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: 'ok',
      exitCode: 0,
    } satisfies ExecuteResult),
    kill: vi.fn(),
  } as unknown as AgentAdapter
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'Do something',
    agent: 'developer',
    timeout: '30s',
    depends_on: [],
    files: [],
    description: '',
    max_retries: 0,
    ...overrides,
  }
}

function makePipelineSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    name: 'Test Pipeline',
    concurrency: 1,
    on_failure: 'continue',
    adapter: 'test',
    branch: 'main',
    version: 2,
    depends_on_convoy: ['./convoy-a.yaml'],
    ...overrides,
  }
}

/** Minimal convoy YAML — content doesn't matter since readFile is mocked. */
const CONVOY_YAML =
  'name: convoy\nconcurrency: 1\non_failure: continue\nadapter: test\nbranch: main\ntasks:\n  - id: task-1\n    prompt: do thing\n    agent: developer\n    timeout: 30s\n'

function makeConvoyResult(
  overrides: Partial<ConvoyResult> = {},
  status: ConvoyStatus = 'done',
): ConvoyResult {
  return {
    convoyId: `convoy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status,
    summary: { total: 1, done: 1, failed: 0, skipped: 0, timedOut: 0 },
    duration: '100ms',
    ...overrides,
  }
}

/**
 * Create an engine factory where each successive call to engine.run() consumes
 * the next result from `runResults`.
 */
function makeEngineFactory(runResults: ConvoyResult[]) {
  let idx = 0
  return vi.fn((_opts: ConvoyEngineOptions): ConvoyEngine => {
    const result = runResults[idx++] ?? makeConvoyResult()
    return {
      run: vi.fn().mockResolvedValue(result),
      resume: vi.fn().mockResolvedValue(makeConvoyResult()),
      retryFailed: vi.fn(),
      injectTask: vi.fn(),
    }
  })
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string

beforeEach(() => {
  vi.mocked(readFile).mockResolvedValue(CONVOY_YAML as unknown as Awaited<ReturnType<typeof readFile>>)
  tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'))
  dbPath = join(tmpDir, 'convoy.db')
})

afterEach(() => {
  vi.clearAllMocks()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── 1. Single convoy pipeline ─────────────────────────────────────────────────

describe('single convoy pipeline', () => {
  it('returns status done when the single convoy succeeds', async () => {
    const factory = makeEngineFactory([makeConvoyResult()])
    const pipeline = createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    })

    const result = await pipeline.run()

    expect(result.status).toBe('done')
    expect(result.convoyResults).toHaveLength(1)
    expect(result.summary.totalConvoys).toBe(1)
    expect(result.summary.completed).toBe(1)
    expect(result.summary.failed).toBe(0)
    expect(result.summary.skipped).toBe(0)
    expect(typeof result.pipelineId).toBe('string')
    expect(typeof result.duration).toBe('string')
  })

  it('creates a pipeline record in SQLite with correct final state', async () => {
    const factory = makeEngineFactory([makeConvoyResult()])
    const pipeline = createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipe',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    })

    const result = await pipeline.run()

    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()

    expect(record).toBeDefined()
    expect(record!.status).toBe('done')
    expect(record!.name).toBe('Test Pipeline')
    expect(record!.branch).toBe('main')
    expect(record!.finished_at).not.toBeNull()
  })
})

// ── 2. Two-convoy pipeline ────────────────────────────────────────────────────

describe('two-convoy pipeline', () => {
  it('runs both convoys sequentially and returns done', async () => {
    const r1 = makeConvoyResult({ convoyId: 'convoy-1' })
    const r2 = makeConvoyResult({ convoyId: 'convoy-2' })
    const factory = makeEngineFactory([r1, r2])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml', './b.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('done')
    expect(result.convoyResults).toHaveLength(2)
    expect(result.summary.completed).toBe(2)
    expect(result.summary.failed).toBe(0)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('reads spec files in order', async () => {
    const factory = makeEngineFactory([makeConvoyResult(), makeConvoyResult()])

    await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./first.yaml', './second.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(vi.mocked(readFile)).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('first.yaml'),
      'utf8',
    )
    expect(vi.mocked(readFile)).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('second.yaml'),
      'utf8',
    )
  })
})

// ── 3. on_failure: 'stop' ─────────────────────────────────────────────────────

describe('on_failure: stop', () => {
  it('skips remaining convoys when second of three fails', async () => {
    const r1 = makeConvoyResult({ convoyId: 'c1' }, 'done')
    const r2 = makeConvoyResult({ convoyId: 'c2' }, 'failed')
    const factory = makeEngineFactory([r1, r2])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./a.yaml', './b.yaml', './c.yaml'],
        on_failure: 'stop',
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.totalConvoys).toBe(3)
    expect(result.summary.completed).toBe(1)
    expect(result.summary.failed).toBe(1)
    expect(result.summary.skipped).toBe(1)
    // Engine only called twice (third skipped)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('halts immediately on gate-failed convoy', async () => {
    const r1 = makeConvoyResult({ convoyId: 'c1' }, 'gate-failed')
    const factory = makeEngineFactory([r1])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./a.yaml', './b.yaml'],
        on_failure: 'stop',
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.skipped).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })
})

// ── 4. on_failure: 'continue' ────────────────────────────────────────────────

describe('on_failure: continue', () => {
  it('runs all three convoys even when second fails', async () => {
    const r1 = makeConvoyResult({ convoyId: 'c1' }, 'done')
    const r2 = makeConvoyResult({ convoyId: 'c2' }, 'failed')
    const r3 = makeConvoyResult({ convoyId: 'c3' }, 'done')
    const factory = makeEngineFactory([r1, r2, r3])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./a.yaml', './b.yaml', './c.yaml'],
        on_failure: 'continue',
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.totalConvoys).toBe(3)
    expect(result.summary.completed).toBe(2)
    expect(result.summary.failed).toBe(1)
    expect(result.summary.skipped).toBe(0)
    expect(factory).toHaveBeenCalledTimes(3)
  })
})

// ── 5. Hybrid pipeline ────────────────────────────────────────────────────────

describe('hybrid pipeline (chained + own tasks)', () => {
  it('runs chained convoys then own tasks as a final convoy', async () => {
    const r1 = makeConvoyResult({ convoyId: 'chained-1' })
    const rHybrid = makeConvoyResult({ convoyId: 'hybrid-own' })
    const factory = makeEngineFactory([r1, rHybrid])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./a.yaml'],
        tasks: [makeTask()],
      }),
      specYaml: 'name: hybrid',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('done')
    expect(result.convoyResults).toHaveLength(2)
    expect(result.summary.totalConvoys).toBe(2)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('does NOT run own tasks when pipeline is halted by on_failure: stop', async () => {
    const r1 = makeConvoyResult({ convoyId: 'c1' }, 'failed')
    const factory = makeEngineFactory([r1])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./a.yaml'],
        tasks: [makeTask()],
        on_failure: 'stop',
      }),
      specYaml: 'name: hybrid',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.summary.totalConvoys).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('failed')
  })
})

// ── 6. Token aggregation ──────────────────────────────────────────────────────

describe('token aggregation', () => {
  it('sums total_tokens across all convoy results', async () => {
    const r1 = makeConvoyResult({ convoyId: 'c1', cost: { total_tokens: 100 } })
    const r2 = makeConvoyResult({ convoyId: 'c2', cost: { total_tokens: 250 } })
    const factory = makeEngineFactory([r1, r2])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml', './b.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.cost?.total_tokens).toBe(350)
  })

  it('omits cost when no convoy has token data', async () => {
    const factory = makeEngineFactory([makeConvoyResult()]) // no cost field

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.cost).toBeUndefined()
  })

  it('persists total_tokens in the pipeline SQLite record', async () => {
    const factory = makeEngineFactory([
      makeConvoyResult({ cost: { total_tokens: 42 } }),
    ])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()

    expect(record!.total_tokens).toBe(42)
  })
})

// ── 7. Shared branch ──────────────────────────────────────────────────────────

describe('shared branch', () => {
  it('passes the pipeline branch to all convoy engines', async () => {
    const factory = makeEngineFactory([makeConvoyResult(), makeConvoyResult()])

    await createPipelineOrchestrator({
      spec: makePipelineSpec({
        branch: 'feature/pipeline-test',
        depends_on_convoy: ['./a.yaml', './b.yaml'],
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    const calls = factory.mock.calls as [ConvoyEngineOptions][]
    expect(calls[0][0].spec.branch).toBe('feature/pipeline-test')
    expect(calls[1][0].spec.branch).toBe('feature/pipeline-test')
  })
})

// ── 8. Pipeline convoy linking ────────────────────────────────────────────────

describe('pipeline convoy linking', () => {
  it('passes pipelineId to each convoy engine', async () => {
    const factory = makeEngineFactory([makeConvoyResult(), makeConvoyResult()])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml', './b.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    const calls = factory.mock.calls as [ConvoyEngineOptions][]
    expect(calls[0][0].pipelineId).toBe(result.pipelineId)
    expect(calls[1][0].pipelineId).toBe(result.pipelineId)
  })
})

// ── 9. Pipeline record persistence transitions ────────────────────────────────

describe('pipeline record persistence', () => {
  it('transitions: pending → running → done', async () => {
    let statusDuringRun: string | undefined
    const factory = vi.fn((_opts: ConvoyEngineOptions): ConvoyEngine => ({
      run: vi.fn().mockImplementation(async () => {
        const s = createConvoyStore(dbPath)
        statusDuringRun = s.getPipeline(_opts.pipelineId!)?.status
        s.close()
        return makeConvoyResult()
      }),
      resume: vi.fn(),
      retryFailed: vi.fn(),
      injectTask: vi.fn(),
    }))

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(statusDuringRun).toBe('running')

    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()

    expect(record!.status).toBe('done')
    expect(record!.started_at).not.toBeNull()
    expect(record!.finished_at).not.toBeNull()
  })

  it('marks pipeline as failed when a convoy fails', async () => {
    const factory = makeEngineFactory([makeConvoyResult({}, 'failed')])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()

    expect(record!.status).toBe('failed')
  })
})

// ── 10. Pipeline resume ───────────────────────────────────────────────────────

describe('pipeline resume', () => {
  it('continues from the first non-completed convoy', async () => {
    const pipelineId = 'pipeline-resume-continue-test'
    const doneConvoyId = 'convoy-1-done'

    // Pre-seed the pipeline and a completed convoy directly in the store
    const store = createConvoyStore(dbPath)
    store.insertPipeline({
      id: pipelineId,
      name: 'Test Pipeline',
      status: 'running',
      branch: 'main',
      spec_yaml: 'name: pipeline',
      convoy_specs: JSON.stringify(['./a.yaml', './b.yaml']),
      created_at: new Date(Date.now() - 5000).toISOString(),
    })
    store.insertConvoy({
      id: doneConvoyId,
      name: 'Convoy A',
      spec_hash: 'abc',
      status: 'done',
      branch: 'main',
      created_at: new Date(Date.now() - 4000).toISOString(),
      spec_yaml: CONVOY_YAML,
      pipeline_id: pipelineId,
    })
    store.close()

    // Resume: second convoy is fresh, factory called once for ./b.yaml
    const secondResult = makeConvoyResult({ convoyId: 'convoy-2-fresh' }, 'done')
    const resumeFactory = makeEngineFactory([secondResult])

    const pipelineSpec = makePipelineSpec({ depends_on_convoy: ['./a.yaml', './b.yaml'] })
    const resumeResult = await createPipelineOrchestrator({
      spec: pipelineSpec,
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: resumeFactory,
      _ensureBranch: async () => {},
    }).resume(pipelineId)

    expect(resumeResult.convoyResults).toHaveLength(2)
    expect(resumeResult.convoyResults[0].convoyId).toBe(doneConvoyId)
    expect(resumeResult.convoyResults[1].convoyId).toBe('convoy-2-fresh')
    // Only second convoy ran on resume
    expect(resumeFactory).toHaveBeenCalledTimes(1)
  })

  it('reconstructs token cost from done convoys during resume', async () => {
    const pipelineId = 'pipeline-resume-tokens'
    const doneConvoyId = 'convoy-done-with-tokens'

    const store = createConvoyStore(dbPath)
    store.insertPipeline({
      id: pipelineId,
      name: 'Token Pipeline',
      status: 'running',
      branch: 'main',
      spec_yaml: 'name: pipeline',
      convoy_specs: JSON.stringify(['./a.yaml']),
      created_at: new Date().toISOString(),
    })
    store.insertConvoy({
      id: doneConvoyId,
      name: 'Done Convoy',
      spec_hash: 'abc',
      status: 'done',
      branch: 'main',
      created_at: new Date().toISOString(),
      spec_yaml: CONVOY_YAML,
      pipeline_id: pipelineId,
    })
    store.updateConvoyStatus(doneConvoyId, 'done', { total_tokens: 77 })
    store.close()

    const resumeFactory = makeEngineFactory([])
    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: resumeFactory,
      _ensureBranch: async () => {},
    }).resume(pipelineId)

    expect(result.cost?.total_tokens).toBe(77)
    expect(result.convoyResults[0].cost).toEqual({ total_tokens: 77 })
    expect(resumeFactory).not.toHaveBeenCalled()
  })

  it('halts remaining convoys during resume when on_failure: stop', async () => {
    const pipelineId = 'pipeline-resume-halt'

    const store = createConvoyStore(dbPath)
    store.insertPipeline({
      id: pipelineId,
      name: 'Halt Pipeline',
      status: 'running',
      branch: 'main',
      spec_yaml: 'name: pipeline',
      convoy_specs: JSON.stringify(['./a.yaml', './b.yaml', './c.yaml']),
      created_at: new Date().toISOString(),
    })
    store.close()

    // First call fails, second should be skipped
    const failResult = makeConvoyResult({ convoyId: 'c1' }, 'failed')
    const resumeFactory = makeEngineFactory([failResult])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./a.yaml', './b.yaml', './c.yaml'],
        on_failure: 'stop',
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: resumeFactory,
      _ensureBranch: async () => {},
    }).resume(pipelineId)

    expect(result.status).toBe('failed')
    expect(result.summary.skipped).toBe(2)
    expect(resumeFactory).toHaveBeenCalledTimes(1)
  })

  it('throws when pipelineId does not exist in store', async () => {
    const pipeline = createPipelineOrchestrator({
      spec: makePipelineSpec(),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: makeEngineFactory([]),
      _ensureBranch: async () => {},
    })

    await expect(pipeline.resume('nonexistent-id')).rejects.toThrow(
      'Pipeline "nonexistent-id" not found in store',
    )
  })

  it('resumes a running convoy via engine.resume()', async () => {
    const pipelineId = 'pipeline-resume-test'
    const runningConvoyId = 'convoy-running-123'

    const store = createConvoyStore(dbPath)
    store.insertPipeline({
      id: pipelineId,
      name: 'Resume Test',
      status: 'running',
      branch: 'main',
      spec_yaml: 'name: resume',
      convoy_specs: JSON.stringify(['./a.yaml']),
      created_at: new Date(Date.now() - 1000).toISOString(),
    })
    store.insertConvoy({
      id: runningConvoyId,
      name: 'Convoy A',
      spec_hash: 'abc123',
      status: 'running',
      branch: 'main',
      created_at: new Date().toISOString(),
      spec_yaml: CONVOY_YAML,
      pipeline_id: pipelineId,
    })
    store.close()

    const resumedResult = makeConvoyResult({ convoyId: runningConvoyId }, 'done')
    const mockEngine: ConvoyEngine = {
      run: vi.fn().mockResolvedValue(makeConvoyResult()),
      resume: vi.fn().mockResolvedValue(resumedResult),
      retryFailed: vi.fn(),
      injectTask: vi.fn(),
    }
    const factory = vi.fn().mockReturnValue(mockEngine)

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).resume(pipelineId)

    expect(mockEngine.resume).toHaveBeenCalledWith(runningConvoyId)
    expect(mockEngine.run).not.toHaveBeenCalled()
    expect(result.convoyResults[0].convoyId).toBe(runningConvoyId)
  })

  it('resumes a failed convoy via retryFailed + resume instead of running fresh', async () => {
    const pipelineId = 'pipeline-resume-failed-convoy'
    const failedConvoyId = 'convoy-failed-456'

    const store = createConvoyStore(dbPath)
    store.insertPipeline({
      id: pipelineId,
      name: 'Failed Resume Test',
      status: 'running',
      branch: 'main',
      spec_yaml: 'name: resume-failed',
      convoy_specs: JSON.stringify(['./a.yaml']),
      created_at: new Date(Date.now() - 1000).toISOString(),
    })
    store.insertConvoy({
      id: failedConvoyId,
      name: 'Convoy A',
      spec_hash: 'abc123',
      status: 'failed',
      branch: 'main',
      created_at: new Date().toISOString(),
      spec_yaml: CONVOY_YAML,
      pipeline_id: pipelineId,
    })
    store.close()

    const resumedResult = makeConvoyResult({ convoyId: failedConvoyId }, 'done')
    const mockEngine: ConvoyEngine = {
      run: vi.fn().mockResolvedValue(makeConvoyResult()),
      resume: vi.fn().mockResolvedValue(resumedResult),
      retryFailed: vi.fn(),
      injectTask: vi.fn(),
    }
    const factory = vi.fn().mockReturnValue(mockEngine)

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./a.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).resume(pipelineId)

    expect(mockEngine.retryFailed).toHaveBeenCalledWith(failedConvoyId)
    expect(mockEngine.resume).toHaveBeenCalledWith(failedConvoyId)
    expect(mockEngine.run).not.toHaveBeenCalled()
    expect(result.convoyResults[0].convoyId).toBe(failedConvoyId)
  })
})

// ── 12. getCurrentBranch fallback ─────────────────────────────────────────────

describe('getCurrentBranch fallback', () => {
  it('run() uses getCurrentBranch when spec has no branch (falls back to main)', async () => {
    const factory = makeEngineFactory([makeConvoyResult()])

    // No branch on spec — forces getCurrentBranch call (git fails in tmpDir, returns 'main')
    const specNoBranch: TaskSpec = {
      name: 'No Branch Pipeline',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      version: 2,
      depends_on_convoy: ['./a.yaml'],
    }

    const result = await createPipelineOrchestrator({
      spec: specNoBranch,
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      basePath: tmpDir, // not a git repo → getCurrentBranch returns 'main'
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('done')
    // branch should be whatever getCurrentBranch returns (likely 'main' or 'HEAD')
    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()
    expect(typeof record!.branch).toBe('string')
  })

  it('resume() uses getCurrentBranch when pipeline branch is null and spec has no branch', async () => {
    const pipelineId = 'pipeline-no-branch'
    const store = createConvoyStore(dbPath)
    store.insertPipeline({
      id: pipelineId,
      name: 'No Branch Resume',
      status: 'running',
      branch: null,
      spec_yaml: 'name: pipeline',
      convoy_specs: JSON.stringify(['./a.yaml']),
      created_at: new Date().toISOString(),
    })
    store.close()

    const resumeFactory = makeEngineFactory([makeConvoyResult()])
    const specNoBranch: TaskSpec = {
      name: 'No Branch Pipeline',
      concurrency: 1,
      on_failure: 'continue',
      adapter: 'test',
      version: 2,
      depends_on_convoy: ['./a.yaml'],
    }

    const result = await createPipelineOrchestrator({
      spec: specNoBranch,
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      basePath: tmpDir,
      dbPath,
      _createConvoyEngine: resumeFactory,
      _ensureBranch: async () => {},
    }).resume(pipelineId)

    expect(result.status).toBe('done')
  })
})


// ── 13. Path traversal protection ────────────────────────────────────────────

describe('path traversal protection', () => {
  it('rejects absolute path in depends_on_convoy', async () => {
    const factory = makeEngineFactory([])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['/etc/passwd'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
    expect(result.convoyResults[0].status).toBe('failed')
    // Engine should never be called — error happens before spec is loaded
    expect(factory).not.toHaveBeenCalled()

    // Pipeline record must be finalized (not stuck in 'running')
    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()
    expect(record!.status).toBe('failed')
    expect(record!.finished_at).not.toBeNull()
  })

  it('rejects path traversal via .. in depends_on_convoy', async () => {
    const factory = makeEngineFactory([])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['../../etc/passwd'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBe(1)
    expect(result.convoyResults[0].status).toBe('failed')
    expect(factory).not.toHaveBeenCalled()

    // Pipeline record must be finalized
    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()
    expect(record!.status).toBe('failed')
    expect(record!.finished_at).not.toBeNull()
  })

  it('allows valid relative path like ./sub/convoy.yaml', async () => {
    // readFile default mock returns CONVOY_YAML for any path
    const factory = makeEngineFactory([makeConvoyResult()])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./sub/convoy.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('done')
    expect(factory).toHaveBeenCalledTimes(1)
  })
})

// ── 14. Missing convoy spec file ──────────────────────────────────────────────

describe('missing convoy spec file', () => {
  it('handles readFile ENOENT without crashing pipeline (on_failure: continue)', async () => {
    const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    })
    // First call (./missing.yaml) rejects; second (./exists.yaml) falls back to default CONVOY_YAML
    vi.mocked(readFile).mockRejectedValueOnce(enoentError)

    const factory = makeEngineFactory([makeConvoyResult({ convoyId: 'exists-convoy' })])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./missing.yaml', './exists.yaml'],
        on_failure: 'continue',
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBeGreaterThanOrEqual(1)
    expect(result.summary.completed).toBeGreaterThanOrEqual(1)
    // Engine only called once — for the second spec (first failed before engine)
    expect(factory).toHaveBeenCalledTimes(1)

    // Pipeline record finalized (not stuck in 'running')
    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()
    expect(record!.status).toBe('failed')
    expect(record!.finished_at).not.toBeNull()
  })

  it('stops pipeline on missing file when on_failure: stop', async () => {
    const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    })
    vi.mocked(readFile).mockRejectedValueOnce(enoentError)

    const factory = makeEngineFactory([makeConvoyResult()])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({
        depends_on_convoy: ['./missing.yaml', './exists.yaml'],
        on_failure: 'stop',
      }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.skipped).toBeGreaterThanOrEqual(1)
    // Second spec skipped — factory never called
    expect(factory).not.toHaveBeenCalled()

    // Pipeline record finalized as failed
    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()
    expect(record!.status).toBe('failed')
    expect(record!.finished_at).not.toBeNull()
  })
})

// ── 15. Invalid convoy YAML ───────────────────────────────────────────────────

describe('invalid convoy YAML', () => {
  it('handles parse error without crashing pipeline', async () => {
    // Return syntactically broken YAML (unclosed bracket triggers YAMLException)
    vi.mocked(readFile).mockResolvedValueOnce(
      'name: [unclosed bracket' as unknown as Awaited<ReturnType<typeof readFile>>,
    )

    const factory = makeEngineFactory([])

    const result = await createPipelineOrchestrator({
      spec: makePipelineSpec({ depends_on_convoy: ['./bad.yaml'] }),
      specYaml: 'name: pipeline',
      adapter: makeAdapter(),
      dbPath,
      _createConvoyEngine: factory,
      _ensureBranch: async () => {},
    }).run()

    expect(result.status).toBe('failed')
    expect(result.summary.failed).toBeGreaterThanOrEqual(1)
    // Engine never called — parse error happens before engine creation
    expect(factory).not.toHaveBeenCalled()

    // Pipeline record finalized (not stuck in 'running')
    const store = createConvoyStore(dbPath)
    const record = store.getPipeline(result.pipelineId)
    store.close()
    expect(record!.status).toBe('failed')
    expect(record!.finished_at).not.toBeNull()
  })
})
