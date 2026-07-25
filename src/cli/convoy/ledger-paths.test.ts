/**
 * Regression guard: every ledger the engine writes must land under the injected
 * basePath, never under process.cwd().
 *
 * Before this guard, appendDlqMarkdownClean and writeDisputeToMarkdown resolved
 * their paths from process.cwd(), so the test suite wrote into the repository's
 * own .opencastle/ — AGENT-FAILURES.md reached 1.6 MB of ~6,600 fake entries and
 * DISPUTES.md 283 KB of ~921 fake disputes before anyone noticed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyEngine } from './engine.js'
import type { ConvoyEngineOptions } from './engine.js'
import type { AgentAdapter, Task, TaskSpec, ExecuteResult } from '../types.js'
import type { WorktreeManager } from './worktree.js'
import type { MergeQueue } from './merge.js'
import { getAdapter, detectAdapter } from '../run/adapters/index.js'

vi.mock('../run/adapters/index.js', () => ({
  getAdapter: vi.fn(),
  detectAdapter: vi.fn(),
}))

type MockAdapter = AgentAdapter & { execute: ReturnType<typeof vi.fn> }

function makeFailingAdapter(): MockAdapter {
  return {
    name: 'test-adapter',
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn().mockResolvedValue({
      success: false,
      output: 'deliberate failure to force a DLQ entry',
      exitCode: 1,
    } satisfies ExecuteResult),
    kill: vi.fn(),
  } as unknown as MockAdapter
}

function makeWorktreeManager(): WorktreeManager {
  return {
    create: vi.fn().mockResolvedValue('/tmp/worktree-mock'),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    removeAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorktreeManager
}

function makeMergeQueue(): MergeQueue {
  return {
    merge: vi.fn().mockResolvedValue({ success: true, conflicted: false, message: 'ok' }),
  } as unknown as MergeQueue
}

function makeSpec(): TaskSpec {
  const tasks: Task[] = [
    {
      id: 'task-1',
      prompt: 'Prompt that will fail',
      agent: 'developer',
      timeout: '30s',
      depends_on: [],
      files: [],
      description: '',
      max_retries: 0,
    },
  ]
  return {
    name: 'Ledger Path Guard',
    concurrency: 1,
    on_failure: 'continue',
    adapter: 'test',
    branch: 'main',
    tasks,
  }
}

/** Ledgers the engine may append to outside of the SQLite store. */
const LEDGERS = [
  'AGENT-FAILURES.md',
  'DISPUTES.md',
  'LESSONS-LEARNED.md',
  'AGENT-EXPERTISE.md',
]

describe('ledger paths are confined to basePath', () => {
  let tmpDir: string
  /** Size of each repo-local ledger before the run, so we can prove we did not append. */
  let cwdLedgerSizes: Map<string, number>

  beforeEach(() => {
    vi.mocked(getAdapter).mockRejectedValue(new Error('unmocked getAdapter call'))
    vi.mocked(detectAdapter).mockRejectedValue(new Error('unmocked detectAdapter call'))
    tmpDir = mkdtempSync(join(tmpdir(), 'ledger-guard-'))
    cwdLedgerSizes = new Map(
      LEDGERS.map(name => {
        const p = join(process.cwd(), '.opencastle', name)
        return [name, existsSync(p) ? statSync(p).size : -1]
      }),
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes the DLQ ledger under basePath and never under process.cwd()', async () => {
    const engine = createConvoyEngine({
      spec: makeSpec(),
      specYaml: 'name: ledger-guard',
      adapter: makeFailingAdapter(),
      basePath: tmpDir,
      dbPath: join(tmpDir, 'convoy.db'),
      logsDir: join(tmpDir, 'logs'),
      _worktreeManager: makeWorktreeManager(),
      _mergeQueue: makeMergeQueue(),
      _ensureBranch: vi.fn().mockResolvedValue(undefined),
      _convoyWorktreeDir: null,
    } as ConvoyEngineOptions)

    await engine.run()

    // The failure was recorded under the injected root.
    const dlqPath = join(tmpDir, '.opencastle', 'AGENT-FAILURES.md')
    expect(existsSync(dlqPath)).toBe(true)
    expect(readFileSync(dlqPath, 'utf8')).toContain('task-1')

    // And nothing was appended to the repository's own ledgers.
    for (const name of LEDGERS) {
      const p = join(process.cwd(), '.opencastle', name)
      const before = cwdLedgerSizes.get(name)
      const after = existsSync(p) ? statSync(p).size : -1
      expect(after, `${name} in the repo working tree was modified by a test`).toBe(before)
    }
  })
})
