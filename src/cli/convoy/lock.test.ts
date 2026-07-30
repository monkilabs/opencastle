import { mkdtempSync, rmSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  acquireEngineLock,
  EngineAlreadyRunningError,
  isLockStale,
} from './lock.js'

const LOCK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS engine_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL
  )
`

let tmpDir: string
let dbPath: string
let db: DatabaseSync

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'lock-test-')))
  dbPath = join(tmpDir, 'test.db')
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(LOCK_TABLE_SQL)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('engine lock', () => {
  it('takes over a stale lock when heartbeat is expired and PID is dead', () => {
    const staleTime = new Date(Date.now() - 60_000).toISOString()
    const deadPid = 999999

    // Verify the PID is actually dead on this machine
    expect(() => process.kill(deadPid, 0)).toThrow()

    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(deadPid, hostname(), staleTime, staleTime)

    const lock = acquireEngineLock(db, dbPath)
    const row = db
      .prepare('SELECT pid FROM engine_lock WHERE id = 1')
      .get() as { pid: number }
    expect(row.pid).toBe(process.pid)
    lock.release()
  })

  it('throws EngineAlreadyRunningError when lock is held by a live process', () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(process.pid, hostname(), now, now)

    expect(() => acquireEngineLock(db, dbPath)).toThrow(EngineAlreadyRunningError)
  })

  it('takes over when hostname differs (treated as stale regardless of PID)', () => {
    const staleTime = new Date(Date.now() - 60_000).toISOString()
    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(process.pid, 'other-host.example.com', staleTime, staleTime)

    const lock = acquireEngineLock(db, dbPath)
    const row = db
      .prepare('SELECT hostname FROM engine_lock WHERE id = 1')
      .get() as { hostname: string }
    expect(row.hostname).toBe(hostname())
    lock.release()
  })

  it('release deletes the lock row', () => {
    const lock = acquireEngineLock(db, dbPath)
    lock.release()
    const row = db.prepare('SELECT * FROM engine_lock WHERE id = 1').get()
    expect(row).toBeUndefined()
  })

  it('startHeartbeat updates last_heartbeat after 10 seconds', () => {
    vi.useFakeTimers()
    try {
      const lock = acquireEngineLock(db, dbPath)
      const before = (
        db
          .prepare('SELECT last_heartbeat FROM engine_lock WHERE id = 1')
          .get() as { last_heartbeat: string }
      ).last_heartbeat

      lock.startHeartbeat()
      vi.advanceTimersByTime(10_000)

      const after = (
        db
          .prepare('SELECT last_heartbeat FROM engine_lock WHERE id = 1')
          .get() as { last_heartbeat: string }
      ).last_heartbeat

      expect(after).not.toBe(before)
      lock.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws EngineAlreadyRunningError when SQLITE_BUSY from a concurrent write lock', () => {
    // Hold a BEGIN IMMEDIATE transaction on a second connection so the first
    // connection's BEGIN IMMEDIATE will return SQLITE_BUSY.
    const db2 = new DatabaseSync(dbPath)
    db2.exec('PRAGMA journal_mode = WAL')
    db2.exec(LOCK_TABLE_SQL)
    db2.exec('BEGIN IMMEDIATE')

    try {
      expect(() => acquireEngineLock(db, dbPath)).toThrow(EngineAlreadyRunningError)
    } finally {
      db2.exec('ROLLBACK')
      db2.close()
    }
  })

  it('takes over lock from different hostname when heartbeat expired', () => {
    const staleTime = new Date(Date.now() - 60_000).toISOString()
    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(process.pid, 'ci-runner-42.example.com', staleTime, staleTime)

    const lock = acquireEngineLock(db, dbPath)
    const row = db
      .prepare('SELECT hostname, pid FROM engine_lock WHERE id = 1')
      .get() as { hostname: string; pid: number }
    expect(row.hostname).toBe(hostname())
    expect(row.pid).toBe(process.pid)
    lock.release()
  })

  it('does NOT take over lock from different hostname when heartbeat is fresh', () => {
    const freshTime = new Date().toISOString()
    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(12345, 'other-host.example.com', freshTime, freshTime)

    expect(() => acquireEngineLock(db, dbPath)).toThrow(EngineAlreadyRunningError)
  })

  it('isLockStale returns true when no lock exists', () => {
    expect(isLockStale(db)).toBe(true)
  })

  it('isLockStale returns false for fresh lock on same host', () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(process.pid, hostname(), now, now)
    expect(isLockStale(db)).toBe(false)
  })

  it('isLockStale returns true for expired lock with dead PID on same host', () => {
    const staleTime = new Date(Date.now() - 60_000).toISOString()
    const deadPid = 999999
    db.prepare(
      'INSERT INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
    ).run(deadPid, hostname(), staleTime, staleTime)
    expect(isLockStale(db)).toBe(true)
  })
})
