import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createConvoyStore } from './store.js'
import type { ConvoyStore } from './store.js'
import {
  extractExecutionHistory,
  clusterConvoys,
  analyzeAgentPerformance,
  generateInsights,
  analyzeDAG,
  formatInsightsMarkdown,
} from './dag-analysis.js'

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string
let store: ConvoyStore

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'dag-test-')))
  dbPath = join(tmpDir, 'test.db')
  store = createConvoyStore(dbPath)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

type ConvoyInsert = Parameters<ConvoyStore['insertConvoy']>[0]
type TaskInsert = Parameters<ConvoyStore['insertTask']>[0]

function makeConvoy(overrides: Partial<ConvoyInsert> = {}): ConvoyInsert {
  return {
    id: 'convoy-1',
    name: 'Test Convoy',
    spec_hash: 'abc123',
    status: 'pending',
    branch: null,
    created_at: new Date().toISOString(),
    spec_yaml: 'name: test\nconcurrency: 2',
    pipeline_id: null,
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskInsert> = {}): TaskInsert {
  return {
    id: 'task-1',
    convoy_id: 'convoy-1',
    phase: 0,
    prompt: 'Do something',
    agent: 'developer',
    adapter: null,
    model: null,
    timeout_ms: 1_800_000,
    status: 'pending',
    retries: 0,
    max_retries: 1,
    files: null,
    depends_on: null,
    gates: null,
    ...overrides,
  } as TaskInsert
}

const NOW = new Date().toISOString()
const LONG_AGO = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()

// ── extractExecutionHistory ───────────────────────────────────────────────────

describe('extractExecutionHistory', () => {
  it('returns empty arrays for an empty database', () => {
    const result = extractExecutionHistory(store)
    expect(result.convoys).toHaveLength(0)
    expect(result.tasks).toHaveLength(0)
  })

  it('filters to only done/failed convoys', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'pending' }))
    store.insertConvoy(makeConvoy({ id: 'c2', status: 'running' }))
    store.insertConvoy(makeConvoy({ id: 'c3', status: 'done' }))
    store.insertConvoy(makeConvoy({ id: 'c4', status: 'failed' }))
    store.updateConvoyStatus('c3', 'done', { finished_at: NOW, started_at: NOW })
    store.updateConvoyStatus('c4', 'failed', { finished_at: NOW, started_at: NOW })

    const result = extractExecutionHistory(store)
    const ids = result.convoys.map((c) => c.id)
    expect(ids).toContain('c3')
    expect(ids).toContain('c4')
    expect(ids).not.toContain('c1')
    expect(ids).not.toContain('c2')
  })

  it('respects sinceDays filter and excludes old convoys', () => {
    store.insertConvoy(makeConvoy({ id: 'old', status: 'done' }))
    store.updateConvoyStatus('old', 'done', { finished_at: LONG_AGO, started_at: LONG_AGO })

    store.insertConvoy(makeConvoy({ id: 'recent', status: 'done' }))
    store.updateConvoyStatus('recent', 'done', { finished_at: NOW, started_at: NOW })

    const result = extractExecutionHistory(store, 90)
    const ids = result.convoys.map((c) => c.id)
    expect(ids).toContain('recent')
    expect(ids).not.toContain('old')
  })

  it('includes tasks for matching convoys', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.updateConvoyStatus('c1', 'done', { finished_at: NOW, started_at: NOW })
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1' }))
    store.insertTask(makeTask({ id: 't2', convoy_id: 'c1' }))

    const result = extractExecutionHistory(store)
    expect(result.tasks).toHaveLength(2)
  })
})

// ── clusterConvoys ────────────────────────────────────────────────────────────

describe('clusterConvoys', () => {
  it('returns empty array for no convoys', () => {
    expect(clusterConvoys([], [])).toHaveLength(0)
  })

  it('assigns correct bucket for small task count', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.updateConvoyStatus('c1', 'done', { finished_at: NOW, started_at: NOW })

    const convoys = [store.getConvoy('c1')!]
    const tasks = [makeTask({ id: 't1', convoy_id: 'c1' })]

    const patterns = clusterConvoys(convoys, tasks as never)
    expect(patterns).toHaveLength(1)
    expect(patterns[0].name).toMatch(/^small/)
  })

  it('convoys with same agent set cluster together', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.updateConvoyStatus('c1', 'done', { finished_at: NOW, started_at: NOW })
    store.insertConvoy(makeConvoy({ id: 'c2', status: 'done' }))
    store.updateConvoyStatus('c2', 'done', { finished_at: NOW, started_at: NOW })

    const convoys = [store.getConvoy('c1')!, store.getConvoy('c2')!]
    const tasks = [
      makeTask({ id: 't1', convoy_id: 'c1', agent: 'developer' }),
      makeTask({ id: 't2', convoy_id: 'c2', agent: 'developer' }),
    ]

    const patterns = clusterConvoys(convoys, tasks as never)
    expect(patterns).toHaveLength(1)
    expect(patterns[0].sample_size).toBe(2)
  })

  it('calculates success rate correctly', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.updateConvoyStatus('c1', 'done', { finished_at: NOW, started_at: NOW })
    store.insertConvoy(makeConvoy({ id: 'c2', status: 'failed' }))
    store.updateConvoyStatus('c2', 'failed', { finished_at: NOW, started_at: NOW })

    const convoys = [store.getConvoy('c1')!, store.getConvoy('c2')!]
    const tasks = [
      makeTask({ id: 't1', convoy_id: 'c1', agent: 'developer' }),
      makeTask({ id: 't2', convoy_id: 'c2', agent: 'developer' }),
    ]

    const patterns = clusterConvoys(convoys, tasks as never)
    expect(patterns).toHaveLength(1)
    expect(patterns[0].success_rate).toBe(0.5)
  })
})

// ── analyzeAgentPerformance ───────────────────────────────────────────────────

describe('analyzeAgentPerformance', () => {
  it('returns empty array for no tasks', () => {
    expect(analyzeAgentPerformance([])).toHaveLength(0)
  })

  it('computes correct success rate for mixed tasks', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1', status: 'done', agent: 'developer' }))
    store.insertTask(makeTask({ id: 't2', convoy_id: 'c1', status: 'done', agent: 'developer' }))
    store.insertTask(makeTask({ id: 't3', convoy_id: 'c1', status: 'failed', agent: 'developer' }))
    store.updateTaskStatus('t1', 'c1', 'done')
    store.updateTaskStatus('t2', 'c1', 'done')
    store.updateTaskStatus('t3', 'c1', 'failed')

    const tasks = store.getTasksByConvoy('c1')
    const result = analyzeAgentPerformance(tasks)
    expect(result).toHaveLength(1)
    expect(result[0].success_rate).toBeCloseTo(2 / 3)
    expect(result[0].total_tasks).toBe(3)
  })

  it('identifies best file patterns', () => {
    const files = JSON.stringify(['src/cli/convoy/engine.ts', 'src/cli/convoy/store.ts'])
    store.insertConvoy(makeConvoy({ id: 'c1' }))
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1', status: 'done', agent: 'developer', files }))
    store.insertTask(makeTask({ id: 't2', convoy_id: 'c1', status: 'done', agent: 'developer', files }))
    store.insertTask(makeTask({ id: 't3', convoy_id: 'c1', status: 'done', agent: 'developer', files }))
    store.updateTaskStatus('t1', 'c1', 'done')
    store.updateTaskStatus('t2', 'c1', 'done')
    store.updateTaskStatus('t3', 'c1', 'done')

    const tasks = store.getTasksByConvoy('c1')
    const result = analyzeAgentPerformance(tasks)
    expect(result[0].best_file_patterns).toContain('src/cli')
  })

  it('identifies worst file patterns for low success rate', () => {
    const files = JSON.stringify(['src/dashboard/page.ts', 'src/dashboard/layout.ts'])
    store.insertConvoy(makeConvoy({ id: 'c1' }))
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1', status: 'failed', agent: 'developer', files }))
    store.insertTask(makeTask({ id: 't2', convoy_id: 'c1', status: 'failed', agent: 'developer', files }))
    store.insertTask(makeTask({ id: 't3', convoy_id: 'c1', status: 'failed', agent: 'developer', files }))
    store.updateTaskStatus('t1', 'c1', 'failed')
    store.updateTaskStatus('t2', 'c1', 'failed')
    store.updateTaskStatus('t3', 'c1', 'failed')

    const tasks = store.getTasksByConvoy('c1')
    const result = analyzeAgentPerformance(tasks)
    expect(result[0].worst_file_patterns).toContain('src/dashboard')
  })

  it('returns avg_duration_ms of 0 when no tasks have timestamps', () => {
    store.insertConvoy(makeConvoy({ id: 'c1' }))
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1', status: 'done', agent: 'developer' }))

    const tasks = store.getTasksByConvoy('c1')
    const result = analyzeAgentPerformance(tasks)
    expect(result[0].avg_duration_ms).toBe(0)
  })
})

// ── generateInsights ──────────────────────────────────────────────────────────

describe('generateInsights', () => {
  it('returns no-data message for empty inputs', () => {
    const insights = generateInsights([], [])
    expect(insights).toHaveLength(1)
    expect(insights[0]).toMatch(/No execution history/)
  })

  it('produces warning for low success rate agent', () => {
    const agents = [
      {
        agent: 'developer',
        total_tasks: 10,
        success_rate: 0.5,
        avg_duration_ms: 0,
        avg_tokens: 0,
        avg_retries: 0,
        best_file_patterns: [],
        worst_file_patterns: [],
      },
    ]
    const insights = generateInsights([], agents)
    expect(insights.some((i) => i.includes('⚠️') && i.includes('developer'))).toBe(true)
    expect(insights.some((i) => i.includes('50%'))).toBe(true)
  })

  it('produces 100% success message for perfect agent with enough tasks', () => {
    const agents = [
      {
        agent: 'testing-expert',
        total_tasks: 5,
        success_rate: 1,
        avg_duration_ms: 0,
        avg_tokens: 0,
        avg_retries: 0,
        best_file_patterns: [],
        worst_file_patterns: [],
      },
    ]
    const insights = generateInsights([], agents)
    expect(insights.some((i) => i.includes('100%') && i.includes('testing-expert'))).toBe(true)
  })

  it('includes pattern insight with concurrency', () => {
    const patterns = [
      {
        name: 'small-developer',
        task_count_range: [1, 2] as [number, number],
        agent_sequence: ['developer'],
        avg_duration_ms: 120000,
        avg_tokens: 5000,
        success_rate: 0.9,
        common_failure_agents: [],
        recommended_concurrency: 2,
        sample_size: 5,
      },
    ]
    const insights = generateInsights(patterns, [])
    expect(insights.some((i) => i.includes('concurrency 2'))).toBe(true)
  })
})

// ── analyzeDAG ────────────────────────────────────────────────────────────────

describe('analyzeDAG', () => {
  it('returns valid structure for empty database (no crash)', () => {
    const result = analyzeDAG(store)
    expect(result).toHaveProperty('patterns')
    expect(result).toHaveProperty('agent_stats')
    expect(result).toHaveProperty('insights')
    expect(result).toHaveProperty('generated_at')
    expect(Array.isArray(result.patterns)).toBe(true)
    expect(Array.isArray(result.agent_stats)).toBe(true)
    expect(Array.isArray(result.insights)).toBe(true)
  })

  it('returns populated agent data when history exists', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.updateConvoyStatus('c1', 'done', { finished_at: NOW, started_at: NOW })
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1', status: 'done', agent: 'developer' }))
    store.updateTaskStatus('t1', 'c1', 'done', { finished_at: NOW, started_at: NOW, total_tokens: 5000 })

    const result = analyzeDAG(store)
    expect(result.agent_stats.length).toBeGreaterThan(0)
    expect(result.agent_stats[0].agent).toBe('developer')
  })
})

// ── formatInsightsMarkdown ────────────────────────────────────────────────────

describe('formatInsightsMarkdown', () => {
  it('contains expected section headers', () => {
    const rec = analyzeDAG(store)
    const md = formatInsightsMarkdown(rec)
    expect(md).toContain('## Convoy Patterns')
    expect(md).toContain('## Agent Performance')
    expect(md).toContain('## Recommendations')
  })

  it('includes agent table for populated data', () => {
    store.insertConvoy(makeConvoy({ id: 'c1', status: 'done' }))
    store.updateConvoyStatus('c1', 'done', { finished_at: NOW, started_at: NOW })
    store.insertTask(makeTask({ id: 't1', convoy_id: 'c1', status: 'done', agent: 'developer' }))
    store.updateTaskStatus('t1', 'c1', 'done', { finished_at: NOW, started_at: NOW, total_tokens: 5000 })

    const rec = analyzeDAG(store)
    const md = formatInsightsMarkdown(rec)
    expect(md).toContain('developer')
  })
})
