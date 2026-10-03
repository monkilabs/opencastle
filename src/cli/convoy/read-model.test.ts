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
  readEventsSince,
  readRun,
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
    // This store has no estimate flag, so the read model does not claim either way.
    expect(current.cost_estimated).toBeUndefined()
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

describe('schemas it did not write', () => {
  it('reads columns a newer engine added, and leaves absent ones undefined', () => {
    seed()
    const db = new DatabaseSync(dbPath)
    db.exec('ALTER TABLE task ADD COLUMN cost_estimated INTEGER')
    db.exec('ALTER TABLE task ADD COLUMN cache_read_tokens INTEGER')
    db.exec('ALTER TABLE convoy ADD COLUMN adapter TEXT')
    db.exec("UPDATE task SET cost_estimated = 1 WHERE id = 'b'")
    db.exec("UPDATE task SET cost_estimated = 0, cache_read_tokens = 40000 WHERE id = 'a'")
    db.exec("UPDATE convoy SET adapter = 'codex', status = 'interrupted' WHERE id = 'new'")
    db.close()

    const run = readRun(root, 'new')!
    expect(run.status).toBe('interrupted')
    expect(run.cost_estimated).toBe(true)
    expect(run.adapters).toEqual(['claude', 'codex'])
    const [a, b] = run.tasks
    expect(a.cache_read_tokens).toBe(40_000)
    expect(a.cache_write_tokens).toBeUndefined()
    expect(a.cost_estimated).toBe(false)
    expect(b.cost_estimated).toBe(true)
    // An interrupted run is not alive, whatever the lock says.
    lock(process.pid, hostname(), T0, new Date().toISOString())
    expect(isRunAlive(root, 'new')).toBe(false)
  })

  it('reads an old database without migrating it', () => {
    // A v4 shape: no cost_usd_num, no review or drift columns, no dlq or artifact tables.
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
      CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, convoy_id TEXT, task_id TEXT, worker_id TEXT,
        type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL);
      PRAGMA user_version = 4;
    `)
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
    expect(readRun(root, 'new')!.alive).toBe(true)
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
