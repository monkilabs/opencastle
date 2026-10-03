import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConvoyStore } from './store.js'
import type { ConvoyStore } from './store.js'
import { KNOWN_EVENT_TYPES } from './types.js'
import {
  convoyDbPath,
  eventCategories,
  eventCategory,
  findProjectRoot,
  isProblemEvent,
  isRunAlive,
  overviewFrom,
  readAllSessions,
  readEngineSessions,
  readEventsSince,
  readOverview,
  readOverviewParts,
  readRun,
  readRunInsights,
  readRunSpec,
  readRuns,
  readSessions,
} from './read-model.js'

let root: string
let dbPath: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'read-model-')))
  mkdirSync(join(root, '.opencastle'), { recursive: true })
  dbPath = convoyDbPath(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:00:05.000Z'
const T2 = '2026-10-01T10:01:05.000Z'

function task(store: ConvoyStore, convoyId: string, id: string, extra: { phase?: number; depends_on?: string[]; agent?: string } = {}): void {
  store.insertTask({
    id,
    convoy_id: convoyId,
    phase: extra.phase ?? 0,
    prompt: `do ${id}`,
    agent: extra.agent ?? 'developer',
    adapter: null,
    model: null,
    timeout_ms: 60_000,
    status: 'pending',
    retries: 0,
    max_retries: 0,
    files: null,
    depends_on: extra.depends_on ? JSON.stringify(extra.depends_on) : null,
    gates: null,
  })
}

/** Two runs written through the real store: an older finished one and a newer one in progress. */
function seed(): void {
  const store = createConvoyStore(dbPath)
  store.insertConvoy({ id: 'old', name: 'Old run', spec_hash: 'h', status: 'pending', branch: null, created_at: T0, spec_yaml: 'x' })
  task(store, 'old', 'only')
  store.updateTaskStatus('only', 'old', 'done', { started_at: T0, finished_at: T1, total_tokens: 100, cost_usd: 0.01 })
  store.updateConvoyStatus('old', 'done', { started_at: T0, finished_at: T2, total_tokens: 100, total_cost_usd: 0.01 })

  store.insertConvoy({ id: 'new', name: 'New run', spec_hash: 'h', status: 'pending', branch: 'feat/x', created_at: T1, spec_yaml: 'x' })
  task(store, 'new', 'a')
  task(store, 'new', 'b')
  task(store, 'new', 'c', { phase: 1, depends_on: ['a', 'b'], agent: 'writer' })
  store.updateConvoyStatus('new', 'running', { started_at: T1 })
  store.insertWorker({ id: 'w-a', task_id: 'a', adapter: 'claude', pid: null, session_id: null, status: 'done', worktree: null, created_at: T1 })
  store.updateTaskStatus('a', 'new', 'done', {
    worker_id: 'w-a', started_at: T1, finished_at: T2, total_tokens: 45_812, cost_usd: 0.1234, model: 'claude-sonnet-4-5',
  })
  store.updateTaskStatus('b', 'new', 'failed', {
    started_at: T1, finished_at: T2, total_tokens: 15, cost_usd: 0.001, model: 'claude',
    output: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
  })
  const ev = (type: string, data: unknown, taskId: string | null = null): void => {
    store.insertEvent({ convoy_id: 'new', task_id: taskId, worker_id: null, type, data: JSON.stringify(data), created_at: T1 })
  }
  ev('convoy_started', { name: 'New run' })
  ev('task_started', { worker_id: 'w-a' }, 'a')
  ev('task_done', { exit_code: 0 }, 'a')
  ev('built_in_gate_result', { gate: 'secret_scan', passed: false }, 'b')
  ev('task_failed', { reason: 'error', exit_code: 1 }, 'b')
  store.close()
}

function lock(pid: number, host: string, startedAt: string, heartbeat: string): void {
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT OR REPLACE INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)')
    .run(pid, host, startedAt, heartbeat)
  db.close()
}

describe('with no database', () => {
  it('reads as no runs, never throws, and creates nothing', () => {
    expect(readRuns(root)).toEqual([])
    expect(readRun(root, 'x')).toBeNull()
    expect(readEventsSince(root, 'x', 0)).toEqual([])
    expect(isRunAlive(root, 'x')).toBe(false)
    expect(readSessions(root)).toEqual([])
    expect(readdirSync(join(root, '.opencastle'))).toEqual([])
  })
})

describe('runs', () => {
  it('lists newest first with task counts, tokens and cost', () => {
    seed()
    const runs = readRuns(root)
    expect(runs.map((r) => r.id)).toEqual(['new', 'old'])
    const [current, old] = runs
    expect(current).toMatchObject({
      name: 'New run', status: 'running', branch: 'feat/x', tasks_total: 3, tasks_done: 1, tasks_failed: 1,
      duration_ms: null, alive: false,
    })
    // Still running, so no run total yet: the sum of what tasks have recorded.
    expect(current.tokens).toBe(45_827)
    expect(current.cost_usd).toBeCloseTo(0.1244)
    // This store records whether each cost is an estimate, and none of these is.
    expect(current.cost_estimated).toBe(false)
    expect(old).toMatchObject({ status: 'done', tokens: 100, cost_usd: 0.01, duration_ms: 65_000 })
  })

  it('honours the limit', () => {
    seed()
    expect(readRuns(root, 1).map((r) => r.id)).toEqual(['new'])
  })

  it('reads one run with its tasks, dependencies and failure reason', () => {
    seed()
    const run = readRun(root, 'new')!
    expect(run.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    const [a, b, c] = run.tasks
    expect(c.depends_on).toEqual(['a', 'b'])
    expect(c.agent).toBe('writer')
    expect(a).toMatchObject({ status: 'done', adapter: 'claude', model: 'claude-sonnet-4-5', duration_ms: 60_000, total_tokens: 45_812 })
    expect(a.failure_reason).toBeNull()
    // "claude" is the adapter name the engine wrote when no model was reported.
    expect(b.model).toBeNull()
    expect(b.failure_reason).toBe('error (exit 1)')
    expect(b.error_tail!.split('\n')).toHaveLength(20)
    expect(b.error_tail!.endsWith('line 30')).toBe(true)
    expect(run.adapters).toEqual(['claude'])
    expect(run.models).toEqual(['claude-sonnet-4-5'])
  })

  it('returns null for an unknown run', () => {
    seed()
    expect(readRun(root, 'nope')).toBeNull()
  })

  it('reports a skipped review as skipped, never as a pass', () => {
    seed()
    const store = createConvoyStore(dbPath)
    store.updateTaskReview('a', 'new', { review_level: 'fast', review_verdict: 'skipped', review_tokens: 0, review_model: null })
    store.close()
    const [a, b] = readRun(root, 'new')!.tasks
    expect(a).toMatchObject({ review_verdict: 'skipped', review_level: 'fast' })
    expect(b.review_verdict).toBeNull()
  })

  it('reads the spec and runtime a run was started with, for resume', () => {
    seed()
    expect(readRunSpec(root, 'new')).toEqual({ specYaml: 'x', adapter: null })
    expect(readRunSpec(root, 'nope')).toBeNull()
  })

  it('does not write to the database it reads', () => {
    seed()
    const db = new DatabaseSync(dbPath)
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    db.close()
    const before = statSync(dbPath).mtimeMs
    readRuns(root)
    readRun(root, 'new')
    readEventsSince(root, 'new', 0)
    isRunAlive(root, 'new')
    expect(statSync(dbPath).mtimeMs).toBe(before)
    const after = new DatabaseSync(dbPath, { readOnly: true })
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(version)
    after.close()
    expect(readdirSync(join(root, '.opencastle')).filter((f) => f.endsWith('.bak'))).toEqual([])
  })
})

/**
 * A database in the shape of store schema 4: no cost_usd_num, no cost flag, no
 * cache counts, no adapter or review columns, no dlq or artifact tables. Written
 * by hand, because the store migrates anything it opens to the current schema.
 */
function oldShapeDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE convoy (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_hash TEXT NOT NULL, status TEXT NOT NULL,
      branch TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, spec_yaml TEXT NOT NULL,
      total_tokens INTEGER, total_cost_usd TEXT, pipeline_id TEXT);
    CREATE TABLE task (id TEXT NOT NULL, convoy_id TEXT NOT NULL, phase INTEGER NOT NULL, prompt TEXT NOT NULL,
      agent TEXT NOT NULL, adapter TEXT, model TEXT, timeout_ms INTEGER, status TEXT NOT NULL, worker_id TEXT,
      worktree TEXT, output TEXT, exit_code INTEGER, started_at TEXT, finished_at TEXT, retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 1, files TEXT, depends_on TEXT, prompt_tokens INTEGER,
      completion_tokens INTEGER, total_tokens INTEGER, cost_usd TEXT, PRIMARY KEY (id, convoy_id));
    CREATE TABLE worker (id TEXT PRIMARY KEY, task_id TEXT, adapter TEXT, pid INTEGER, session_id TEXT,
      status TEXT, worktree TEXT, created_at TEXT, finished_at TEXT);
    CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, convoy_id TEXT, task_id TEXT, worker_id TEXT,
      type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL);
    PRAGMA user_version = 4;
  `)
  return db
}

describe('schemas it did not write', () => {
  it('reads columns a newer engine added, and leaves absent ones undefined', () => {
    const db = oldShapeDb()
    db.exec(`INSERT INTO convoy (id, name, spec_hash, status, created_at, spec_yaml) VALUES ('new', 'New run', 'h', 'running', '${T1}', 'x')`)
    db.exec(`INSERT INTO worker (id, task_id, adapter, status) VALUES ('w-a', 'a', 'claude', 'done')`)
    db.exec(`INSERT INTO task (id, convoy_id, phase, prompt, agent, status, worker_id, total_tokens, cost_usd)
             VALUES ('a', 'new', 0, 'p', 'developer', 'done', 'w-a', 10, '0.1'),
                    ('b', 'new', 0, 'p', 'developer', 'failed', NULL, 5, '0.01')`)
    // Before a newer engine adds anything, nothing claims a cost is or is not an estimate.
    db.close()
    expect(readRun(root, 'new')!.cost_estimated).toBeUndefined()
    expect(readRun(root, 'new')!.tasks[0].cost_estimated).toBeUndefined()

    const later = new DatabaseSync(dbPath)
    later.exec('ALTER TABLE task ADD COLUMN cost_estimated INTEGER')
    later.exec('ALTER TABLE task ADD COLUMN cache_read_tokens INTEGER')
    later.exec('ALTER TABLE convoy ADD COLUMN adapter TEXT')
    later.exec("UPDATE task SET cost_estimated = 1 WHERE id = 'b'")
    later.exec("UPDATE task SET cost_estimated = 0, cache_read_tokens = 40000 WHERE id = 'a'")
    later.exec("UPDATE convoy SET adapter = 'codex', status = 'interrupted' WHERE id = 'new'")
    later.close()

    const run = readRun(root, 'new')!
    expect(run.status).toBe('interrupted')
    expect(run.cost_estimated).toBe(true)
    expect(run.adapters).toEqual(['claude', 'codex'])
    const [a, b] = run.tasks
    expect(a.cache_read_tokens).toBe(40_000)
    expect(a.cache_write_tokens).toBeUndefined()
    expect(a.review_verdict).toBeUndefined()
    expect(a.cost_estimated).toBe(false)
    expect(b.cost_estimated).toBe(true)
    // An interrupted run is not alive, whatever the lock says.
    const lockDb = new DatabaseSync(dbPath)
    lockDb.exec('CREATE TABLE engine_lock (id INTEGER PRIMARY KEY, pid INTEGER, hostname TEXT, started_at TEXT, last_heartbeat TEXT)')
    lockDb.close()
    lock(process.pid, hostname(), T0, new Date().toISOString())
    expect(isRunAlive(root, 'new')).toBe(false)
  })

  it('reads an old database without migrating it', () => {
    const db = oldShapeDb()
    db.exec(`INSERT INTO convoy VALUES ('v4', 'Legacy', 'h', 'done', NULL, '${T0}', '${T0}', '${T1}', 'x', 50, '0.5', NULL)`)
    db.exec(`INSERT INTO task (id, convoy_id, phase, prompt, agent, status, total_tokens, cost_usd)
             VALUES ('t', 'v4', 0, 'p', 'developer', 'done', 50, '0.5')`)
    db.close()

    expect(readRuns(root)).toMatchObject([{ id: 'v4', tokens: 50, cost_usd: 0.5, tasks_done: 1 }])
    const run = readRun(root, 'v4')!
    expect(run.tasks[0]).toMatchObject({ id: 't', cost_usd: 0.5, cache_read_tokens: undefined })
    expect(isRunAlive(root, 'v4')).toBe(false)

    const after = new DatabaseSync(dbPath, { readOnly: true })
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    after.close()
  })

  it('reads an empty database file as no runs', () => {
    writeFileSync(dbPath, '')
    expect(readRuns(root)).toEqual([])
    expect(readRun(root, 'x')).toBeNull()
  })
})

describe('events', () => {
  it('reads only what is newer than the cursor', () => {
    seed()
    const all = readEventsSince(root, 'new', 0)
    expect(all.map((e) => e.type)).toEqual(['convoy_started', 'task_started', 'task_done', 'built_in_gate_result', 'task_failed'])
    const later = readEventsSince(root, 'new', all[2].id)
    expect(later.map((e) => e.type)).toEqual(['built_in_gate_result', 'task_failed'])
    expect(readEventsSince(root, 'new', all[4].id)).toEqual([])
    expect(readEventsSince(root, 'new', 0, 2)).toHaveLength(2)
  })

  it('parses data and marks problems', () => {
    seed()
    const [started, , , gate, failed] = readEventsSince(root, 'new', 0)
    expect(started).toMatchObject({ category: 'run', problem: false, data: { name: 'New run' } })
    expect(gate).toMatchObject({ category: 'check', problem: true, task_id: 'b' })
    expect(failed).toMatchObject({ category: 'task', problem: true })
  })

  it('files every type the engine can emit under a real category', () => {
    const uncategorised = [...KNOWN_EVENT_TYPES].filter((t) => eventCategory(t) === 'other')
    expect(uncategorised).toEqual([])
    const grouped = eventCategories()
    expect(Object.values(grouped).flat().sort()).toEqual([...KNOWN_EVENT_TYPES].sort())
  })

  it('files gate results with the checks', () => {
    expect(eventCategory('gate_result')).toBe('check')
    expect(isProblemEvent('gate_result', { command: 'npm test', passed: false })).toBe(true)
    expect(isProblemEvent('gate_result', { command: 'npm test', passed: true })).toBe(false)
  })

  it('surfaces a review that blocked or reached no verdict, and not one that passed', () => {
    expect(isProblemEvent('review_verdict', { level: 'fast', verdict: 'block' })).toBe(true)
    expect(isProblemEvent('review_verdict', { level: 'fast', verdict: 'skipped' })).toBe(true)
    expect(isProblemEvent('review_skipped', { level: 'fast', reason: 'no verdict' })).toBe(true)
    expect(isProblemEvent('review_verdict', { level: 'auto-pass', verdict: 'pass' })).toBe(false)
  })

  it('places types by their prefix, so ones added later land somewhere sensible', () => {
    expect(eventCategory('task_interrupted')).toBe('task')
    expect(eventCategory('convoy_interrupted')).toBe('run')
    expect(eventCategory('merge_failed')).toBe('merge')
    expect(isProblemEvent('convoy_interrupted', null)).toBe(true)
    expect(isProblemEvent('task_done', { passed: true })).toBe(false)
    expect(isProblemEvent('drift_check_result', { passed: false })).toBe(true)
  })
})

describe('isRunAlive', () => {
  const fresh = (): string => new Date().toISOString()

  it('is false with no lock', () => {
    seed()
    expect(isRunAlive(root, 'new')).toBe(false)
  })

  it('is true while this host holds the lock with a live pid and a fresh heartbeat', () => {
    seed()
    lock(process.pid, hostname(), T0, fresh())
    expect(isRunAlive(root, 'new')).toBe(true)
    expect(readRuns(root).find((r) => r.id === 'new')!.alive).toBe(true)
    const run = readRun(root, 'new')!
    expect(run).toMatchObject({ alive: true, status: 'running', display_status: 'running' })
  })

  it('is false for a finished run, whoever holds the lock', () => {
    seed()
    lock(process.pid, hostname(), T0, fresh())
    expect(isRunAlive(root, 'old')).toBe(false)
  })

  it('is false when the pid is dead on this host, even with a fresh heartbeat', () => {
    seed()
    const gone = spawnSync(process.execPath, ['-e', '']).pid!
    lock(gone, hostname(), T0, fresh())
    expect(isRunAlive(root, 'new')).toBe(false)
  })

  it('is false when the heartbeat has stopped', () => {
    seed()
    lock(process.pid, hostname(), T0, new Date(Date.now() - 5 * 60_000).toISOString())
    expect(isRunAlive(root, 'new')).toBe(false)
  })

  it('trusts a fresh heartbeat from another host, where the pid cannot be checked', () => {
    seed()
    lock(1, 'some-other-host', T0, fresh())
    expect(isRunAlive(root, 'new')).toBe(true)
    lock(1, 'some-other-host', T0, new Date(Date.now() - 5 * 60_000).toISOString())
    expect(isRunAlive(root, 'new')).toBe(false)
  })

  it('does not lend a later run’s lock to one a crash left "running"', () => {
    seed()
    // The lock was taken after this run's last sign of life.
    lock(process.pid, hostname(), '2026-10-02T00:00:00.000Z', fresh())
    expect(isRunAlive(root, 'new')).toBe(false)
    // A resume writes an event after taking the lock, and the run is alive again.
    const db = new DatabaseSync(dbPath)
    db.prepare("INSERT INTO event (convoy_id, type, data, created_at) VALUES ('new', 'convoy_resumed', NULL, ?)").run(fresh())
    db.close()
    expect(isRunAlive(root, 'new')).toBe(true)
  })
})

describe('sessions', () => {
  it('reads session records newest first and skips everything else', () => {
    const logs = join(root, '.opencastle', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      join(logs, 'events.ndjson'),
      [
        JSON.stringify({ type: 'session', timestamp: T0, agent: 'Developer', task: 'first', outcome: 'success', duration_min: 3 }),
        'not json',
        JSON.stringify({ type: 'review', timestamp: T1, agent: 'Developer', verdict: 'pass' }),
        JSON.stringify({ type: 'session', timestamp: T2, agent: 'Writer', task: 'second', outcome: 'partial', model: 'm' }),
        '',
      ].join('\n'),
    )
    const sessions = readSessions(root)
    expect(sessions.map((s) => s.task)).toEqual(['second', 'first'])
    expect(sessions[0]).toMatchObject({ agent: 'Writer', outcome: 'partial', model: 'm', duration_min: null })
    expect(sessions[1]).toMatchObject({ duration_min: 3, model: null })
    expect(readSessions(root, 1)).toHaveLength(1)
  })
})

describe('findProjectRoot', () => {
  it('walks up to the nearest .opencastle directory', () => {
    const deep = join(root, 'src', 'a', 'b')
    mkdirSync(deep, { recursive: true })
    expect(findProjectRoot(deep)).toBe(root)
    expect(findProjectRoot(root)).toBe(root)
  })

  it('returns null when there is none above', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'no-project-')))
    try {
      // tmpdir itself could sit under a project on a developer machine; only assert when it does not.
      if (findProjectRoot(tmpdir()) === null) expect(findProjectRoot(outside)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ── The dashboard's aggregates ──────────────────────────────────────────────

const D1 = '2026-10-01T09:00:00.000Z'
const D2 = '2026-10-02T09:00:00.000Z'
const at = (base: string, seconds: number): string => new Date(Date.parse(base) + seconds * 1000).toISOString()

/**
 * Three runs written through the real store, shaped like what the engine
 * records now: a finished run whose first task failed a gate, was blocked by a
 * review and passed on its third attempt, while the second auto-passed; a run
 * whose only task failed for good; and one a crash left "running".
 */
function seedHistory(): void {
  const store = createConvoyStore(dbPath)
  const ev = (convoy: string, type: string, data: unknown, taskId: string | null = null, seconds = 0, base = D1): void => {
    store.insertEvent({ convoy_id: convoy, task_id: taskId, worker_id: null, type, data: JSON.stringify(data), created_at: at(base, seconds) })
  }

  store.insertConvoy({ id: 'r1', name: 'Tags', spec_hash: 'h', status: 'pending', branch: 'convoy/tags', created_at: D1, spec_yaml: 'x' })
  task(store, 'r1', 'a')
  task(store, 'r1', 'b', { phase: 1, depends_on: ['a'], agent: 'writer' })
  store.updateTaskStatus('a', 'r1', 'done', { started_at: at(D1, 1), finished_at: at(D1, 40), retries: 2, total_tokens: 1000, cost_usd: 0.5, model: 'claude-sonnet-5' })
  store.updateTaskStatus('b', 'r1', 'done', { started_at: at(D1, 41), finished_at: at(D1, 50), total_tokens: 550, cost_usd: 0.25, model: 'claude-haiku-4-5', cost_estimated: 1 })
  store.updateTaskReview('a', 'r1', { review_level: 'fast', review_verdict: 'pass', review_tokens: 250, review_model: 'claude-haiku-4-5' })
  store.updateTaskReview('b', 'r1', { review_level: 'auto-pass', review_verdict: 'pass', review_tokens: 0, review_model: null })
  store.updateConvoyStatus('r1', 'done', { started_at: D1, finished_at: at(D1, 60), total_tokens: 1550, total_cost_usd: 0.75, cost_estimated: true })
  ev('r1', 'convoy_started', { name: 'Tags' })
  ev('r1', 'task_started', { worker_id: 'w1', mechanism: 'worktree', adapter: 'claude', attempt: 1 }, 'a', 1)
  ev('r1', 'gate_result', { command: 'npm run lint', passed: false, exit_code: 1, scope: 'task' }, 'a', 5)
  ev('r1', 'task_retried', { previous_status: 'gate-failed', reason: 'Gate "npm run lint" failed (exit 1)', attempt: 2 }, 'a', 6)
  ev('r1', 'task_started', { worker_id: 'w2', mechanism: 'worktree', adapter: 'claude', attempt: 2 }, 'a', 7)
  ev('r1', 'gate_result', { command: 'npm run lint', passed: true, exit_code: 0, scope: 'task' }, 'a', 10)
  ev('r1', 'review_verdict', { level: 'fast', verdict: 'block', tokens: 300, model: 'claude-haiku-4-5', feedback_length: 80 }, 'a', 12)
  ev('r1', 'task_retried', { previous_status: 'review-blocked', reason: 'Remove the debug log', attempt: 3 }, 'a', 13)
  ev('r1', 'task_started', { worker_id: 'w3', mechanism: 'worktree', adapter: 'claude', attempt: 3 }, 'a', 14)
  ev('r1', 'review_verdict', { level: 'fast', verdict: 'pass', tokens: 250, model: 'claude-haiku-4-5', feedback_length: 0 }, 'a', 38)
  ev('r1', 'contract_violation', { task_id: 'a', agent: 'developer', missing: ['__contract_block'], warnings: [] }, 'a', 39)
  ev('r1', 'task_merged', { branch: 'convoy/tags', files: 3 }, 'a', 40)
  ev('r1', 'delegation', { agent: 'developer', tier: 'standard', mechanism: 'convoy' }, 'a', 40)
  ev('r1', 'session', { agent: 'developer', model: 'claude-sonnet-5', task: 'a', outcome: 'success', duration_min: 1, files_changed: 3, retries: 2, convoy_id: 'r1' }, 'a', 40)
  ev('r1', 'task_started', { worker_id: 'w4', mechanism: 'worktree', adapter: 'claude', attempt: 1 }, 'b', 41)
  ev('r1', 'built_in_gate_result', { gate: 'secret_scan', passed: true, output: '' }, 'b', 45)
  ev('r1', 'review_verdict', { level: 'auto-pass', verdict: 'pass', tokens: 0, model: null, feedback_length: 0 }, 'b', 49)
  ev('r1', 'task_merged', { branch: 'convoy/tags', files: 1 }, 'b', 50)
  ev('r1', 'delegation', { agent: 'writer', tier: 'economy', mechanism: 'convoy' }, 'b', 50)
  ev('r1', 'session', { agent: 'writer', model: 'claude-haiku-4-5', task: 'b', outcome: 'success', duration_min: 0, files_changed: 1, retries: 0, convoy_id: 'r1' }, 'b', 50)
  ev('r1', 'gate_result', { command: 'npm test', passed: false, exit_code: 1, scope: 'convoy', output: '1 failing' }, null, 52)
  ev('r1', 'gate_result', { command: 'npm test', passed: true, exit_code: 0, scope: 'convoy' }, null, 58)
  ev('r1', 'secret_leak_prevented', { patterns: ['github_token'], context: 'event_redacted', original_type: 'task_failed' }, null, 59)
  ev('r1', 'convoy_finished', { status: 'done' }, null, 60)
  store.insertArtifact({ id: 'art-1', convoy_id: 'r1', task_id: 'a', name: 'src/tags.js', type: 'file', content: '', created_at: at(D1, 40) })
  store.insertArtifact({ id: 'art-2', convoy_id: 'r1', task_id: 'b', name: 'summary', type: 'summary', content: 'Added tags', created_at: at(D1, 50) })

  store.insertConvoy({ id: 'r2', name: 'Search', spec_hash: 'h', status: 'pending', branch: null, created_at: D2, spec_yaml: 'x' })
  task(store, 'r2', 'c')
  store.updateTaskStatus('c', 'r2', 'failed', { started_at: at(D2, 1), finished_at: at(D2, 100), model: 'claude', output: 'Error: boom' })
  store.updateConvoyStatus('r2', 'failed', { started_at: D2, finished_at: at(D2, 120) })
  ev('r2', 'task_started', { worker_id: 'w5', mechanism: 'worktree', adapter: 'codex', attempt: 1 }, 'c', 1, D2)
  ev('r2', 'review_skipped', { level: 'fast', reason: 'the reviewer timed out' }, 'c', 90, D2)
  ev('r2', 'task_failed', { reason: 'error', message: 'Error: boom\n    at stub (x.js:1:1)', exit_code: 1 }, 'c', 100, D2)
  store.insertDlqEntry({
    id: 'dlq-1', convoy_id: 'r2', task_id: 'c', agent: 'developer', failure_type: 'error', error_output: 'Error: boom',
    attempts: 1, tokens_spent: null, escalation_task_id: null, resolved: 0, resolution: null, created_at: at(D2, 100), resolved_at: null,
  })

  store.insertConvoy({ id: 'r3', name: 'Crashed', spec_hash: 'h', status: 'pending', branch: null, created_at: at(D2, 600), spec_yaml: 'x' })
  task(store, 'r3', 'd')
  store.updateTaskStatus('d', 'r3', 'running', { started_at: at(D2, 601) })
  store.updateConvoyStatus('r3', 'running', { started_at: at(D2, 600) })
  ev('r3', 'task_started', { worker_id: 'w6', mechanism: 'worktree', adapter: 'claude', attempt: 1 }, 'd', 601, D2)
  store.close()
}

describe('display status', () => {
  it('shows a run left "running" with nothing running it as interrupted, and its running task too', () => {
    seedHistory()
    const crashed = readRun(root, 'r3')!
    expect(crashed).toMatchObject({ status: 'running', alive: false, display_status: 'interrupted' })
    expect(crashed.tasks[0]).toMatchObject({ status: 'running', display_status: 'interrupted' })
    expect(readRun(root, 'r1')!.display_status).toBe('done')
  })
})

describe('the overview', () => {
  it('counts every run, task, review and check from what the store holds', () => {
    seedHistory()
    const o = readOverview(root)
    expect(o.runs).toEqual({ total: 3, alive: 0, by_status: { done: 1, failed: 1, interrupted: 1 }, ended: 3, done: 1, success_rate: 1 / 3 })
    expect(o.duration).toEqual({ measured: 2, avg_ms: 90_000, p95_ms: 120_000, max_ms: 120_000 })
    // Only r1 recorded tokens and cost; the others are not reported, not zero.
    expect(o.tokens).toEqual({ total: 1550, runs_reported: 1, runs_not_reported: 2 })
    expect(o.cost).toEqual({ total_usd: 0.75, estimated: true, runs_reported: 1, runs_not_reported: 2 })
    expect(o.activity).toEqual([
      { date: '2026-10-01', total: 1, done: 1, failed: 0, interrupted: 0, other: 0 },
      { date: '2026-10-02', total: 2, done: 0, failed: 1, interrupted: 1, other: 0 },
    ])
    expect(o.tasks).toEqual({ total: 4, retries: 2, by_status: { done: 2, failed: 1, interrupted: 1 } })
    expect(o.agents).toEqual([
      { agent: 'developer', total: 3, done: 1, failed: 1, running: 0, other: 1 },
      { agent: 'writer', total: 1, done: 1, failed: 0, running: 0, other: 0 },
    ])
    // "claude" names the runtime, not a model, so task c reads as not reported.
    expect(o.models).toEqual([{ model: 'claude-haiku-4-5', tasks: 1 }, { model: 'claude-sonnet-5', tasks: 1 }])
    expect(o.models_not_reported).toBe(2)
    expect(o.tiers).toEqual([{ tier: 'economy', tasks: 1 }, { tier: 'standard', tasks: 1 }])
    expect(o.tiers_not_recorded).toBe(2)
    expect(o.mechanisms).toEqual([{ mechanism: 'worktree', attempts: 6 }])
    expect(o.runtimes).toEqual([{ runtime: 'claude', attempts: 5 }, { runtime: 'codex', attempts: 1 }])
    expect(o.reviews).toEqual({
      ran: 2, passed: 1, blocked: 1, skipped: 1, auto_pass: 1, tokens: 550,
      by_level: { fast: { pass: 1, block: 1 } }, models: { 'claude-haiku-4-5': 2 }, disputes: 0,
    })
    expect(o.checks).toEqual({
      ran: 5, passed: 3, failed: 2,
      gates: { passed: 2, failed: 2 }, built_in: { passed: 1, failed: 0 },
      by_scope: { task: { passed: 2, failed: 1 }, convoy: { passed: 1, failed: 1 } },
      warnings: 1, secrets_prevented: 1,
    })
    expect(o.dlq).toEqual({ entries: 1, unresolved: 1 })
    expect(o.artifacts).toBe(2)
  })

  it('combines projects by their rows, so a percentile is over every run and not an average of averages', () => {
    seedHistory()
    const one = readOverviewParts(root)
    const two = { ...one, runs: one.runs.map((r) => ({ ...r, id: `${r.id}-copy`, duration_ms: r.duration_ms === null ? null : r.duration_ms * 10 })) }
    const both = overviewFrom([one, two])
    expect(both.runs.total).toBe(6)
    expect(both.duration).toEqual({ measured: 4, avg_ms: 495_000, p95_ms: 1_200_000, max_ms: 1_200_000 })
    expect(both.reviews!.ran).toBe(4)
    expect(both.checks!.ran).toBe(10)
    expect(both.dlq).toEqual({ entries: 2, unresolved: 2 })
    expect(both.tasks.total).toBe(8)
    // Combining does not change the parts it was given.
    expect(one.reviews!.ran).toBe(2)
  })

  it('is empty, with nothing claimed, for a project that has never run', () => {
    const o = readOverview(root)
    expect(o.runs.total).toBe(0)
    expect(o.runs.success_rate).toBeNull()
    expect(o.duration.avg_ms).toBeNull()
    expect(o.tokens.total).toBeNull()
    expect(o.cost.total_usd).toBeNull()
    expect(o.reviews).toBeNull()
    expect(o.dlq).toBeNull()
    expect(readdirSync(join(root, '.opencastle'))).toEqual([])
  })

  it('reads an old database: what it never recorded is null, not zero', () => {
    const db = oldShapeDb()
    db.exec(`INSERT INTO convoy VALUES ('v4', 'Legacy', 'h', 'done', NULL, '${T0}', '${T0}', '${T1}', 'x', NULL, NULL, NULL)`)
    db.exec(`INSERT INTO task (id, convoy_id, phase, prompt, agent, status, model) VALUES ('t', 'v4', 0, 'p', 'developer', 'done', 'claude')`)
    db.exec('DROP TABLE event')
    db.close()
    const o = readOverview(root)
    expect(o.runs).toMatchObject({ total: 1, done: 1, success_rate: 1 })
    expect(o.tokens.total).toBeNull()
    expect(o.cost).toMatchObject({ total_usd: null, estimated: undefined })
    // No event table: reviews, checks and tiers are unknown, and no dlq or artifact table either.
    expect(o.reviews).toBeNull()
    expect(o.checks).toBeNull()
    expect(o.tiers).toEqual([])
    expect(o.tiers_not_recorded).toBe(1)
    expect(o.dlq).toBeNull()
    expect(o.artifacts).toBeNull()
    expect(o.models_not_reported).toBe(1)
    const ins = readRunInsights(root, 'v4')!
    expect(ins).toMatchObject({ events_recorded: false, dlq: null, artifacts: null, reviews: [], checks: [] })
    const after = new DatabaseSync(dbPath, { readOnly: true })
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    after.close()
  })
})

describe('run insights', () => {
  it('ties each review and gate to the attempt it read, and numbers the checks on the merged result', () => {
    seedHistory()
    const ins = readRunInsights(root, 'r1')!
    expect(ins.reviews.map((r) => [r.task_id, r.level, r.verdict, r.attempt, r.tokens])).toEqual([
      ['a', 'fast', 'block', 2, 300],
      ['a', 'fast', 'pass', 3, 250],
      ['b', 'auto-pass', 'pass', 1, 0],
    ])
    expect(ins.checks.map((c) => [c.name, c.kind, c.scope, c.task_id, c.passed, c.attempt, c.round])).toEqual([
      ['npm run lint', 'gate', 'task', 'a', false, 1, null],
      ['npm run lint', 'gate', 'task', 'a', true, 2, null],
      ['secret_scan', 'built-in', 'task', 'b', true, 1, null],
      ['npm test', 'gate', 'convoy', null, false, null, 1],
      ['npm test', 'gate', 'convoy', null, true, null, 2],
    ])
    expect(ins.checks[3]).toMatchObject({ exit_code: 1, output: '1 failing' })
    expect(ins.review_stats).toMatchObject({ ran: 2, passed: 1, blocked: 1, auto_pass: 1, skipped: 0 })
    expect(ins.tiers).toEqual([{ tier: 'economy', tasks: 1 }, { tier: 'standard', tasks: 1 }])
    expect(ins.task_tiers).toEqual({ a: 'standard', b: 'economy' })
    expect(ins.tiers_not_recorded).toBe(0)
    expect(ins.starts).toEqual({ a: 3, b: 1 })
    expect(ins.mechanisms).toEqual([{ mechanism: 'worktree', attempts: 4 }])
    expect(ins.merges).toEqual({ a: 3, b: 1 })
    expect(ins.retries.map((r) => [r.task_id, r.attempt, r.previous_status])).toEqual([['a', 2, 'gate-failed'], ['a', 3, 'review-blocked']])
    expect(ins.warnings).toMatchObject([{ type: 'contract_violation', task_id: 'a', items: ['no output summary block in the answer'] }])
    expect(ins.secrets_prevented).toMatchObject([{ context: 'event_redacted', patterns: ['github_token'] }])
    expect(ins.artifacts).toEqual([
      { name: 'src/tags.js', type: 'file', task_id: 'a', created_at: at(D1, 40), size_bytes: 0 },
      { name: 'summary', type: 'summary', task_id: 'b', created_at: at(D1, 50), size_bytes: 10 },
    ])
    expect(ins.dlq).toEqual([])
    expect(ins.sessions.map((s) => [s.source, s.task, s.convoy_id])).toEqual([['convoy', 'b', 'r1'], ['convoy', 'a', 'r1']])
    expect(ins.events_recorded).toBe(true)
  })

  it('reads the retry queue and a review that reached no verdict', () => {
    seedHistory()
    const ins = readRunInsights(root, 'r2')!
    expect(ins.dlq).toEqual([{
      id: 'dlq-1', task_id: 'c', agent: 'developer', failure_type: 'error', attempts: 1, tokens_spent: null,
      resolved: false, resolution: null, created_at: at(D2, 100), resolved_at: null, error_tail: 'Error: boom',
    }])
    expect(ins.reviews_skipped).toMatchObject([{ task_id: 'c', level: 'fast', reason: 'the reviewer timed out', attempt: 1 }])
    // The failure reads as what went wrong first, then the engine's code for it.
    expect(readRun(root, 'r2')!.tasks[0].failure_reason).toBe('Error: boom (error, exit 1)')
    expect(ins.review_stats).toMatchObject({ ran: 0, skipped: 1 })
    expect(ins.runtimes).toEqual([{ runtime: 'codex', attempts: 1 }])
    expect(ins.tiers_not_recorded).toBe(1)
  })

  it('is null for a run that does not exist', () => {
    seedHistory()
    expect(readRunInsights(root, 'nope')).toBeNull()
  })

  it('does not write to the database it reads', () => {
    seedHistory()
    const before = statSync(dbPath).mtimeMs
    readOverview(root)
    readRunInsights(root, 'r1')
    readAllSessions(root)
    expect(statSync(dbPath).mtimeMs).toBe(before)
  })
})

describe('sessions from both sources', () => {
  it('merges `opencastle log` records with the engine’s session events, newest first, each labelled', () => {
    seedHistory()
    const logs = join(root, '.opencastle', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'events.ndjson'), JSON.stringify({ type: 'session', timestamp: at(D1, 45), agent: 'Developer', task: 'by hand', outcome: 'success' }) + '\n')
    const all = readAllSessions(root)
    expect(all.map((s) => [s.source, s.task])).toEqual([['convoy', 'b'], ['log', 'by hand'], ['convoy', 'a']])
    expect(all[1]).toMatchObject({ convoy_id: null, agent: 'Developer' })
    expect(readEngineSessions(root, 'r2')).toEqual([])
    expect(readAllSessions(root, 2)).toHaveLength(2)
  })
})
