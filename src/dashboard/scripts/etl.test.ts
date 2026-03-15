import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runEtl } from './etl.js'
import { createConvoyStore } from '../../cli/convoy/store.js'

function makeTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'etl-test-')))
}

let tmpDir: string
let outputDir: string

beforeEach(() => {
  tmpDir = makeTmpDir()
  outputDir = join(tmpDir, 'data')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('runEtl — no database', () => {
  it('writes empty overall-stats.json when db is missing', async () => {
    const dbPath = join(tmpDir, 'nonexistent.db')
    await runEtl({ dbPath, outputDir })
    const stats = JSON.parse(readFileSync(join(outputDir, 'overall-stats.json'), 'utf8'))
    expect(stats).toMatchObject({
      convoyCounts: { total: 0, running: 0, done: 0, failed: 0, gate_failed: 0 },
      durationStats: { avg_sec: null, p95_sec: null, max_sec: null },
      tokenCostTotals: { total_tokens: 0, total_cost_usd: 0 },
      topAgents: [],
      topModels: [],
      dlqSummary: { count: 0, top_failure_types: [] },
      taskTotals: { totalTasks: 0, totalRetries: 0 },
      activityTimeline: [],
    })
  })

  it('writes empty convoy-list.json when db is missing', async () => {
    const dbPath = join(tmpDir, 'nonexistent.db')
    await runEtl({ dbPath, outputDir })
    const list = JSON.parse(readFileSync(join(outputDir, 'convoy-list.json'), 'utf8'))
    expect(Array.isArray(list)).toBe(true)
    expect(list).toHaveLength(0)
  })

  it('returns zero counts when db is missing', async () => {
    const dbPath = join(tmpDir, 'nonexistent.db')
    const result = await runEtl({ dbPath, outputDir })
    expect(result).toEqual({ convoyCount: 0 })
  })

  it('creates the output directory when db is missing', async () => {
    const dbPath = join(tmpDir, 'nonexistent.db')
    await runEtl({ dbPath, outputDir })
    expect(existsSync(outputDir)).toBe(true)
  })
})

describe('runEtl — with seeded database', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = join(tmpDir, 'convoy.db')
    const store = createConvoyStore(dbPath)
    try {
      store.insertConvoy({
        id: 'convoy-abc',
        name: 'Test Convoy',
        spec_hash: 'abc123',
        status: 'done',
        branch: 'main',
        created_at: '2026-03-01T10:00:00.000Z',
        spec_yaml: 'tasks: []',
      })
      store.insertConvoy({
        id: 'convoy-def',
        name: 'Second Convoy',
        spec_hash: 'def456',
        status: 'failed',
        branch: null,
        created_at: '2026-03-02T10:00:00.000Z',
        spec_yaml: 'tasks: []',
      })
      store.insertTask({
        id: 'task-001',
        convoy_id: 'convoy-abc',
        phase: 1,
        prompt: 'Do the thing',
        agent: 'developer',
        adapter: null,
        model: 'claude-opus-4-6',
        timeout_ms: 30000,
        status: 'done',
        retries: 0,
        depends_on: null,
        files: null,
        gates: null,
        max_retries: 3,
      })
      store.insertTask({
        id: 'task-002',
        convoy_id: 'convoy-abc',
        phase: 2,
        prompt: 'Do another thing',
        agent: 'reviewer',
        adapter: null,
        model: 'claude-opus-4-6',
        timeout_ms: 30000,
        status: 'done',
        retries: 1,
        depends_on: null,
        files: null,
        gates: null,
        max_retries: 3,
      })
    } finally {
      store.close()
    }
  })

  it('returns correct convoy count', async () => {
    const result = await runEtl({ dbPath, outputDir })
    expect(result.convoyCount).toBe(2)
  })

  it('overall-stats.json has correct convoy counts', async () => {
    await runEtl({ dbPath, outputDir })
    const stats = JSON.parse(readFileSync(join(outputDir, 'overall-stats.json'), 'utf8'))
    expect(stats.convoyCounts).toMatchObject({ total: 2 })
    expect(stats.durationStats).toHaveProperty('avg_sec')
    expect(stats.tokenCostTotals).toHaveProperty('total_tokens')
    expect(Array.isArray(stats.topAgents)).toBe(true)
    expect(Array.isArray(stats.topModels)).toBe(true)
    expect(stats.dlqSummary).toHaveProperty('count')
  })

  it('overall-stats.json includes taskTotals and activityTimeline', async () => {
    await runEtl({ dbPath, outputDir })
    const stats = JSON.parse(readFileSync(join(outputDir, 'overall-stats.json'), 'utf8'))
    expect(stats).toHaveProperty('taskTotals')
    expect(stats.taskTotals).toHaveProperty('totalTasks')
    expect(stats.taskTotals).toHaveProperty('totalRetries')
    expect(typeof stats.taskTotals.totalTasks).toBe('number')
    expect(typeof stats.taskTotals.totalRetries).toBe('number')
    expect(stats).toHaveProperty('activityTimeline')
    expect(Array.isArray(stats.activityTimeline)).toBe(true)
  })

  it('convoy-list.json contains all convoys with required fields', async () => {
    await runEtl({ dbPath, outputDir })
    const list = JSON.parse(readFileSync(join(outputDir, 'convoy-list.json'), 'utf8'))
    expect(list).toHaveLength(2)
    for (const item of list) {
      expect(item).toHaveProperty('id')
      expect(item).toHaveProperty('name')
      expect(item).toHaveProperty('status')
      expect(item).toHaveProperty('created_at')
      expect(item).toHaveProperty('finished_at')
      expect(item).toHaveProperty('total_tokens')
      expect(item).toHaveProperty('total_cost_usd')
    }
  })
})