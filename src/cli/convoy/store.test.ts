import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createConvoyStore, migrateSchema, FieldSizeLimitError } from './store.js'
import type { ConvoyStore } from './store.js'

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string
let store: ConvoyStore

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'convoy-test-')))
  dbPath = join(tmpDir, 'test.db')
  store = createConvoyStore(dbPath)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeConvoy(overrides: Partial<Parameters<ConvoyStore['insertConvoy']>[0]> = {}) {
  return {
    id: 'convoy-1',
    name: 'Test Convoy',
    spec_hash: 'abc123',
    status: 'pending' as const,
    branch: null,
    created_at: new Date().toISOString(),
    spec_yaml: 'name: test',
    pipeline_id: null,
    ...overrides,
  }
}

function makeTask(overrides: Partial<Parameters<ConvoyStore['insertTask']>[0]> = {}) {
  return {
    id: 'task-1',
    convoy_id: 'convoy-1',
    phase: 0,
    prompt: 'Do something',
    agent: 'developer',
    adapter: null as string | null,
    model: null,
    timeout_ms: 1_800_000,
    status: 'pending' as const,
    retries: 0,
    max_retries: 1,
    files: null,
    depends_on: null,
    gates: null as string | null,
    ...overrides,
  } as Parameters<ConvoyStore['insertTask']>[0]
}

function makeWorker(overrides: Partial<Parameters<ConvoyStore['insertWorker']>[0]> = {}) {
  return {
    id: 'worker-1',
    task_id: null,
    adapter: 'copilot',
    pid: null,
    session_id: null,
    status: 'spawned' as const,
    worktree: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makePipeline(overrides: Partial<Parameters<ConvoyStore['insertPipeline']>[0]> = {}) {
  return {
    id: 'pipeline-1',
    name: 'Test Pipeline',
    status: 'pending' as const,
    branch: null,
    spec_yaml: 'name: test-pipeline\nversion: 2',
    convoy_specs: JSON.stringify(['convoys/step1.yml', 'convoys/step2.yml']),
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

// ── DB creation and WAL mode ──────────────────────────────────────────────────

describe('DB creation', () => {
  it('creates the database file at the given path', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync(dbPath)).toBe(true)
  })

  it('sets WAL journal mode', () => {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    db.close()
    expect(row.journal_mode).toBe('wal')
  })

  it('sets schema version to 11', () => {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    expect(row.user_version).toBe(11)
  })

  it('creates all required tables', () => {
    const db = new DatabaseSync(dbPath)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    db.close()
    const names = tables.map(t => t.name).sort()
    expect(names).toContain('convoy')
    expect(names).toContain('task')
    expect(names).toContain('worker')
    expect(names).toContain('event')
    expect(names).toContain('pipeline')
    expect(names).toContain('artifact')
    expect(names).toContain('agent_identity')
  })

  it('reopening an existing DB does not reset schema version', () => {
    store.close()
    const store2 = createConvoyStore(dbPath)
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    store2.close()
    // Reassign so afterEach does not double-close
    store = createConvoyStore(dbPath)
    expect(row.user_version).toBe(11)
  })
})

describe('schema migration', () => {
  it('schema migration v1 to v2 adds adapter column', () => {
    // Create a v1 database manually: task table without adapter column
    const v1DbPath = join(tmpDir, 'v1.db')
    const rawDb = new DatabaseSync(v1DbPath)
    rawDb.exec(`
      CREATE TABLE convoy (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        spec_hash   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        branch      TEXT,
        created_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT,
        spec_yaml   TEXT NOT NULL
      );
      CREATE TABLE task (
        id          TEXT PRIMARY KEY,
        convoy_id   TEXT NOT NULL REFERENCES convoy(id),
        phase       INTEGER NOT NULL,
        prompt      TEXT NOT NULL,
        agent       TEXT NOT NULL DEFAULT 'developer',
        model       TEXT,
        timeout_ms  INTEGER NOT NULL DEFAULT 1800000,
        status      TEXT NOT NULL DEFAULT 'pending',
        worker_id   TEXT,
        worktree    TEXT,
        output      TEXT,
        exit_code   INTEGER,
        started_at  TEXT,
        finished_at TEXT,
        retries     INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        files       TEXT,
        depends_on  TEXT
      );
      CREATE TABLE worker (
        id             TEXT PRIMARY KEY,
        task_id        TEXT REFERENCES task(id),
        adapter        TEXT NOT NULL,
        pid            INTEGER,
        session_id     TEXT,
        status         TEXT NOT NULL DEFAULT 'spawned',
        worktree       TEXT,
        created_at     TEXT NOT NULL,
        finished_at    TEXT,
        last_heartbeat TEXT
      );
      CREATE TABLE event (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        convoy_id  TEXT REFERENCES convoy(id),
        task_id    TEXT,
        worker_id  TEXT,
        type       TEXT NOT NULL,
        data       TEXT,
        created_at TEXT NOT NULL
      );
    `)
    rawDb.exec('PRAGMA user_version = 1')
    rawDb.close()

    // Open with createConvoyStore — should apply the v1→v2 migration
    const v1Store = createConvoyStore(v1DbPath)
    v1Store.close()

    // Verify adapter column was added to task table
    const verifyDb = new DatabaseSync(v1DbPath)
    const cols = verifyDb.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    const version = verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }
    verifyDb.close()

    expect(cols.map(c => c.name)).toContain('adapter')
    // v1 chains through v2→v3→v4→...→v7→v8→v9→v10→v11 in one init, so final version is 11
    expect(version.user_version).toBe(11)
  })

  it('schema migration v2 to v3 adds cost columns', () => {
    // Create a v2 database manually (has adapter column but no cost columns)
    const v2DbPath = join(tmpDir, 'v2.db')
    const rawDb = new DatabaseSync(v2DbPath)
    rawDb.exec(`
      CREATE TABLE convoy (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        spec_hash   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        branch      TEXT,
        created_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT,
        spec_yaml   TEXT NOT NULL
      );
      CREATE TABLE task (
        id          TEXT PRIMARY KEY,
        convoy_id   TEXT NOT NULL REFERENCES convoy(id),
        phase       INTEGER NOT NULL,
        prompt      TEXT NOT NULL,
        agent       TEXT NOT NULL DEFAULT 'developer',
        adapter     TEXT,
        model       TEXT,
        timeout_ms  INTEGER NOT NULL DEFAULT 1800000,
        status      TEXT NOT NULL DEFAULT 'pending',
        worker_id   TEXT,
        worktree    TEXT,
        output      TEXT,
        exit_code   INTEGER,
        started_at  TEXT,
        finished_at TEXT,
        retries     INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        files       TEXT,
        depends_on  TEXT
      );
      CREATE TABLE worker (
        id             TEXT PRIMARY KEY,
        task_id        TEXT REFERENCES task(id),
        adapter        TEXT NOT NULL,
        pid            INTEGER,
        session_id     TEXT,
        status         TEXT NOT NULL DEFAULT 'spawned',
        worktree       TEXT,
        created_at     TEXT NOT NULL,
        finished_at    TEXT,
        last_heartbeat TEXT
      );
      CREATE TABLE event (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        convoy_id  TEXT REFERENCES convoy(id),
        task_id    TEXT,
        worker_id  TEXT,
        type       TEXT NOT NULL,
        data       TEXT,
        created_at TEXT NOT NULL
      );
    `)
    rawDb.exec('PRAGMA user_version = 2')
    rawDb.close()

    // Open with createConvoyStore — should apply the v2→v3 migration
    const v2Store = createConvoyStore(v2DbPath)
    v2Store.close()

    // Verify cost columns were added
    const verifyDb = new DatabaseSync(v2DbPath)
    const taskCols = verifyDb.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    const convoyCols = verifyDb.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>
    const version = verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }
    verifyDb.close()

    const taskColNames = taskCols.map(c => c.name)
    expect(taskColNames).toContain('prompt_tokens')
    expect(taskColNames).toContain('completion_tokens')
    expect(taskColNames).toContain('total_tokens')
    expect(taskColNames).toContain('cost_usd')

    const convoyColNames = convoyCols.map(c => c.name)
    expect(convoyColNames).toContain('total_tokens')
    expect(convoyColNames).toContain('total_cost_usd')

    expect(version.user_version).toBe(11)
  })

  it('schema migration v1 to v3 chains correctly in a single init', () => {
    // Create a v1 database (task table without adapter or cost columns)
    const v1DbPath = join(tmpDir, 'v1-chain.db')
    const rawDb = new DatabaseSync(v1DbPath)
    rawDb.exec(`
      CREATE TABLE convoy (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        spec_hash   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        branch      TEXT,
        created_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT,
        spec_yaml   TEXT NOT NULL
      );
      CREATE TABLE task (
        id          TEXT PRIMARY KEY,
        convoy_id   TEXT NOT NULL REFERENCES convoy(id),
        phase       INTEGER NOT NULL,
        prompt      TEXT NOT NULL,
        agent       TEXT NOT NULL DEFAULT 'developer',
        model       TEXT,
        timeout_ms  INTEGER NOT NULL DEFAULT 1800000,
        status      TEXT NOT NULL DEFAULT 'pending',
        worker_id   TEXT,
        worktree    TEXT,
        output      TEXT,
        exit_code   INTEGER,
        started_at  TEXT,
        finished_at TEXT,
        retries     INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        files       TEXT,
        depends_on  TEXT
      );
      CREATE TABLE worker (
        id             TEXT PRIMARY KEY,
        task_id        TEXT REFERENCES task(id),
        adapter        TEXT NOT NULL,
        pid            INTEGER,
        session_id     TEXT,
        status         TEXT NOT NULL DEFAULT 'spawned',
        worktree       TEXT,
        created_at     TEXT NOT NULL,
        finished_at    TEXT,
        last_heartbeat TEXT
      );
      CREATE TABLE event (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        convoy_id  TEXT REFERENCES convoy(id),
        task_id    TEXT,
        worker_id  TEXT,
        type       TEXT NOT NULL,
        data       TEXT,
        created_at TEXT NOT NULL
      );
    `)
    rawDb.exec('PRAGMA user_version = 1')
    rawDb.close()

    // Open with createConvoyStore — should chain v1→v2→v3 in one init
    const v1Store = createConvoyStore(v1DbPath)
    v1Store.close()

    // Verify all columns from both migrations are present
    const verifyDb = new DatabaseSync(v1DbPath)
    const taskCols = verifyDb.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    const convoyCols = verifyDb.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>
    const version = verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }
    verifyDb.close()

    const taskColNames = taskCols.map(c => c.name)
    expect(taskColNames).toContain('adapter')
    expect(taskColNames).toContain('prompt_tokens')
    expect(taskColNames).toContain('completion_tokens')
    expect(taskColNames).toContain('total_tokens')
    expect(taskColNames).toContain('cost_usd')

    const convoyColNames = convoyCols.map(c => c.name)
    expect(convoyColNames).toContain('total_tokens')
    expect(convoyColNames).toContain('total_cost_usd')

    expect(version.user_version).toBe(11)
  })

  it('schema migration v3 to v4 creates pipeline table and adds pipeline_id to convoy', () => {
    const v3DbPath = join(tmpDir, 'v3.db')
    const rawDb = new DatabaseSync(v3DbPath)
    rawDb.exec(`
      CREATE TABLE convoy (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        spec_hash   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        branch      TEXT,
        created_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT,
        spec_yaml   TEXT NOT NULL,
        total_tokens INTEGER,
        total_cost_usd TEXT
      );
      CREATE TABLE task (
        id          TEXT PRIMARY KEY,
        convoy_id   TEXT NOT NULL REFERENCES convoy(id),
        phase       INTEGER NOT NULL,
        prompt      TEXT NOT NULL,
        agent       TEXT NOT NULL DEFAULT 'developer',
        adapter     TEXT,
        model       TEXT,
        timeout_ms  INTEGER NOT NULL DEFAULT 1800000,
        status      TEXT NOT NULL DEFAULT 'pending',
        worker_id   TEXT,
        worktree    TEXT,
        output      TEXT,
        exit_code   INTEGER,
        started_at  TEXT,
        finished_at TEXT,
        retries     INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        files       TEXT,
        depends_on  TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd TEXT
      );
      CREATE TABLE worker (
        id             TEXT PRIMARY KEY,
        task_id        TEXT REFERENCES task(id),
        adapter        TEXT NOT NULL,
        pid            INTEGER,
        session_id     TEXT,
        status         TEXT NOT NULL DEFAULT 'spawned',
        worktree       TEXT,
        created_at     TEXT NOT NULL,
        finished_at    TEXT,
        last_heartbeat TEXT
      );
      CREATE TABLE event (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        convoy_id  TEXT REFERENCES convoy(id),
        task_id    TEXT,
        worker_id  TEXT,
        type       TEXT NOT NULL,
        data       TEXT,
        created_at TEXT NOT NULL
      );
    `)
    rawDb.exec('PRAGMA user_version = 3')
    rawDb.close()

    const v3Store = createConvoyStore(v3DbPath)
    v3Store.close()

    const verifyDb = new DatabaseSync(v3DbPath)
    const convoyCols = verifyDb.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>
    const tables = verifyDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const version = verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }
    verifyDb.close()

    expect(convoyCols.map(c => c.name)).toContain('pipeline_id')
    expect(tables.map(t => t.name)).toContain('pipeline')
    expect(version.user_version).toBe(11)
  })
})

// ── convoy CRUD ───────────────────────────────────────────────────────────────

describe('convoy CRUD', () => {
  it('inserts and retrieves a convoy record', () => {
    const record = makeConvoy()
    store.insertConvoy(record)
    const retrieved = store.getConvoy('convoy-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe('convoy-1')
    expect(retrieved!.name).toBe('Test Convoy')
    expect(retrieved!.status).toBe('pending')
    expect(retrieved!.started_at).toBeNull()
    expect(retrieved!.finished_at).toBeNull()
  })

  it('returns undefined for missing convoy', () => {
    expect(store.getConvoy('does-not-exist')).toBeUndefined()
  })

  it('updates convoy status', () => {
    store.insertConvoy(makeConvoy())
    store.updateConvoyStatus('convoy-1', 'running')
    expect(store.getConvoy('convoy-1')!.status).toBe('running')
  })

  it('updates convoy status with started_at', () => {
    const ts = '2026-01-01T00:00:00.000Z'
    store.insertConvoy(makeConvoy())
    store.updateConvoyStatus('convoy-1', 'running', { started_at: ts })
    const retrieved = store.getConvoy('convoy-1')!
    expect(retrieved.status).toBe('running')
    expect(retrieved.started_at).toBe(ts)
  })

  it('updates convoy status with finished_at', () => {
    const ts = '2026-01-01T01:00:00.000Z'
    store.insertConvoy(makeConvoy())
    store.updateConvoyStatus('convoy-1', 'done', { finished_at: ts })
    const retrieved = store.getConvoy('convoy-1')!
    expect(retrieved.status).toBe('done')
    expect(retrieved.finished_at).toBe(ts)
  })

  it('cost fields are null by default on a new convoy', () => {
    store.insertConvoy(makeConvoy())
    const retrieved = store.getConvoy('convoy-1')!
    expect(retrieved.total_tokens).toBeNull()
    expect(retrieved.total_cost_usd).toBeNull()
  })

  it('updateConvoyStatus persists total_tokens and total_cost_usd', () => {
    store.insertConvoy(makeConvoy())
    store.updateConvoyStatus('convoy-1', 'done', {
      finished_at: '2026-01-01T01:00:00.000Z',
      total_tokens: 5000,
      total_cost_usd: 0.015,
    })
    const retrieved = store.getConvoy('convoy-1')!
    expect(retrieved.total_tokens).toBe(5000)
    expect(retrieved.total_cost_usd).toBe(0.015)
  })
})

// ── task CRUD ─────────────────────────────────────────────────────────────────

describe('task CRUD', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
  })

  it('inserts and retrieves a task record', () => {
    store.insertTask(makeTask())
    const retrieved = store.getTask('task-1', 'convoy-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe('task-1')
    expect(retrieved!.convoy_id).toBe('convoy-1')
    expect(retrieved!.status).toBe('pending')
    expect(retrieved!.worker_id).toBeNull()
    expect(retrieved!.output).toBeNull()
  })

  it('returns undefined for missing task', () => {
    expect(store.getTask('does-not-exist', 'convoy-1')).toBeUndefined()
  })

  it('insertTask stores adapter field', () => {
    store.insertTask(makeTask({ adapter: 'opencode' }))
    const retrieved = store.getTask('task-1', 'convoy-1')!
    expect(retrieved.adapter).toBe('opencode')
  })

  it('stores JSON fields as strings', () => {
    const task = makeTask({
      id: 'task-json',
      files: JSON.stringify(['src/a.ts', 'src/b.ts']),
      depends_on: JSON.stringify(['task-prev']),
    })
    store.insertTask(task)
    const retrieved = store.getTask('task-json', 'convoy-1')!
    expect(JSON.parse(retrieved.files!)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(JSON.parse(retrieved.depends_on!)).toEqual(['task-prev'])
  })

  it('retrieves all tasks for a convoy ordered by phase', () => {
    store.insertTask(makeTask({ id: 'task-2', phase: 1 }))
    store.insertTask(makeTask({ id: 'task-1', phase: 0 }))
    const tasks = store.getTasksByConvoy('convoy-1')
    expect(tasks).toHaveLength(2)
    expect(tasks[0].phase).toBe(0)
    expect(tasks[1].phase).toBe(1)
  })

  it('updates task status', () => {
    store.insertTask(makeTask())
    store.updateTaskStatus('task-1', 'convoy-1', 'running')
    expect(store.getTask('task-1', 'convoy-1')!.status).toBe('running')
  })

  it('updates task status with extra fields', () => {
    const ts = '2026-01-01T00:00:00.000Z'
    store.insertTask(makeTask())
    store.updateTaskStatus('task-1', 'convoy-1', 'done', {
      output: 'Task complete',
      exit_code: 0,
      finished_at: ts,
      retries: 1,
    })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.status).toBe('done')
    expect(task.output).toBe('Task complete')
    expect(task.exit_code).toBe(0)
    expect(task.finished_at).toBe(ts)
    expect(task.retries).toBe(1)
  })

  it('cost fields are null by default on a new task', () => {
    store.insertTask(makeTask())
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.prompt_tokens).toBeNull()
    expect(task.completion_tokens).toBeNull()
    expect(task.total_tokens).toBeNull()
    expect(task.cost_usd).toBeNull()
  })

  it('updateTaskStatus persists cost fields', () => {
    store.insertTask(makeTask())
    store.updateTaskStatus('task-1', 'convoy-1', 'done', {
      prompt_tokens: 1200,
      completion_tokens: 800,
      total_tokens: 2000,
      cost_usd: 0.006,
    })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.prompt_tokens).toBe(1200)
    expect(task.completion_tokens).toBe(800)
    expect(task.total_tokens).toBe(2000)
    expect(task.cost_usd).toBe(0.006)
  })
})

// ── getReadyTasks ─────────────────────────────────────────────────────────────

describe('getReadyTasks', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
  })

  it('returns a pending task with no dependencies', () => {
    store.insertTask(makeTask({ id: 'task-a', depends_on: null }))
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).toContain('task-a')
  })

  it('returns a pending task with empty depends_on array', () => {
    store.insertTask(makeTask({ id: 'task-a', depends_on: JSON.stringify([]) }))
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).toContain('task-a')
  })

  it('returns a task when its single dependency is done', () => {
    store.insertTask(makeTask({ id: 'task-dep', depends_on: null }))
    store.insertTask(makeTask({ id: 'task-a', depends_on: JSON.stringify(['task-dep']) }))
    store.updateTaskStatus('task-dep', 'convoy-1', 'done')
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).toContain('task-a')
  })

  it('does not return a task when its single dependency is not done', () => {
    store.insertTask(makeTask({ id: 'task-dep', depends_on: null }))
    store.insertTask(makeTask({ id: 'task-a', depends_on: JSON.stringify(['task-dep']) }))
    // task-dep stays pending
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).not.toContain('task-a')
  })

  it('returns a task when all multiple dependencies are done', () => {
    store.insertTask(makeTask({ id: 'dep-1', depends_on: null }))
    store.insertTask(makeTask({ id: 'dep-2', depends_on: null }))
    store.insertTask(makeTask({ id: 'task-a', depends_on: JSON.stringify(['dep-1', 'dep-2']) }))
    store.updateTaskStatus('dep-1', 'convoy-1', 'done')
    store.updateTaskStatus('dep-2', 'convoy-1', 'done')
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).toContain('task-a')
  })

  it('does not return a task when only some of multiple dependencies are done', () => {
    store.insertTask(makeTask({ id: 'dep-1', depends_on: null }))
    store.insertTask(makeTask({ id: 'dep-2', depends_on: null }))
    store.insertTask(makeTask({ id: 'task-a', depends_on: JSON.stringify(['dep-1', 'dep-2']) }))
    store.updateTaskStatus('dep-1', 'convoy-1', 'done')
    // dep-2 stays pending
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).not.toContain('task-a')
  })

  it('does not return tasks that are already running', () => {
    store.insertTask(makeTask({ id: 'task-a', depends_on: null }))
    store.updateTaskStatus('task-a', 'convoy-1', 'running')
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).not.toContain('task-a')
  })

  it('does not return tasks that are already done', () => {
    store.insertTask(makeTask({ id: 'task-a', depends_on: null }))
    store.updateTaskStatus('task-a', 'convoy-1', 'done')
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).not.toContain('task-a')
  })

  it('returns empty array when no tasks are ready', () => {
    store.insertTask(makeTask({ id: 'dep-1', depends_on: null, status: 'running' }))
    store.insertTask(makeTask({ id: 'task-a', depends_on: JSON.stringify(['dep-1']) }))
    const ready = store.getReadyTasks('convoy-1')
    expect(ready.map(t => t.id)).not.toContain('task-a')
  })

  it('returns empty array for a convoy with no tasks', () => {
    const ready = store.getReadyTasks('convoy-1')
    expect(ready).toHaveLength(0)
  })
})

// ── worker CRUD ───────────────────────────────────────────────────────────────

describe('worker CRUD', () => {
  it('inserts and retrieves a worker record', () => {
    store.insertWorker(makeWorker())
    const retrieved = store.getWorker('worker-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe('worker-1')
    expect(retrieved!.adapter).toBe('copilot')
    expect(retrieved!.status).toBe('spawned')
    expect(retrieved!.finished_at).toBeNull()
    expect(retrieved!.last_heartbeat).toBeNull()
  })

  it('returns undefined for missing worker', () => {
    expect(store.getWorker('does-not-exist')).toBeUndefined()
  })

  it('updates worker status', () => {
    store.insertWorker(makeWorker())
    store.updateWorkerStatus('worker-1', 'running')
    expect(store.getWorker('worker-1')!.status).toBe('running')
  })

  it('updates worker status with finished_at and pid', () => {
    const ts = '2026-01-01T01:00:00.000Z'
    store.insertWorker(makeWorker())
    store.updateWorkerStatus('worker-1', 'done', { finished_at: ts, pid: 12345 })
    const worker = store.getWorker('worker-1')!
    expect(worker.status).toBe('done')
    expect(worker.finished_at).toBe(ts)
    expect(worker.pid).toBe(12345)
  })

  it('updates worker last_heartbeat', () => {
    const ts = '2026-01-01T00:30:00.000Z'
    store.insertWorker(makeWorker())
    store.updateWorkerStatus('worker-1', 'running', { last_heartbeat: ts })
    expect(store.getWorker('worker-1')!.last_heartbeat).toBe(ts)
  })
})

// ── event CRUD ────────────────────────────────────────────────────────────────

describe('event CRUD', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
  })

  it('inserts and retrieves events for a convoy', () => {
    store.insertEvent({
      convoy_id: 'convoy-1',
      task_id: null,
      worker_id: null,
      type: 'convoy_started',
      data: JSON.stringify({ msg: 'hello' }),
      created_at: new Date().toISOString(),
    })
    const events = store.getEvents('convoy-1')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('convoy_started')
    expect(events[0].convoy_id).toBe('convoy-1')
    expect(JSON.parse(events[0].data!)).toEqual({ msg: 'hello' })
  })

  it('returns events ordered by id (insertion order)', () => {
    const now = new Date().toISOString()
    store.insertEvent({ convoy_id: 'convoy-1', task_id: null, worker_id: null, type: 'first', data: null, created_at: now })
    store.insertEvent({ convoy_id: 'convoy-1', task_id: null, worker_id: null, type: 'second', data: null, created_at: now })
    store.insertEvent({ convoy_id: 'convoy-1', task_id: null, worker_id: null, type: 'third', data: null, created_at: now })
    const events = store.getEvents('convoy-1')
    expect(events.map(e => e.type)).toEqual(['first', 'second', 'third'])
  })

  it('returns empty array for convoy with no events', () => {
    expect(store.getEvents('convoy-1')).toHaveLength(0)
  })

  it('assigns autoincrement id', () => {
    const now = new Date().toISOString()
    store.insertEvent({ convoy_id: 'convoy-1', task_id: null, worker_id: null, type: 'ev', data: null, created_at: now })
    store.insertEvent({ convoy_id: 'convoy-1', task_id: null, worker_id: null, type: 'ev2', data: null, created_at: now })
    const events = store.getEvents('convoy-1')
    expect(typeof events[0].id).toBe('number')
    expect(events[1].id).toBeGreaterThan(events[0].id!)
  })
})

// ── withTransaction ───────────────────────────────────────────────────────────

describe('withTransaction', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
  })

  it('commits on success and returns the result', () => {
    const result = store.withTransaction(() => {
      store.insertTask(makeTask())
      return 'done'
    })
    expect(result).toBe('done')
    expect(store.getTask('task-1', 'convoy-1')).toBeDefined()
  })

  it('rolls back on error and re-throws', () => {
    expect(() => {
      store.withTransaction(() => {
        store.insertTask(makeTask())
        throw new Error('forced error')
      })
    }).toThrow('forced error')

    expect(store.getTask('task-1', 'convoy-1')).toBeUndefined()
  })

  it('supports nested data operations inside transaction', () => {
    const ts = new Date().toISOString()
    store.withTransaction(() => {
      store.insertTask(makeTask({ id: 'task-alpha' }))
      store.updateTaskStatus('task-alpha', 'convoy-1', 'running', { started_at: ts })
    })
    const task = store.getTask('task-alpha', 'convoy-1')!
    expect(task.status).toBe('running')
    expect(task.started_at).toBe(ts)
  })
})

// ── pipeline CRUD ─────────────────────────────────────────────────────────────

describe('pipeline CRUD', () => {
  it('inserts and retrieves a pipeline record', () => {
    store.insertPipeline(makePipeline())
    const retrieved = store.getPipeline('pipeline-1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe('pipeline-1')
    expect(retrieved!.name).toBe('Test Pipeline')
    expect(retrieved!.status).toBe('pending')
    expect(retrieved!.started_at).toBeNull()
    expect(retrieved!.finished_at).toBeNull()
    expect(retrieved!.total_tokens).toBeNull()
    expect(retrieved!.total_cost_usd).toBeNull()
  })

  it('returns undefined for missing pipeline', () => {
    expect(store.getPipeline('does-not-exist')).toBeUndefined()
  })

  it('getLatestPipeline returns most recent pipeline', () => {
    store.insertPipeline(makePipeline({ id: 'pipeline-old', created_at: '2026-01-01T00:00:00.000Z' }))
    store.insertPipeline(makePipeline({ id: 'pipeline-new', created_at: '2026-01-02T00:00:00.000Z' }))
    const latest = store.getLatestPipeline()
    expect(latest?.id).toBe('pipeline-new')
  })

  it('getLatestPipeline returns undefined when no pipelines exist', () => {
    expect(store.getLatestPipeline()).toBeUndefined()
  })

  it('updatePipelineStatus updates status', () => {
    store.insertPipeline(makePipeline())
    store.updatePipelineStatus('pipeline-1', 'running')
    expect(store.getPipeline('pipeline-1')!.status).toBe('running')
  })

  it('updatePipelineStatus sets started_at', () => {
    const ts = '2026-01-01T00:00:00.000Z'
    store.insertPipeline(makePipeline())
    store.updatePipelineStatus('pipeline-1', 'running', { started_at: ts })
    const p = store.getPipeline('pipeline-1')!
    expect(p.status).toBe('running')
    expect(p.started_at).toBe(ts)
  })

  it('updatePipelineStatus sets finished_at', () => {
    const ts = '2026-01-01T01:00:00.000Z'
    store.insertPipeline(makePipeline())
    store.updatePipelineStatus('pipeline-1', 'done', { finished_at: ts })
    const p = store.getPipeline('pipeline-1')!
    expect(p.status).toBe('done')
    expect(p.finished_at).toBe(ts)
  })

  it('updatePipelineStatus persists total_tokens and total_cost_usd', () => {
    store.insertPipeline(makePipeline())
    store.updatePipelineStatus('pipeline-1', 'done', {
      finished_at: '2026-01-01T01:00:00.000Z',
      total_tokens: 12000,
      total_cost_usd: 0.036,
    })
    const p = store.getPipeline('pipeline-1')!
    expect(p.total_tokens).toBe(12000)
    expect(p.total_cost_usd).toBe(0.036)
  })

  it('pipeline status can transition through all states', () => {
    store.insertPipeline(makePipeline())
    const states = ['running', 'failed', 'done', 'pending'] as const
    for (const s of states) {
      store.updatePipelineStatus('pipeline-1', s)
      expect(store.getPipeline('pipeline-1')!.status).toBe(s)
    }
  })

  it('convoy_specs is stored and retrieved as a JSON string', () => {
    const specs = ['convoys/build.yml', 'convoys/test.yml', 'convoys/deploy.yml']
    store.insertPipeline(makePipeline({ convoy_specs: JSON.stringify(specs) }))
    const p = store.getPipeline('pipeline-1')!
    expect(JSON.parse(p.convoy_specs)).toEqual(specs)
  })
})

// ── pipeline-convoy linking ───────────────────────────────────────────────────

describe('pipeline-convoy linking', () => {
  it('insertConvoy accepts pipeline_id', () => {
    store.insertPipeline(makePipeline())
    store.insertConvoy(makeConvoy({ pipeline_id: 'pipeline-1' }))
    const c = store.getConvoy('convoy-1')!
    expect(c.pipeline_id).toBe('pipeline-1')
  })

  it('insertConvoy with null pipeline_id creates a standalone convoy', () => {
    store.insertConvoy(makeConvoy({ pipeline_id: null }))
    const c = store.getConvoy('convoy-1')!
    expect(c.pipeline_id).toBeNull()
  })

  it('getConvoysByPipeline returns all convoys for a pipeline', () => {
    store.insertPipeline(makePipeline())
    store.insertConvoy(makeConvoy({ id: 'convoy-1', pipeline_id: 'pipeline-1', created_at: '2026-01-01T00:00:00.000Z' }))
    store.insertConvoy(makeConvoy({ id: 'convoy-2', pipeline_id: 'pipeline-1', created_at: '2026-01-01T01:00:00.000Z' }))
    const convoys = store.getConvoysByPipeline('pipeline-1')
    expect(convoys).toHaveLength(2)
    expect(convoys.map(c => c.id)).toEqual(['convoy-1', 'convoy-2'])
  })

  it('getConvoysByPipeline returns convoys ordered by created_at', () => {
    store.insertPipeline(makePipeline())
    store.insertConvoy(makeConvoy({ id: 'convoy-b', pipeline_id: 'pipeline-1', created_at: '2026-01-01T02:00:00.000Z' }))
    store.insertConvoy(makeConvoy({ id: 'convoy-a', pipeline_id: 'pipeline-1', created_at: '2026-01-01T01:00:00.000Z' }))
    const convoys = store.getConvoysByPipeline('pipeline-1')
    expect(convoys[0].id).toBe('convoy-a')
    expect(convoys[1].id).toBe('convoy-b')
  })

  it('getConvoysByPipeline returns empty array when no convoys are linked', () => {
    store.insertPipeline(makePipeline())
    expect(store.getConvoysByPipeline('pipeline-1')).toHaveLength(0)
  })

  it('getConvoysByPipeline does not return convoys from other pipelines', () => {
    store.insertPipeline(makePipeline({ id: 'pipeline-1' }))
    store.insertPipeline(makePipeline({ id: 'pipeline-2' }))
    store.insertConvoy(makeConvoy({ id: 'convoy-1', pipeline_id: 'pipeline-1' }))
    store.insertConvoy(makeConvoy({ id: 'convoy-2', pipeline_id: 'pipeline-2' }))
    const p1Convoys = store.getConvoysByPipeline('pipeline-1')
    expect(p1Convoys).toHaveLength(1)
    expect(p1Convoys[0].id).toBe('convoy-1')
  })
})

// ── close ─────────────────────────────────────────────────────────────────────

describe('close', () => {
  it('closes without error when DB is open', () => {
    const freshStore = createConvoyStore(join(tmpDir, 'fresh.db'))
    expect(() => freshStore.close()).not.toThrow()
  })
})

// ── v4 schema helper ──────────────────────────────────────────────────────────

function createV4Db(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE convoy (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      spec_hash   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      branch      TEXT,
      created_at  TEXT NOT NULL,
      started_at  TEXT,
      finished_at    TEXT,
      spec_yaml      TEXT NOT NULL,
      total_tokens   INTEGER,
      total_cost_usd TEXT,
      pipeline_id    TEXT
    );
    CREATE TABLE pipeline (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      branch          TEXT,
      spec_yaml       TEXT NOT NULL,
      convoy_specs    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      finished_at     TEXT,
      total_tokens    INTEGER,
      total_cost_usd  TEXT
    );
    CREATE TABLE task (
      id          TEXT PRIMARY KEY,
      convoy_id   TEXT NOT NULL REFERENCES convoy(id),
      phase       INTEGER NOT NULL,
      prompt      TEXT NOT NULL,
      agent       TEXT NOT NULL DEFAULT 'developer',
      adapter     TEXT,
      model       TEXT,
      timeout_ms  INTEGER NOT NULL DEFAULT 1800000,
      status      TEXT NOT NULL DEFAULT 'pending',
      worker_id   TEXT,
      worktree    TEXT,
      output      TEXT,
      exit_code   INTEGER,
      started_at  TEXT,
      finished_at TEXT,
      retries           INTEGER NOT NULL DEFAULT 0,
      max_retries       INTEGER NOT NULL DEFAULT 1,
      files             TEXT,
      depends_on        TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      total_tokens      INTEGER,
      cost_usd          TEXT
    );
    CREATE TABLE worker (
      id             TEXT PRIMARY KEY,
      task_id        TEXT REFERENCES task(id),
      adapter        TEXT NOT NULL,
      pid            INTEGER,
      session_id     TEXT,
      status         TEXT NOT NULL DEFAULT 'spawned',
      worktree       TEXT,
      created_at     TEXT NOT NULL,
      finished_at    TEXT,
      last_heartbeat TEXT
    );
    CREATE TABLE event (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      convoy_id  TEXT REFERENCES convoy(id),
      task_id    TEXT,
      worker_id  TEXT,
      type       TEXT NOT NULL,
      data       TEXT,
      created_at TEXT NOT NULL
    );
  `)
  db.exec('PRAGMA user_version = 4')
  return db
}

// ── schema migration v4 → v5 ──────────────────────────────────────────────────

describe('schema migration v4 → v5', () => {
  it('happy path: migrates from v4 to v5 and sets user_version to 5', () => {
    const v4DbPath = join(tmpDir, 'v4-happy.db')
    const db = createV4Db(v4DbPath)
    migrateSchema(db, v4DbPath, 4, 5)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    expect(row.user_version).toBe(5)
  })

  it('new task columns exist after migration', () => {
    const v4DbPath = join(tmpDir, 'v4-task-cols.db')
    const db = createV4Db(v4DbPath)
    migrateSchema(db, v4DbPath, 4, 5)
    const cols = db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    db.close()
    const names = cols.map(c => c.name)
    expect(names).toContain('gates')
    expect(names).toContain('on_exhausted')
    expect(names).toContain('injected')
    expect(names).toContain('provenance')
    expect(names).toContain('idempotency_key')
  })

  it('circuit_state column exists on convoy after migration', () => {
    const v4DbPath = join(tmpDir, 'v4-convoy-col.db')
    const db = createV4Db(v4DbPath)
    migrateSchema(db, v4DbPath, 4, 5)
    const cols = db.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>
    db.close()
    expect(cols.map(c => c.name)).toContain('circuit_state')
  })

  it('dlq table created with correct columns after migration', () => {
    const v4DbPath = join(tmpDir, 'v4-dlq.db')
    const db = createV4Db(v4DbPath)
    migrateSchema(db, v4DbPath, 4, 5)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    const dlqCols = db.prepare('PRAGMA table_info(dlq)').all() as Array<{ name: string }>
    db.close()
    expect(tables.map(t => t.name)).toContain('dlq')
    const colNames = dlqCols.map(c => c.name)
    expect(colNames).toContain('id')
    expect(colNames).toContain('convoy_id')
    expect(colNames).toContain('task_id')
    expect(colNames).toContain('agent')
    expect(colNames).toContain('failure_type')
    expect(colNames).toContain('error_output')
    expect(colNames).toContain('attempts')
    expect(colNames).toContain('tokens_spent')
    expect(colNames).toContain('resolved')
    expect(colNames).toContain('resolution')
    expect(colNames).toContain('created_at')
    expect(colNames).toContain('resolved_at')
  })

  it('idx_task_idempotency partial unique index created after migration', () => {
    const v4DbPath = join(tmpDir, 'v4-index.db')
    const db = createV4Db(v4DbPath)
    migrateSchema(db, v4DbPath, 4, 5)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_idempotency'")
      .all() as Array<{ name: string }>
    db.close()
    expect(indexes).toHaveLength(1)
    expect(indexes[0].name).toBe('idx_task_idempotency')
  })

  it('existing data intact after migration', () => {
    const v4DbPath = join(tmpDir, 'v4-data.db')
    const db = createV4Db(v4DbPath)
    db.prepare(
      `INSERT INTO convoy (id, name, spec_hash, status, branch, created_at, spec_yaml)
       VALUES ('convoy-test', 'Test', 'hash', 'pending', NULL, '2026-01-01T00:00:00.000Z', 'name: test')`
    ).run()
    db.prepare(
      `INSERT INTO task (id, convoy_id, phase, prompt, agent, timeout_ms, status, retries, max_retries)
       VALUES ('task-test', 'convoy-test', 0, 'Do something', 'developer', 1800000, 'pending', 0, 1)`
    ).run()
    migrateSchema(db, v4DbPath, 4, 5)
    const convoyCount = db.prepare('SELECT COUNT(*) as cnt FROM convoy').get() as { cnt: number }
    const taskCount = db.prepare('SELECT COUNT(*) as cnt FROM task').get() as { cnt: number }
    const convoy = db.prepare('SELECT id FROM convoy WHERE id = :id').get({ id: 'convoy-test' }) as { id: string }
    db.close()
    expect(convoyCount.cnt).toBe(1)
    expect(taskCount.cnt).toBe(1)
    expect(convoy.id).toBe('convoy-test')
  })

  it('backup file created before migration', () => {
    const v4DbPath = join(tmpDir, 'v4-backup.db')
    const db = createV4Db(v4DbPath)
    migrateSchema(db, v4DbPath, 4, 5)
    db.close()
    expect(existsSync(`${v4DbPath}.v4.bak`)).toBe(true)
  })

  it('failure mode: rolls back on error, version stays at 4 and backup exists', () => {
    const v4DbPath = join(tmpDir, 'v4-fail.db')
    const db = createV4Db(v4DbPath)
    // Pre-add gates column so the first ALTER in migration will fail with duplicate column
    db.exec('ALTER TABLE task ADD COLUMN gates TEXT')
    expect(() => migrateSchema(db, v4DbPath, 4, 5)).toThrow()
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(4)
    expect(existsSync(`${v4DbPath}.v4.bak`)).toBe(true)
    db.close()
  })

  it('rolls back and preserves backup on mid-migration failure', () => {
    const v4Path = join(tmpDir, 'v4-fail-rb.db')
    const v4db = createV4Db(v4Path)
    // Insert a test row to verify data integrity after rollback
    v4db
      .prepare(
        "INSERT INTO convoy (id, name, spec_hash, status, created_at, spec_yaml) VALUES ('test-c', 'Test', 'hash', 'pending', '2026-01-01', 'yaml')",
      )
      .run()
    // Sabotage: add a column that migration v4→v5 will try to add, causing it to fail
    v4db.exec('ALTER TABLE task ADD COLUMN gates TEXT')

    // Attempt migration — should fail because 'gates' column already exists
    expect(() => migrateSchema(v4db, v4Path, 4, 5)).toThrow(/Migration v4→v5 failed/)

    // Verify: user_version unchanged (still 4)
    const version = (
      v4db.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version
    expect(version).toBe(4)

    // Verify: backup file exists and is a valid SQLite database
    const backupPath = `${v4Path}.v4.bak`
    expect(existsSync(backupPath)).toBe(true)

    const backupDb = new DatabaseSync(backupPath)
    const backupRow = backupDb
      .prepare("SELECT id FROM convoy WHERE id = 'test-c'")
      .get() as { id: string } | undefined
    expect(backupRow?.id).toBe('test-c')
    backupDb.close()

    // Verify: original data intact in main DB (rollback preserved it)
    const origRow = v4db
      .prepare("SELECT id FROM convoy WHERE id = 'test-c'")
      .get() as { id: string } | undefined
    expect(origRow?.id).toBe('test-c')

    v4db.close()
  })
})

// ── helper: build a v5 database ───────────────────────────────────────────────

function createV5Db(path: string): DatabaseSync {
  // v5 = v4 schema + gates/on_exhausted/injected/provenance/idempotency_key on task
  //       + circuit_state on convoy + dlq table
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE convoy (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      spec_hash       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      branch          TEXT,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      finished_at     TEXT,
      spec_yaml       TEXT NOT NULL,
      total_tokens    INTEGER,
      total_cost_usd  TEXT,
      pipeline_id     TEXT,
      circuit_state   TEXT
    );
    CREATE TABLE pipeline (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      branch          TEXT,
      spec_yaml       TEXT NOT NULL,
      convoy_specs    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      finished_at     TEXT,
      total_tokens    INTEGER,
      total_cost_usd  TEXT
    );
    CREATE TABLE task (
      id                TEXT PRIMARY KEY,
      convoy_id         TEXT NOT NULL REFERENCES convoy(id),
      phase             INTEGER NOT NULL,
      prompt            TEXT NOT NULL,
      agent             TEXT NOT NULL DEFAULT 'developer',
      adapter           TEXT,
      model             TEXT,
      timeout_ms        INTEGER NOT NULL DEFAULT 1800000,
      status            TEXT NOT NULL DEFAULT 'pending',
      worker_id         TEXT,
      worktree          TEXT,
      output            TEXT,
      exit_code         INTEGER,
      started_at        TEXT,
      finished_at       TEXT,
      retries           INTEGER NOT NULL DEFAULT 0,
      max_retries       INTEGER NOT NULL DEFAULT 1,
      files             TEXT,
      depends_on        TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      total_tokens      INTEGER,
      cost_usd          TEXT,
      gates             TEXT,
      on_exhausted      TEXT NOT NULL DEFAULT 'dlq',
      injected          INTEGER NOT NULL DEFAULT 0,
      provenance        TEXT,
      idempotency_key   TEXT
    );
    CREATE UNIQUE INDEX idx_task_idempotency ON task(convoy_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE worker (
      id             TEXT PRIMARY KEY,
      task_id        TEXT REFERENCES task(id),
      adapter        TEXT NOT NULL,
      pid            INTEGER,
      session_id     TEXT,
      status         TEXT NOT NULL DEFAULT 'spawned',
      worktree       TEXT,
      created_at     TEXT NOT NULL,
      finished_at    TEXT,
      last_heartbeat TEXT
    );
    CREATE TABLE event (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      convoy_id  TEXT REFERENCES convoy(id),
      task_id    TEXT,
      worker_id  TEXT,
      type       TEXT NOT NULL,
      data       TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE dlq (
      id                TEXT PRIMARY KEY,
      convoy_id         TEXT NOT NULL REFERENCES convoy(id),
      task_id           TEXT NOT NULL REFERENCES task(id),
      agent             TEXT NOT NULL,
      failure_type      TEXT NOT NULL,
      error_output      TEXT,
      attempts          INTEGER NOT NULL,
      tokens_spent      INTEGER,
      escalation_task_id TEXT,
      resolved          INTEGER NOT NULL DEFAULT 0,
      resolution        TEXT,
      created_at        TEXT NOT NULL,
      resolved_at       TEXT
    );
  `)
  db.exec('PRAGMA user_version = 5')
  return db
}

// ── schema migration v5 → v6 ──────────────────────────────────────────────────

describe('schema migration v5 → v6', () => {
  it('happy path: migrates from v5 to v6 and sets user_version to 6', () => {
    const v5DbPath = join(tmpDir, 'v5-happy.db')
    const db = createV5Db(v5DbPath)
    migrateSchema(db, v5DbPath, 5, 6)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    db.close()
    expect(row.user_version).toBe(6)
  })

  it('task_step table created with correct columns after migration', () => {
    const v5DbPath = join(tmpDir, 'v5-task-step.db')
    const db = createV5Db(v5DbPath)
    migrateSchema(db, v5DbPath, 5, 6)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    const stepCols = db.prepare('PRAGMA table_info(task_step)').all() as Array<{ name: string }>
    db.close()
    expect(tables.map(t => t.name)).toContain('task_step')
    const colNames = stepCols.map(c => c.name)
    expect(colNames).toContain('id')
    expect(colNames).toContain('task_id')
    expect(colNames).toContain('step_index')
    expect(colNames).toContain('prompt')
    expect(colNames).toContain('gates')
    expect(colNames).toContain('status')
    expect(colNames).toContain('exit_code')
    expect(colNames).toContain('output')
    expect(colNames).toContain('started_at')
    expect(colNames).toContain('finished_at')
  })

  it('new task columns added after migration', () => {
    const v5DbPath = join(tmpDir, 'v5-task-cols.db')
    const db = createV5Db(v5DbPath)
    migrateSchema(db, v5DbPath, 5, 6)
    const cols = db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    db.close()
    const names = cols.map(c => c.name)
    expect(names).toContain('current_step')
    expect(names).toContain('total_steps')
    expect(names).toContain('review_level')
    expect(names).toContain('review_verdict')
    expect(names).toContain('review_tokens')
    expect(names).toContain('review_model')
    expect(names).toContain('panel_attempts')
    expect(names).toContain('dispute_id')
  })

  it('new convoy columns added after migration', () => {
    const v5DbPath = join(tmpDir, 'v5-convoy-cols.db')
    const db = createV5Db(v5DbPath)
    migrateSchema(db, v5DbPath, 5, 6)
    const cols = db.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>
    db.close()
    const names = cols.map(c => c.name)
    expect(names).toContain('review_tokens_total')
    expect(names).toContain('review_budget')
  })

  it('existing data survives migration intact', () => {
    const v5DbPath = join(tmpDir, 'v5-data.db')
    const db = createV5Db(v5DbPath)
    db.prepare(
      `INSERT INTO convoy (id, name, spec_hash, status, branch, created_at, spec_yaml)
       VALUES ('convoy-v5', 'Test V5', 'hash5', 'pending', NULL, '2026-01-01T00:00:00.000Z', 'name: test')`,
    ).run()
    db.prepare(
      `INSERT INTO task (id, convoy_id, phase, prompt, agent, timeout_ms, status, retries, max_retries)
       VALUES ('task-v5', 'convoy-v5', 0, 'Do something', 'developer', 1800000, 'pending', 0, 1)`,
    ).run()
    migrateSchema(db, v5DbPath, 5, 6)
    const convoyCount = db.prepare('SELECT COUNT(*) as cnt FROM convoy').get() as { cnt: number }
    const taskCount = db.prepare('SELECT COUNT(*) as cnt FROM task').get() as { cnt: number }
    const convoy = db.prepare('SELECT id FROM convoy WHERE id = :id').get({ id: 'convoy-v5' }) as { id: string }
    const task = db.prepare('SELECT id FROM task WHERE id = :id').get({ id: 'task-v5' }) as { id: string }
    db.close()
    expect(convoyCount.cnt).toBe(1)
    expect(taskCount.cnt).toBe(1)
    expect(convoy.id).toBe('convoy-v5')
    expect(task.id).toBe('task-v5')
  })

  it('backup file created before migration', () => {
    const v5DbPath = join(tmpDir, 'v5-backup.db')
    const db = createV5Db(v5DbPath)
    migrateSchema(db, v5DbPath, 5, 6)
    db.close()
    expect(existsSync(`${v5DbPath}.v5.bak`)).toBe(true)
  })

  it('createConvoyStore on v5 database auto-migrates to v6', () => {
    const v5DbPath = join(tmpDir, 'v5-auto.db')
    const v5Db = createV5Db(v5DbPath)
    v5Db.prepare(
      `INSERT INTO convoy (id, name, spec_hash, status, branch, created_at, spec_yaml)
       VALUES ('convoy-auto', 'Auto', 'hash', 'pending', NULL, '2026-01-01T00:00:00.000Z', 'name: auto')`,
    ).run()
    v5Db.prepare(
      `INSERT INTO task (id, convoy_id, phase, prompt, agent, timeout_ms, status, retries, max_retries)
       VALUES ('task-auto', 'convoy-auto', 0, 'Do it', 'developer', 1800000, 'pending', 0, 1)`,
    ).run()
    v5Db.close()

    const migratedStore = createConvoyStore(v5DbPath)
    const v5Verify = new DatabaseSync(v5DbPath)
    const row = v5Verify.prepare('PRAGMA user_version').get() as { user_version: number }
    const taskStepTable = v5Verify.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_step'",
    ).get() as { name: string } | undefined
    const convoy = migratedStore.getConvoy('convoy-auto')
    const task = migratedStore.getTask('task-auto', 'convoy-auto')
    v5Verify.close()
    migratedStore.close()

    expect(row.user_version).toBe(11)
    expect(taskStepTable?.name).toBe('task_step')
    expect(convoy?.id).toBe('convoy-auto')
    expect(task?.id).toBe('task-auto')
  })

  it('failure mode: rolls back on error and version stays at 5', () => {
    const v5DbPath = join(tmpDir, 'v5-fail.db')
    const db = createV5Db(v5DbPath)
    // Pre-add current_step to trigger duplicate column error
    db.exec('ALTER TABLE task ADD COLUMN current_step INTEGER')
    expect(() => migrateSchema(db, v5DbPath, 5, 6)).toThrow()
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(5)
    expect(existsSync(`${v5DbPath}.v5.bak`)).toBe(true)
    db.close()
  })
})

// ── updateTaskReview ──────────────────────────────────────────────────────────

describe('updateTaskReview', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
  })

  it('persists review_level and review_verdict', () => {
    store.updateTaskReview('task-1', 'convoy-1', {
      review_level: 'fast',
      review_verdict: 'pass',
    })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.review_level).toBe('fast')
    expect(task.review_verdict).toBe('pass')
  })

  it('persists review_tokens and review_model', () => {
    store.updateTaskReview('task-1', 'convoy-1', {
      review_tokens: 123,
      review_model: 'gpt-4',
    })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.review_tokens).toBe(123)
    expect(task.review_model).toBe('gpt-4')
  })

  it('increments panel_attempts correctly', () => {
    store.updateTaskReview('task-1', 'convoy-1', { panel_attempts: 1 })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.panel_attempts).toBe(1)
  })

  it('persists dispute_id', () => {
    store.updateTaskReview('task-1', 'convoy-1', { dispute_id: 'dispute-42' })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.dispute_id).toBe('dispute-42')
  })

  it('is a no-op when updates is empty', () => {
    store.updateTaskReview('task-1', 'convoy-1', {})
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.review_level).toBeNull()
  })

  it('does not throw for non-existent task', () => {
    expect(() => store.updateTaskReview('ghost', 'convoy-1', { review_level: 'fast' })).not.toThrow()
  })
})

// ── updateConvoyReviewTokens ──────────────────────────────────────────────────

describe('updateConvoyReviewTokens', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
  })

  it('sets review_tokens_total on the convoy', () => {
    store.updateConvoyReviewTokens('convoy-1', 500)
    const convoy = store.getConvoy('convoy-1')!
    expect(convoy.review_tokens_total).toBe(500)
  })

  it('overwrites with updated total on subsequent calls', () => {
    store.updateConvoyReviewTokens('convoy-1', 100)
    store.updateConvoyReviewTokens('convoy-1', 350)
    const convoy = store.getConvoy('convoy-1')!
    expect(convoy.review_tokens_total).toBe(350)
  })

  it('review_tokens_total starts as null before any call', () => {
    const convoy = store.getConvoy('convoy-1')!
    expect(convoy.review_tokens_total).toBeNull()
  })
})

// ── schema migration v6→v7 ────────────────────────────────────────────────────

describe('schema migration v6→v7 (drift detection columns)', () => {
  function createV6Db(dbPath: string) {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE convoy (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', branch TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, spec_yaml TEXT NOT NULL,
        total_tokens INTEGER, total_cost_usd TEXT, pipeline_id TEXT,
        circuit_state TEXT, review_tokens_total INTEGER, review_budget INTEGER
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY, convoy_id TEXT NOT NULL, phase INTEGER NOT NULL,
        prompt TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'developer', adapter TEXT,
        model TEXT, timeout_ms INTEGER NOT NULL DEFAULT 1800000,
        status TEXT NOT NULL DEFAULT 'pending', worker_id TEXT, worktree TEXT,
        output TEXT, exit_code INTEGER, started_at TEXT, finished_at TEXT,
        retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 1,
        files TEXT, depends_on TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
        total_tokens INTEGER, cost_usd TEXT, gates TEXT,
        on_exhausted TEXT NOT NULL DEFAULT 'dlq', injected INTEGER NOT NULL DEFAULT 0,
        provenance TEXT, idempotency_key TEXT, current_step INTEGER, total_steps INTEGER,
        review_level TEXT, review_verdict TEXT, review_tokens INTEGER, review_model TEXT,
        panel_attempts INTEGER NOT NULL DEFAULT 0, dispute_id TEXT
      );
      CREATE TABLE worker (
        id TEXT PRIMARY KEY, task_id TEXT, adapter TEXT NOT NULL, pid INTEGER,
        session_id TEXT, status TEXT NOT NULL DEFAULT 'spawned', worktree TEXT,
        created_at TEXT NOT NULL, finished_at TEXT, last_heartbeat TEXT
      );
      CREATE TABLE event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, convoy_id TEXT, task_id TEXT,
        worker_id TEXT, type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE task_step (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, step_index INTEGER NOT NULL,
        prompt TEXT NOT NULL, gates TEXT, status TEXT NOT NULL DEFAULT 'pending',
        exit_code INTEGER, output TEXT, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE dlq (
        id TEXT PRIMARY KEY, convoy_id TEXT NOT NULL, task_id TEXT NOT NULL,
        agent TEXT NOT NULL, failure_type TEXT NOT NULL, error_output TEXT,
        attempts INTEGER NOT NULL, tokens_spent INTEGER, escalation_task_id TEXT,
        resolved INTEGER NOT NULL DEFAULT 0, resolution TEXT, created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE pipeline (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        branch TEXT, spec_yaml TEXT NOT NULL, convoy_specs TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        total_tokens INTEGER, total_cost_usd TEXT
      );
    `)
    db.exec('PRAGMA user_version = 6')
    return db
  }

  it('migration v6→v7 adds drift_score and drift_retried columns to task table', () => {
    const v6DbPath = join(tmpDir, 'v6.db')
    const db = createV6Db(v6DbPath)
    db.close()

    const migratedStore = createConvoyStore(v6DbPath)
    migratedStore.close()

    const verifyDb = new DatabaseSync(v6DbPath)
    const cols = verifyDb.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    const version = verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }
    verifyDb.close()

    expect(cols.map(c => c.name)).toContain('drift_score')
    expect(cols.map(c => c.name)).toContain('drift_retried')
    expect(version.user_version).toBe(11)
  })

  it('new databases include drift_score and drift_retried in CREATE TABLE', () => {
    const cols = new DatabaseSync(dbPath)
      .prepare('PRAGMA table_info(task)')
      .all() as Array<{ name: string; dflt_value: string | null; notnull: number }>
    const driftScore = cols.find(c => c.name === 'drift_score')
    const driftRetried = cols.find(c => c.name === 'drift_retried')
    expect(driftScore).toBeDefined()
    expect(driftRetried).toBeDefined()
  })

  it('failure mode: rolls back on error, version stays at 6 and backup exists', () => {
    const v6DbPath = join(tmpDir, 'v6-fail.db')
    const db = createV6Db(v6DbPath)
    // Pre-add drift_score to cause duplicate column error on migration
    db.exec('ALTER TABLE task ADD COLUMN drift_score REAL')
    expect(() => migrateSchema(db, v6DbPath, 6, 7)).toThrow()
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(6)
    expect(existsSync(`${v6DbPath}.v6.bak`)).toBe(true)
    db.close()
  })
})

// ── updateTaskDrift ───────────────────────────────────────────────────────────

describe('updateTaskDrift', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
  })

  it('sets drift_score on the task', () => {
    store.updateTaskDrift('task-1', 'convoy-1', { drift_score: 0.72 })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.drift_score).toBeCloseTo(0.72)
  })

  it('sets drift_retried on the task', () => {
    store.updateTaskDrift('task-1', 'convoy-1', { drift_retried: 1 })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.drift_retried).toBe(1)
  })

  it('updates both fields at once', () => {
    store.updateTaskDrift('task-1', 'convoy-1', { drift_score: 0.4, drift_retried: 1 })
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.drift_score).toBeCloseTo(0.4)
    expect(task.drift_retried).toBe(1)
  })

  it('no-op when called with empty updates', () => {
    const before = store.getTask('task-1', 'convoy-1')!
    expect(() => store.updateTaskDrift('task-1', 'convoy-1', {})).not.toThrow()
    const after = store.getTask('task-1', 'convoy-1')!
    expect(after.drift_score).toBe(before.drift_score)
  })

  it('drift_score and drift_retried start at NULL/0 for new tasks', () => {
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.drift_score).toBeNull()
    expect(task.drift_retried).toBe(0)
  })
})

// ── updateTaskDisputeStatus ───────────────────────────────────────────────────

describe('updateTaskDisputeStatus', () => {
  beforeEach(() => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
  })

  it('sets task status to disputed', () => {
    store.updateTaskDisputeStatus('task-1', 'convoy-1', 'disputed', 'dispute-task-1-123')
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.status).toBe('disputed')
  })

  it('sets dispute_id on the task', () => {
    store.updateTaskDisputeStatus('task-1', 'convoy-1', 'disputed', 'dispute-task-1-123')
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.dispute_id).toBe('dispute-task-1-123')
  })

  it('is idempotent when called twice with same dispute_id', () => {
    store.updateTaskDisputeStatus('task-1', 'convoy-1', 'disputed', 'dispute-task-1-abc')
    store.updateTaskDisputeStatus('task-1', 'convoy-1', 'disputed', 'dispute-task-1-abc')
    const task = store.getTask('task-1', 'convoy-1')!
    expect(task.status).toBe('disputed')
    expect(task.dispute_id).toBe('dispute-task-1-abc')
  })
})

// ── Artifact CRUD ──────────────────────────────────────────────────────────────

describe('artifact CRUD', () => {
  it('inserts and retrieves an artifact', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    store.insertArtifact({
      id: 'art-1',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      name: 'migration-sql',
      type: 'file',
      content: 'CREATE TABLE foo (id INT);',
      created_at: new Date().toISOString(),
    })
    const art = store.getArtifact('convoy-1', 'migration-sql')
    expect(art).toBeDefined()
    expect(art!.name).toBe('migration-sql')
    expect(art!.content).toBe('CREATE TABLE foo (id INT);')
  })

  it('enforces unique artifact name per convoy', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    store.insertArtifact({
      id: 'art-1',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      name: 'dup-name',
      type: 'file',
      content: 'first',
      created_at: new Date().toISOString(),
    })
    expect(() => store.insertArtifact({
      id: 'art-2',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      name: 'dup-name',
      type: 'file',
      content: 'second',
      created_at: new Date().toISOString(),
    })).toThrow()
  })

  it('enforces max 50 artifacts per convoy', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    for (let i = 0; i < 50; i++) {
      store.insertArtifact({
        id: `art-${i}`,
        convoy_id: 'convoy-1',
        task_id: 'task-1',
        name: `artifact-${i}`,
        type: 'summary',
        content: `content-${i}`,
        created_at: new Date().toISOString(),
      })
    }
    expect(() => store.insertArtifact({
      id: 'art-51',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      name: 'artifact-50',
      type: 'summary',
      content: 'over limit',
      created_at: new Date().toISOString(),
    })).toThrow(/maximum of 50 artifacts/)
  })

  it('retrieves artifacts by task', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    store.insertArtifact({
      id: 'art-1',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      name: 'a',
      type: 'file',
      content: 'file content',
      created_at: new Date().toISOString(),
    })
    const arts = store.getArtifactsByTask('task-1')
    expect(arts).toHaveLength(1)
  })

  it('deletes artifacts older than N days', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    store.insertArtifact({
      id: 'art-old',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      name: 'old-artifact',
      type: 'summary',
      content: 'old',
      created_at: new Date().toISOString(),
    })
    // Mark convoy as done with a finished_at in the past
    store.updateConvoyStatus('convoy-1', 'done', {
      finished_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    })
    const deleted = store.deleteArtifactsOlderThan(30)
    expect(deleted).toBe(1)
  })
})

// ── migration full chain v4→v10 ────────────────────────────────────────────────

describe('migration full chain v4→v10', () => {
  it('migrates a seeded v4 database to v10, preserving data and adding all tables/columns', () => {
    const chainDbPath = join(tmpDir, 'v4-chain.db')
    const v4Db = createV4Db(chainDbPath)
    // Seed realistic v4 data
    v4Db.prepare(
      `INSERT INTO convoy (id, name, spec_hash, status, branch, created_at, spec_yaml)
       VALUES ('convoy-chain', 'Chain Test', 'hash-chain', 'pending', NULL, '2026-01-01T00:00:00.000Z', 'name: chain')`,
    ).run()
    v4Db.prepare(
      `INSERT INTO task (id, convoy_id, phase, prompt, agent, timeout_ms, status, retries, max_retries)
       VALUES ('task-chain', 'convoy-chain', 0, 'Do chain work', 'developer', 1800000, 'pending', 0, 1)`,
    ).run()
    v4Db.prepare(
      `INSERT INTO worker (id, task_id, adapter, status, created_at)
       VALUES ('worker-chain', 'task-chain', 'vscode', 'spawned', '2026-01-01T00:00:00.000Z')`,
    ).run()
    v4Db.prepare(
      `INSERT INTO event (convoy_id, task_id, type, created_at)
       VALUES ('convoy-chain', 'task-chain', 'task_started', '2026-01-01T00:00:00.000Z')`,
    ).run()
    v4Db.close()

    // Trigger the full v4→v10 migration chain
    const migratedStore = createConvoyStore(chainDbPath)
    migratedStore.close()

    const verifyDb = new DatabaseSync(chainDbPath)

    // Verify user_version = 11
    const version = (verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(version).toBe(11)

    // Verify all new tables exist
    const tables = (verifyDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    for (const table of ['task_step', 'dlq', 'artifact', 'agent_identity', 'scratchpad']) {
      expect(tables).toContain(table)
    }

    // Verify all new columns on task
    const taskCols = (verifyDb.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>).map(c => c.name)
    for (const col of [
      'gates', 'on_exhausted', 'injected', 'provenance', 'idempotency_key',
      'current_step', 'total_steps', 'review_level', 'review_verdict', 'review_tokens',
      'review_model', 'panel_attempts', 'dispute_id', 'drift_score', 'drift_retried',
      'outputs', 'inputs', 'discovered_issues', 'compaction_count',
    ]) {
      expect(taskCols).toContain(col)
    }

    // Verify all new columns on convoy
    const convoyCols = (verifyDb.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>).map(c => c.name)
    for (const col of ['circuit_state', 'review_tokens_total', 'review_budget']) {
      expect(convoyCols).toContain(col)
    }

    // Verify seed data is intact
    const convoy = verifyDb.prepare('SELECT id FROM convoy WHERE id = :id').get({ id: 'convoy-chain' }) as { id: string } | undefined
    expect(convoy?.id).toBe('convoy-chain')
    const task = verifyDb.prepare('SELECT id FROM task WHERE id = :id').get({ id: 'task-chain' }) as { id: string } | undefined
    expect(task?.id).toBe('task-chain')
    const worker = verifyDb.prepare('SELECT id FROM worker WHERE id = :id').get({ id: 'worker-chain' }) as { id: string } | undefined
    expect(worker?.id).toBe('worker-chain')
    const eventCount = (verifyDb.prepare('SELECT COUNT(*) AS cnt FROM event WHERE convoy_id = :id').get({ id: 'convoy-chain' }) as { cnt: number }).cnt
    expect(eventCount).toBe(1)

    // Verify FK constraints work: insert a task_step referencing the seeded task_id
    expect(() => {
      verifyDb.prepare(
        `INSERT INTO task_step (task_id, step_index, prompt, gates, status)
         VALUES ('task-chain', 0, 'Step prompt', NULL, 'pending')`,
      ).run()
    }).not.toThrow()

    verifyDb.close()
  })
})

// ── Agent Identity ────────────────────────────────────────────────────────────

describe('agent identity', () => {
  it('inserts an agent identity record without error', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    expect(() => store.insertAgentIdentity({
      id: 'ai-1',
      agent: 'developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'Implemented the feature successfully',
      created_at: new Date().toISOString(),
      retention_days: 90,
    })).not.toThrow()
  })
})

describe('agent identity persistence', () => {
  it('deleteAgentIdentitiesOlderThan removes expired identities', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())

    const oldCreatedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    const recentCreatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()

    store.insertAgentIdentity({
      id: 'ai-old',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'old identity',
      created_at: oldCreatedAt,
      retention_days: 90,
    })
    store.insertAgentIdentity({
      id: 'ai-recent',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'recent identity',
      created_at: recentCreatedAt,
      retention_days: 90,
    })

    const deleted = store.deleteAgentIdentitiesOlderThan(90)
    expect(deleted).toBe(1)

    const identities = store.getAgentIdentities('Developer', 10)
    expect(identities).toHaveLength(1)
    expect(identities[0].id).toBe('ai-recent')
  })

  it('deleteAgentIdentitiesOlderThan respects per-record retention_days', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())

    const createdAt35DaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()

    store.insertAgentIdentity({
      id: 'ai-30d',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'expires early',
      created_at: createdAt35DaysAgo,
      retention_days: 30,
    })
    store.insertAgentIdentity({
      id: 'ai-180d',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'kept longer',
      created_at: createdAt35DaysAgo,
      retention_days: 180,
    })

    const deleted = store.deleteAgentIdentitiesOlderThan(90)
    expect(deleted).toBe(1)

    const identities = store.getAgentIdentities('Developer', 10)
    const ids = identities.map((i) => i.id)
    expect(ids).not.toContain('ai-30d')
    expect(ids).toContain('ai-180d')
  })

  it('stores summaries up to 4096 characters', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())

    const summary = 'x'.repeat(4096)
    store.insertAgentIdentity({
      id: 'ai-4kb',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary,
      created_at: new Date().toISOString(),
      retention_days: 90,
    })

    const identities = store.getAgentIdentities('Developer', 10)
    expect(identities).toHaveLength(1)
    expect(identities[0].summary).toBe(summary)
    expect(identities[0].summary.length).toBe(4096)
  })

  it('listAgentIdentitySummary returns counts per agent', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())

    for (let i = 0; i < 3; i++) {
      store.insertAgentIdentity({
        id: `ai-dev-${i}`,
        agent: 'Developer',
        convoy_id: 'convoy-1',
        task_id: 'task-1',
        summary: `dev-${i}`,
        created_at: new Date(Date.now() + i).toISOString(),
        retention_days: 90,
      })
    }

    for (let i = 0; i < 2; i++) {
      store.insertAgentIdentity({
        id: `ai-rev-${i}`,
        agent: 'Reviewer',
        convoy_id: 'convoy-1',
        task_id: 'task-1',
        summary: `review-${i}`,
        created_at: new Date(Date.now() + 10 + i).toISOString(),
        retention_days: 90,
      })
    }

    const summary = store.listAgentIdentitySummary()
    const byAgent = Object.fromEntries(summary.map((row) => [row.agent, row]))

    expect(byAgent.Developer).toBeDefined()
    expect(byAgent.Developer.task_count).toBe(3)
    expect(byAgent.Reviewer).toBeDefined()
    expect(byAgent.Reviewer.task_count).toBe(2)
  })

  it('purgeAgentIdentities removes all identities for a specific agent', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())

    store.insertAgentIdentity({
      id: 'ai-dev-1',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'dev one',
      created_at: new Date().toISOString(),
      retention_days: 90,
    })
    store.insertAgentIdentity({
      id: 'ai-dev-2',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'dev two',
      created_at: new Date().toISOString(),
      retention_days: 90,
    })
    store.insertAgentIdentity({
      id: 'ai-rev-1',
      agent: 'Reviewer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: 'review one',
      created_at: new Date().toISOString(),
      retention_days: 90,
    })

    const deleted = store.purgeAgentIdentities('Developer')
    expect(deleted).toBe(2)
    expect(store.getAgentIdentities('Developer', 10)).toHaveLength(0)
    expect(store.getAgentIdentities('Reviewer', 10)).toHaveLength(1)
  })

  it('truncates summaries longer than 4096 characters to exactly 4096 chars', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())

    const longSummary = 'a'.repeat(5000)
    store.insertAgentIdentity({
      id: 'ai-trunc',
      agent: 'Developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: longSummary,
      created_at: new Date().toISOString(),
      retention_days: 90,
    })

    const identities = store.getAgentIdentities('Developer', 10)
    const stored = identities.find(i => i.id === 'ai-trunc')
    expect(stored).toBeDefined()
    expect(stored!.summary.length).toBe(4096)
  })
})

// ── Schema v7→v8 migration ──────────────────────────────────────────────────

function createV7Db(dbPath: string): DatabaseSync {
  // v7 = v6 schema + drift_score/drift_retried columns on task (before outputs/inputs/discovered_issues)
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE convoy (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', branch TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, spec_yaml TEXT NOT NULL,
      total_tokens INTEGER, total_cost_usd TEXT, pipeline_id TEXT,
      circuit_state TEXT, review_tokens_total INTEGER, review_budget INTEGER
    );
    CREATE TABLE task (
      id TEXT PRIMARY KEY, convoy_id TEXT NOT NULL REFERENCES convoy(id),
      phase INTEGER NOT NULL, prompt TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'developer', adapter TEXT,
      model TEXT, timeout_ms INTEGER NOT NULL DEFAULT 1800000,
      status TEXT NOT NULL DEFAULT 'pending', worker_id TEXT, worktree TEXT,
      output TEXT, exit_code INTEGER, started_at TEXT, finished_at TEXT,
      retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 1,
      files TEXT, depends_on TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
      total_tokens INTEGER, cost_usd TEXT, gates TEXT,
      on_exhausted TEXT NOT NULL DEFAULT 'dlq', injected INTEGER NOT NULL DEFAULT 0,
      provenance TEXT, idempotency_key TEXT, current_step INTEGER, total_steps INTEGER,
      review_level TEXT, review_verdict TEXT, review_tokens INTEGER, review_model TEXT,
      panel_attempts INTEGER NOT NULL DEFAULT 0, dispute_id TEXT,
      drift_score REAL, drift_retried INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 7;
  `)
  return db
}

describe('v7→v8 migration', () => {
  it('creates artifact and agent_identity tables idempotently', () => {
    const migDir = realpathSync(mkdtempSync(join(tmpdir(), 'mig-test-')))
    const migDb = join(migDir, 'mig.db')

    const db = new DatabaseSync(migDb)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
      CREATE TABLE convoy (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        branch TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        spec_yaml TEXT NOT NULL,
        total_tokens INTEGER,
        total_cost_usd TEXT,
        pipeline_id TEXT,
        circuit_state TEXT,
        review_tokens_total INTEGER,
        review_budget INTEGER
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        convoy_id TEXT NOT NULL REFERENCES convoy(id),
        phase INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'developer',
        adapter TEXT,
        model TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 1800000,
        status TEXT NOT NULL DEFAULT 'pending',
        worker_id TEXT,
        worktree TEXT,
        output TEXT,
        exit_code INTEGER,
        started_at TEXT,
        finished_at TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        files TEXT,
        depends_on TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd TEXT,
        gates TEXT,
        on_exhausted TEXT NOT NULL DEFAULT 'dlq',
        injected INTEGER NOT NULL DEFAULT 0,
        provenance TEXT,
        idempotency_key TEXT,
        current_step INTEGER,
        total_steps INTEGER,
        review_level TEXT,
        review_verdict TEXT,
        review_tokens INTEGER,
        review_model TEXT,
        panel_attempts INTEGER NOT NULL DEFAULT 0,
        dispute_id TEXT,
        drift_score REAL DEFAULT NULL,
        drift_retried INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 7;
    `)

    migrateSchema(db, migDb, 7, 8)

    // Verify artifact table exists
    const artInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact'").get()
    expect(artInfo).toBeDefined()

    // Verify agent_identity table exists
    const aiInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_identity'").get()
    expect(aiInfo).toBeDefined()

    // Verify new task columns exist
    const taskCols = db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
    const colNames = taskCols.map(c => c.name)
    expect(colNames).toContain('outputs')
    expect(colNames).toContain('inputs')
    expect(colNames).toContain('discovered_issues')

    // Verify artifact.id is TEXT PRIMARY KEY (not INTEGER AUTOINCREMENT)
    type ColInfo = { name: string; type: string; pk: number }
    const artCols = db.prepare('PRAGMA table_info(artifact)').all() as ColInfo[]
    const idCol = artCols.find(c => c.name === 'id')
    expect(idCol).toBeDefined()
    expect(idCol!.type.toUpperCase()).toBe('TEXT')
    expect(idCol!.pk).toBe(1)

    // Verify version bumped to 8
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(version).toBe(8)

    db.close()
    rmSync(migDir, { recursive: true, force: true })
  })

  it('failure mode: rolls back on error, version stays at 7 and backup exists', () => {
    const v7DbPath = join(tmpDir, 'v7-fail.db')
    const db = createV7Db(v7DbPath)
    // Pre-add outputs column to cause duplicate column error on migration
    db.exec('ALTER TABLE task ADD COLUMN outputs TEXT')
    expect(() => migrateSchema(db, v7DbPath, 7, 8)).toThrow()
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(7)
    expect(existsSync(`${v7DbPath}.v7.bak`)).toBe(true)
    db.close()
  })
})

describe('v8→v9 migration', () => {
  it('creates scratchpad table', () => {
    const migDir = realpathSync(mkdtempSync(join(tmpdir(), 'mig-v9-test-')))
    const migDb = join(migDir, 'mig.db')

    const db = new DatabaseSync(migDb)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
      CREATE TABLE convoy (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        branch TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        spec_yaml TEXT NOT NULL,
        total_tokens INTEGER,
        total_cost_usd TEXT,
        pipeline_id TEXT,
        circuit_state TEXT,
        review_tokens_total INTEGER,
        review_budget INTEGER
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        convoy_id TEXT NOT NULL REFERENCES convoy(id),
        phase INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'developer',
        adapter TEXT,
        model TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 1800000,
        status TEXT NOT NULL DEFAULT 'pending',
        worker_id TEXT,
        worktree TEXT,
        output TEXT,
        exit_code INTEGER,
        started_at TEXT,
        finished_at TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 1,
        files TEXT,
        depends_on TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd TEXT,
        gates TEXT,
        on_exhausted TEXT NOT NULL DEFAULT 'dlq',
        injected INTEGER NOT NULL DEFAULT 0,
        provenance TEXT,
        idempotency_key TEXT,
        current_step INTEGER,
        total_steps INTEGER,
        review_level TEXT,
        review_verdict TEXT,
        review_tokens INTEGER,
        review_model TEXT,
        panel_attempts INTEGER NOT NULL DEFAULT 0,
        dispute_id TEXT,
        drift_score REAL,
        drift_retried INTEGER NOT NULL DEFAULT 0,
        outputs TEXT,
        inputs TEXT,
        discovered_issues TEXT
      );
      CREATE TABLE worker (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES task(id),
        adapter TEXT NOT NULL,
        pid INTEGER,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'spawned',
        worktree TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        last_heartbeat TEXT
      );
      CREATE TABLE event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        convoy_id TEXT REFERENCES convoy(id),
        task_id TEXT,
        worker_id TEXT,
        type TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE dlq (
        id TEXT PRIMARY KEY,
        convoy_id TEXT NOT NULL REFERENCES convoy(id),
        task_id TEXT NOT NULL REFERENCES task(id),
        agent TEXT NOT NULL,
        failure_type TEXT NOT NULL,
        error_output TEXT,
        attempts INTEGER NOT NULL,
        tokens_spent INTEGER,
        escalation_task_id TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE task_step (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES task(id),
        step_index INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        gates TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        exit_code INTEGER,
        output TEXT,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE artifact (
        id TEXT PRIMARY KEY,
        convoy_id TEXT NOT NULL REFERENCES convoy(id),
        task_id TEXT NOT NULL REFERENCES task(id),
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(convoy_id, name)
      );
      CREATE TABLE agent_identity (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        convoy_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retention_days INTEGER NOT NULL DEFAULT 90
      );
      PRAGMA user_version = 8;
    `)

    migrateSchema(db, migDb, 8, 9)

    const scratchpadInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scratchpad'").get()
    expect(scratchpadInfo).toBeDefined()

    const scratchpadCols = db.prepare('PRAGMA table_info(scratchpad)').all() as Array<{ name: string }>
    const colNames = scratchpadCols.map(c => c.name)
    expect(colNames).toContain('key')
    expect(colNames).toContain('value')
    expect(colNames).toContain('updated_at')

    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(version).toBe(9)

    db.close()
    rmSync(migDir, { recursive: true, force: true })
  })
})

describe('v9→v10 migration', () => {
  it('adds numeric cost columns and backfills data from TEXT columns', () => {
    const migDir = realpathSync(mkdtempSync(join(tmpdir(), 'mig-v10-test-')))
    const migDb = join(migDir, 'mig.db')

    const db = new DatabaseSync(migDb)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
      CREATE TABLE convoy (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', branch TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        spec_yaml TEXT NOT NULL, total_tokens INTEGER, total_cost_usd TEXT,
        pipeline_id TEXT, circuit_state TEXT, review_tokens_total INTEGER, review_budget INTEGER
      );
      CREATE TABLE pipeline (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        branch TEXT, spec_yaml TEXT NOT NULL, convoy_specs TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        total_tokens INTEGER, total_cost_usd TEXT
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY, convoy_id TEXT NOT NULL REFERENCES convoy(id),
        phase INTEGER NOT NULL, prompt TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'developer',
        adapter TEXT, model TEXT, timeout_ms INTEGER NOT NULL DEFAULT 1800000,
        status TEXT NOT NULL DEFAULT 'pending', worker_id TEXT, worktree TEXT, output TEXT,
        exit_code INTEGER, started_at TEXT, finished_at TEXT,
        retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 1,
        files TEXT, depends_on TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
        total_tokens INTEGER, cost_usd TEXT, gates TEXT,
        on_exhausted TEXT NOT NULL DEFAULT 'dlq', injected INTEGER NOT NULL DEFAULT 0,
        provenance TEXT, idempotency_key TEXT, current_step INTEGER, total_steps INTEGER,
        review_level TEXT, review_verdict TEXT, review_tokens INTEGER, review_model TEXT,
        panel_attempts INTEGER NOT NULL DEFAULT 0, dispute_id TEXT,
        drift_score REAL, drift_retried INTEGER NOT NULL DEFAULT 0,
        outputs TEXT, inputs TEXT, discovered_issues TEXT
      );
      CREATE TABLE worker (
        id TEXT PRIMARY KEY, task_id TEXT REFERENCES task(id), adapter TEXT NOT NULL,
        pid INTEGER, session_id TEXT, status TEXT NOT NULL DEFAULT 'spawned',
        worktree TEXT, created_at TEXT NOT NULL, finished_at TEXT, last_heartbeat TEXT
      );
      CREATE TABLE event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, convoy_id TEXT REFERENCES convoy(id),
        task_id TEXT, worker_id TEXT, type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE dlq (
        id TEXT PRIMARY KEY, convoy_id TEXT NOT NULL REFERENCES convoy(id),
        task_id TEXT NOT NULL REFERENCES task(id), agent TEXT NOT NULL,
        failure_type TEXT NOT NULL, error_output TEXT, attempts INTEGER NOT NULL,
        tokens_spent INTEGER, escalation_task_id TEXT, resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE task_step (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES task(id),
        step_index INTEGER NOT NULL, prompt TEXT NOT NULL, gates TEXT,
        status TEXT NOT NULL DEFAULT 'pending', exit_code INTEGER, output TEXT,
        started_at TEXT, finished_at TEXT
      );
      CREATE TABLE artifact (
        id TEXT PRIMARY KEY, convoy_id TEXT NOT NULL REFERENCES convoy(id),
        task_id TEXT NOT NULL REFERENCES task(id), name TEXT NOT NULL, type TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(convoy_id, name)
      );
      CREATE TABLE agent_identity (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, convoy_id TEXT NOT NULL,
        task_id TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL,
        retention_days INTEGER NOT NULL DEFAULT 90
      );
      CREATE TABLE scratchpad (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 9;
    `)

    // Seed data with TEXT cost values (pre-migration state)
    db.prepare(
      `INSERT INTO convoy (id, name, spec_hash, status, created_at, spec_yaml, total_cost_usd)
       VALUES ('c-1', 'Test', 'hash1', 'done', '2026-01-01T00:00:00.000Z', 'name: test', '1.23')`,
    ).run()
    db.prepare(
      `INSERT INTO convoy (id, name, spec_hash, status, created_at, spec_yaml, total_cost_usd)
       VALUES ('c-null', 'NullCost', 'hash2', 'pending', '2026-01-01T00:00:00.000Z', 'name: test', NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO task (id, convoy_id, phase, prompt, agent, timeout_ms, status, retries, max_retries, cost_usd)
       VALUES ('t-1', 'c-1', 0, 'Do it', 'developer', 1800000, 'done', 0, 1, '0.45')`,
    ).run()
    db.prepare(
      `INSERT INTO task (id, convoy_id, phase, prompt, agent, timeout_ms, status, retries, max_retries, cost_usd)
       VALUES ('t-null', 'c-null', 0, 'Do it', 'developer', 1800000, 'pending', 0, 1, NULL)`,
    ).run()
    db.close()

    // Open with createConvoyStore — triggers v9→v10 migration
    const migratedStore = createConvoyStore(migDb)

    // Verify convoy cost is numeric
    const convoy = migratedStore.getConvoy('c-1')!
    expect(convoy.total_cost_usd).toBe(1.23)
    expect((convoy.total_cost_usd as number).toFixed(2)).toBe('1.23')
    expect(convoy.total_cost_usd! > 0).toBe(true)

    // Verify null preservation
    const convoyNull = migratedStore.getConvoy('c-null')!
    expect(convoyNull.total_cost_usd).toBeNull()

    // Verify task cost is numeric
    const task = migratedStore.getTask('t-1', 'c-1')!
    expect(task.cost_usd).toBe(0.45)
    expect((task.cost_usd as number).toFixed(2)).toBe('0.45')
    expect(task.cost_usd! > 0).toBe(true)

    // Verify task null preservation
    const taskNull = migratedStore.getTask('t-null', 'c-null')!
    expect(taskNull.cost_usd).toBeNull()

    migratedStore.close()

    // Verify version = 11
    const verifyDb = new DatabaseSync(migDb)
    const version = (verifyDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(version).toBe(11)

    // Verify new REAL columns exist
    const convoyCols = (verifyDb.prepare('PRAGMA table_info(convoy)').all() as Array<{ name: string }>).map(c => c.name)
    expect(convoyCols).toContain('total_cost_usd_num')
    const taskCols = (verifyDb.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>).map(c => c.name)
    expect(taskCols).toContain('cost_usd_num')
    const pipelineCols = (verifyDb.prepare('PRAGMA table_info(pipeline)').all() as Array<{ name: string }>).map(c => c.name)
    expect(pipelineCols).toContain('total_cost_usd_num')

    verifyDb.close()

    // Verify backup was created
    expect(existsSync(`${migDb}.v9.bak`)).toBe(true)

    rmSync(migDir, { recursive: true, force: true })
  })
})

describe('size limit enforcement', () => {
  it('insertConvoy rejects spec_yaml exceeding 256KB', () => {
    const bigSpecYaml = 'x'.repeat(256 * 1024 + 1)
    expect(() => store.insertConvoy(makeConvoy({ spec_yaml: bigSpecYaml })))
      .toThrow(FieldSizeLimitError)
  })

  it('insertConvoy accepts spec_yaml at exactly 256KB', () => {
    const exactSpecYaml = 'x'.repeat(256 * 1024)
    expect(() => store.insertConvoy(makeConvoy({ id: 'convoy-exact', spec_yaml: exactSpecYaml }))).not.toThrow()
  })

  it('insertEvent rejects data exceeding 64KB', () => {
    store.insertConvoy(makeConvoy())
    const bigData = 'y'.repeat(64 * 1024 + 1)
    expect(() =>
      store.insertEvent({
        convoy_id: 'convoy-1',
        task_id: null,
        worker_id: null,
        type: 'test',
        data: bigData,
        created_at: new Date().toISOString(),
      }),
    ).toThrow(FieldSizeLimitError)
  })

  it('updateTaskStatus truncates output exceeding 1MB', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    const bigOutput = 'z'.repeat(3 * 1024 * 1024)  // 3 MB — well over the 1 MB limit
    store.updateTaskStatus('task-1', 'convoy-1', 'done', { output: bigOutput })
    const task = store.getTask('task-1', 'convoy-1')
    expect(task?.output).toBeDefined()
    expect(task!.output!.length).toBeLessThan(bigOutput.length)
    expect(task!.output).toContain('[truncated:')
  })

  it('insertAgentIdentity truncates summary exceeding 4KB', () => {
    store.insertConvoy(makeConvoy())
    store.insertTask(makeTask())
    const bigSummary = 's'.repeat(4097)
    store.insertAgentIdentity({
      id: 'identity-1',
      agent: 'developer',
      convoy_id: 'convoy-1',
      task_id: 'task-1',
      summary: bigSummary,
      created_at: new Date().toISOString(),
      retention_days: 90,
    })
    const identities = store.getAgentIdentities('developer', 10)
    expect(identities[0].summary.length).toBeLessThanOrEqual(4096)
  })

  it('insertPipeline rejects spec_yaml exceeding 256KB', () => {
    const bigSpecYaml = 'p'.repeat(256 * 1024 + 1)
    expect(() =>
      store.insertPipeline({
        id: 'pipeline-1',
        name: 'Test Pipeline',
        status: 'pending',
        branch: null,
        spec_yaml: bigSpecYaml,
        convoy_specs: '[]',
        created_at: new Date().toISOString(),
      }),
    ).toThrow(FieldSizeLimitError)
  })
})

// ── Dashboard aggregate methods ───────────────────────────────────────────────

describe('Dashboard aggregate methods', () => {
  // Seed helper: inserts 5 convoys, 20 tasks, 3 DLQ entries
  function seedDashboardData() {
    // Convoy 1: done, 30s duration
    store.insertConvoy(makeConvoy({ id: 'dash-c1', name: 'Dash Convoy 1', status: 'pending' as const, created_at: '2026-01-01T10:00:00.000Z' }))
    store.updateConvoyStatus('dash-c1', 'done', { started_at: '2026-01-01T10:00:00.000Z', finished_at: '2026-01-01T10:00:30.000Z', total_tokens: 1000, total_cost_usd: 0.01 })

    // Convoy 2: done, 60s duration
    store.insertConvoy(makeConvoy({ id: 'dash-c2', name: 'Dash Convoy 2', status: 'pending' as const, created_at: '2026-01-02T10:00:00.000Z' }))
    store.updateConvoyStatus('dash-c2', 'done', { started_at: '2026-01-02T10:00:00.000Z', finished_at: '2026-01-02T10:01:00.000Z', total_tokens: 2000, total_cost_usd: 0.02 })

    // Convoy 3: running
    store.insertConvoy(makeConvoy({ id: 'dash-c3', name: 'Dash Convoy 3', status: 'pending' as const, created_at: '2026-01-03T10:00:00.000Z' }))
    store.updateConvoyStatus('dash-c3', 'running', { started_at: '2026-01-03T10:00:00.000Z' })

    // Convoy 4: failed, 20s duration
    store.insertConvoy(makeConvoy({ id: 'dash-c4', name: 'Dash Convoy 4', status: 'pending' as const, created_at: '2026-01-04T10:00:00.000Z' }))
    store.updateConvoyStatus('dash-c4', 'failed', { started_at: '2026-01-04T10:00:00.000Z', finished_at: '2026-01-04T10:00:20.000Z', total_tokens: 500, total_cost_usd: 0.005 })

    // Convoy 5: pending (no timestamps)
    store.insertConvoy(makeConvoy({ id: 'dash-c5', name: 'Dash Convoy 5', status: 'pending' as const, created_at: '2026-01-05T10:00:00.000Z' }))

    // Tasks across convoys (20 total)
    const taskDefs = [
      { id: 'dt-1', convoy_id: 'dash-c1', agent: 'developer', model: 'gpt-4o', status: 'done' as const, retries: 0, total_tokens: 100 },
      { id: 'dt-2', convoy_id: 'dash-c1', agent: 'developer', model: 'gpt-4o', status: 'done' as const, retries: 0, total_tokens: 150 },
      { id: 'dt-3', convoy_id: 'dash-c1', agent: 'reviewer', model: 'gpt-4o-mini', status: 'done' as const, retries: 0, total_tokens: 50 },
      { id: 'dt-4', convoy_id: 'dash-c1', agent: 'reviewer', model: 'gpt-4o-mini', status: 'done' as const, retries: 1, total_tokens: 60 },
      { id: 'dt-5', convoy_id: 'dash-c2', agent: 'developer', model: 'gpt-4o', status: 'done' as const, retries: 0, total_tokens: 200 },
      { id: 'dt-6', convoy_id: 'dash-c2', agent: 'developer', model: 'gpt-4o', status: 'done' as const, retries: 0, total_tokens: 250 },
      { id: 'dt-7', convoy_id: 'dash-c2', agent: 'developer', model: 'gpt-4o', status: 'done' as const, retries: 2, total_tokens: 300 },
      { id: 'dt-8', convoy_id: 'dash-c2', agent: 'qa', model: null, status: 'done' as const, retries: 0, total_tokens: 80 },
      { id: 'dt-9', convoy_id: 'dash-c3', agent: 'developer', model: 'gpt-4o', status: 'running' as const, retries: 0, total_tokens: null },
      { id: 'dt-10', convoy_id: 'dash-c3', agent: 'developer', model: 'gpt-4o', status: 'assigned' as const, retries: 0, total_tokens: null },
      { id: 'dt-11', convoy_id: 'dash-c3', agent: 'reviewer', model: 'gpt-4o-mini', status: 'pending' as const, retries: 0, total_tokens: null },
      { id: 'dt-12', convoy_id: 'dash-c3', agent: 'reviewer', model: 'gpt-4o-mini', status: 'pending' as const, retries: 0, total_tokens: null },
      { id: 'dt-13', convoy_id: 'dash-c4', agent: 'developer', model: 'gpt-4o', status: 'failed' as const, retries: 3, total_tokens: 120 },
      { id: 'dt-14', convoy_id: 'dash-c4', agent: 'developer', model: 'gpt-4o', status: 'gate-failed' as const, retries: 0, total_tokens: 90 },
      { id: 'dt-15', convoy_id: 'dash-c4', agent: 'qa', model: null, status: 'review-blocked' as const, retries: 0, total_tokens: 40 },
      { id: 'dt-16', convoy_id: 'dash-c4', agent: 'qa', model: null, status: 'disputed' as const, retries: 1, total_tokens: 30 },
      { id: 'dt-17', convoy_id: 'dash-c5', agent: 'developer', model: 'gpt-4o', status: 'pending' as const, retries: 0, total_tokens: null },
      { id: 'dt-18', convoy_id: 'dash-c5', agent: 'developer', model: 'gpt-4o', status: 'pending' as const, retries: 0, total_tokens: null },
      { id: 'dt-19', convoy_id: 'dash-c5', agent: 'reviewer', model: 'gpt-4o-mini', status: 'pending' as const, retries: 0, total_tokens: null },
      { id: 'dt-20', convoy_id: 'dash-c5', agent: 'qa', model: null, status: 'pending' as const, retries: 0, total_tokens: null },
    ]

    for (const t of taskDefs) {
      try {
        store.insertTask(makeTask({ id: t.id, convoy_id: t.convoy_id, agent: t.agent, model: t.model, retries: t.retries }))
      } catch {
        // already exists
      }
      if (t.status !== 'pending') {
        store.updateTaskStatus(t.id, t.convoy_id, t.status, t.total_tokens !== null ? { total_tokens: t.total_tokens } : undefined)
      }
    }

    // 3 DLQ entries with different failure_types
    const dlqEntries = [
      { id: 'dlq-1', convoy_id: 'dash-c4', task_id: 'dt-13', agent: 'developer', failure_type: 'timeout' },
      { id: 'dlq-2', convoy_id: 'dash-c4', task_id: 'dt-14', agent: 'developer', failure_type: 'gate_failure' },
      { id: 'dlq-3', convoy_id: 'dash-c4', task_id: 'dt-15', agent: 'qa', failure_type: 'timeout' },
    ]
    for (const d of dlqEntries) {
      store.insertDlqEntry({
        id: d.id,
        convoy_id: d.convoy_id,
        task_id: d.task_id,
        agent: d.agent,
        failure_type: d.failure_type,
        error_output: null,
        attempts: 1,
        tokens_spent: null,
        escalation_task_id: null,
        resolved: 0,
        resolution: null,
        created_at: new Date().toISOString(),
        resolved_at: null,
      })
    }
  }

  describe('getConvoyCounts', () => {
    it('returns all zeros on empty database', () => {
      const result = store.getConvoyCounts()
      expect(result).toEqual({ total: 0, running: 0, done: 0, failed: 0, gate_failed: 0 })
    })

    it('returns correct counts with seeded data', () => {
      seedDashboardData()
      const result = store.getConvoyCounts()
      expect(result.total).toBe(5)
      expect(result.done).toBe(2)
      expect(result.running).toBe(1)
      expect(result.failed).toBe(1)
    })
  })

  describe('getConvoyDurationStats', () => {
    it('returns all null on empty database', () => {
      const result = store.getConvoyDurationStats()
      expect(result).toEqual({ avg_sec: null, p95_sec: null, max_sec: null })
    })

    it('returns reasonable values with seeded data', () => {
      seedDashboardData()
      const result = store.getConvoyDurationStats()
      // 3 convoys have both timestamps: 30s, 60s, 20s — avg = 36.67
      expect(result.avg_sec).not.toBeNull()
      expect(result.avg_sec!).toBeGreaterThan(0)
      expect(result.max_sec).toBeGreaterThanOrEqual(result.avg_sec!)
      expect(result.p95_sec).not.toBeNull()
    })

    it('returns correct avg for single completed convoy', () => {
      store.insertConvoy(makeConvoy({ id: 'single-c', name: 'Single', status: 'pending' as const }))
      store.updateConvoyStatus('single-c', 'done', {
        started_at: '2026-01-01T10:00:00.000Z',
        finished_at: '2026-01-01T10:01:00.000Z',
      })
      const result = store.getConvoyDurationStats()
      expect(result.avg_sec).toBeCloseTo(60, 0)
      expect(result.p95_sec).toBeCloseTo(60, 0)
      expect(result.max_sec).toBeCloseTo(60, 0)
    })
  })

  describe('getTokenAndCostTotals', () => {
    it('returns zeros on empty database', () => {
      const result = store.getTokenAndCostTotals()
      expect(result).toEqual({ total_tokens: 0, total_cost_usd: 0 })
    })

    it('returns correct sums with seeded data', () => {
      seedDashboardData()
      const result = store.getTokenAndCostTotals()
      // convoy totals: 1000+2000+500 = 3500 tokens (c3 and c5 have none)
      expect(result.total_tokens).toBe(3500)
      // cost: 0.01+0.02+0.005 = 0.035
      expect(result.total_cost_usd).toBeCloseTo(0.035, 5)
    })
  })

  describe('getTopAgents', () => {
    it('returns empty array on empty database', () => {
      const result = store.getTopAgents(5)
      expect(result).toEqual([])
    })

    it('returns agents ordered by task_count DESC', () => {
      seedDashboardData()
      const result = store.getTopAgents(10)
      expect(result.length).toBeGreaterThan(0)
      // developer should be top agent (appears most)
      expect(result[0].agent).toBe('developer')
      // verify descending order
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].task_count).toBeGreaterThanOrEqual(result[i].task_count)
      }
    })

    it('respects the limit parameter', () => {
      seedDashboardData()
      const result = store.getTopAgents(1)
      expect(result).toHaveLength(1)
    })

    it('each entry has agent, task_count, total_tokens', () => {
      seedDashboardData()
      const result = store.getTopAgents(5)
      for (const row of result) {
        expect(typeof row.agent).toBe('string')
        expect(typeof row.task_count).toBe('number')
        expect(typeof row.total_tokens).toBe('number')
      }
    })
  })

  describe('getTopModels', () => {
    it('returns empty array on empty database', () => {
      const result = store.getTopModels(5)
      expect(result).toEqual([])
    })

    it('returns models ordered by task_count DESC', () => {
      seedDashboardData()
      const result = store.getTopModels(10)
      expect(result.length).toBeGreaterThan(0)
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].task_count).toBeGreaterThanOrEqual(result[i].task_count)
      }
    })

    it('excludes tasks with null model', () => {
      seedDashboardData()
      const result = store.getTopModels(10)
      for (const row of result) {
        expect(row.model).not.toBeNull()
      }
    })
  })

  describe('getDlqSummary', () => {
    it('returns count=0 and empty array on empty database', () => {
      const result = store.getDlqSummary()
      expect(result).toEqual({ count: 0, top_failure_types: [] })
    })

    it('returns count=3 with seeded data', () => {
      seedDashboardData()
      const result = store.getDlqSummary()
      expect(result.count).toBe(3)
    })

    it('groups failure types correctly', () => {
      seedDashboardData()
      const result = store.getDlqSummary()
      const timeoutEntry = result.top_failure_types.find(t => t.type === 'timeout')
      const gateEntry = result.top_failure_types.find(t => t.type === 'gate_failure')
      expect(timeoutEntry?.count).toBe(2)
      expect(gateEntry?.count).toBe(1)
    })

    it('orders failure types by count DESC', () => {
      seedDashboardData()
      const result = store.getDlqSummary()
      for (let i = 1; i < result.top_failure_types.length; i++) {
        expect(result.top_failure_types[i - 1].count).toBeGreaterThanOrEqual(result.top_failure_types[i].count)
      }
    })
  })

  describe('getConvoyTaskSummary', () => {
    it('returns all zeros for non-existent convoy', () => {
      const result = store.getConvoyTaskSummary('nonexistent')
      expect(result).toEqual({
        total: 0, done: 0, running: 0, failed: 0,
        review_blocked: 0, disputed: 0, reviewed: 0, panel_reviewed: 0,
        tasks_with_drift: 0, max_drift_score: null, drift_retried: 0,
      })
    })

    it('returns correct per-status counts (done convoys)', () => {
      seedDashboardData()
      const result = store.getConvoyTaskSummary('dash-c1')
      // c1 has tasks dt-1..dt-4: all done
      expect(result.total).toBe(4)
      expect(result.done).toBe(4)
      expect(result.running).toBe(0)
      expect(result.failed).toBe(0)
    })

    it('returns correct counts for running convoy with mixed statuses', () => {
      seedDashboardData()
      const result = store.getConvoyTaskSummary('dash-c3')
      // c3: running(1), assigned(1), pending(2)
      expect(result.total).toBe(4)
      expect(result.running).toBe(2) // running + assigned
    })

    it('returns failed and review_blocked and disputed counts', () => {
      seedDashboardData()
      const result = store.getConvoyTaskSummary('dash-c4')
      // c4: failed(1), gate-failed(1), review-blocked(1), disputed(1)
      expect(result.failed).toBe(2) // failed + gate-failed
      expect(result.review_blocked).toBe(1)
      expect(result.disputed).toBe(1)
    })
  })

  describe('getConvoyList', () => {
    it('returns empty array on empty database', () => {
      const result = store.getConvoyList(10, 0)
      expect(result).toEqual([])
    })

    it('returns convoys ordered by created_at DESC', () => {
      seedDashboardData()
      const result = store.getConvoyList(10, 0)
      expect(result.length).toBeGreaterThan(0)
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].created_at >= result[i].created_at).toBe(true)
      }
    })

    it('respects limit', () => {
      seedDashboardData()
      const result = store.getConvoyList(2, 0)
      expect(result).toHaveLength(2)
    })

    it('respects offset for pagination', () => {
      seedDashboardData()
      const first = store.getConvoyList(5, 0)
      const second = store.getConvoyList(5, 2)
      // Items 2+ should appear in second page
      expect(second[0].id).toBe(first[2].id)
    })

    it('returns ConvoyRecord with total_cost_usd_num alias', () => {
      seedDashboardData()
      const result = store.getConvoyList(5, 0)
      // Should not throw and should return records with expected shape
      for (const r of result) {
        expect(typeof r.id).toBe('string')
        expect(typeof r.status).toBe('string')
      }
    })
  })

  describe('getConvoyDetails', () => {
    it('returns null for non-existent convoy', () => {
      const result = store.getConvoyDetails('nonexistent')
      expect(result).toBeNull()
    })

    it('returns full detail object for existing convoy', () => {
      seedDashboardData()
      const result = store.getConvoyDetails('dash-c1')
      expect(result).not.toBeNull()
      expect(result).toHaveProperty('convoy')
      expect(result).toHaveProperty('taskSummary')
      expect(result).toHaveProperty('quality')
      expect(result).toHaveProperty('drift')
      expect(result).toHaveProperty('dlq_count')
      expect(result).toHaveProperty('dlq_entries')
      expect(result).toHaveProperty('artifact_count')
      expect(result).toHaveProperty('artifacts')
      expect(result).toHaveProperty('has_more_events')
      expect(result).toHaveProperty('events')
      expect(result).toHaveProperty('tasks')
    })

    it('convoy sub-object has correct fields', () => {
      seedDashboardData()
      const result = store.getConvoyDetails('dash-c1')!
      expect(result.convoy.id).toBe('dash-c1')
      expect(result.convoy.name).toBe('Dash Convoy 1')
      expect(result.convoy.status).toBe('done')
      expect(result.convoy.total_tokens).toBe(1000)
      expect(typeof result.convoy.total_cost_usd).toBe('number')
    })

    it('tasks list matches getTasksByConvoy', () => {
      seedDashboardData()
      const detail = store.getConvoyDetails('dash-c1')!
      const direct = store.getTasksByConvoy('dash-c1')
      expect(detail.tasks).toHaveLength(direct.length)
      const detailIds = detail.tasks.map(t => t.id).sort()
      const directIds = direct.map(t => t.id).sort()
      expect(detailIds).toEqual(directIds)
    })

    it('taskSummary matches getConvoyTaskSummary', () => {
      seedDashboardData()
      const detail = store.getConvoyDetails('dash-c1')!
      const direct = store.getConvoyTaskSummary('dash-c1')
      expect(detail.taskSummary.total).toBe(direct.total)
      expect(detail.taskSummary.done).toBe(direct.done)
    })

    it('dlq_count and dlq_entries match listDlqEntries for convoy with DLQ', () => {
      seedDashboardData()
      const detail = store.getConvoyDetails('dash-c4')!
      const direct = store.listDlqEntries('dash-c4')
      expect(detail.dlq_count).toBe(direct.length)
      expect(detail.dlq_entries).toHaveLength(direct.length)
      const detailIds = detail.dlq_entries.map(d => d.id).sort()
      const directIds = direct.map(d => d.id).sort()
      expect(detailIds).toEqual(directIds)
    })

    it('has_more_events is false when no events', () => {
      seedDashboardData()
      const result = store.getConvoyDetails('dash-c1')!
      expect(result.has_more_events).toBe(false)
    })
  })
})
