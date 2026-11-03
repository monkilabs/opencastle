import { hostname as getHostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

/** A holder that has not written its heartbeat (every 10 s) for this long is gone. */
const HEARTBEAT_STALE_MS = 30_000

export class EngineAlreadyRunningError extends Error {
  constructor(public readonly pid: number, public readonly hostname: string) {
    super(
      `Another opencastle process (PID ${pid} on ${hostname}) is already running against this database. ` +
        `If it is not, the lock frees itself ${HEARTBEAT_STALE_MS / 1000} s after that process's last heartbeat.`,
    )
    this.name = 'EngineAlreadyRunningError'
  }
}

type LockRow = { pid: number; hostname: string; started_at: string; last_heartbeat: string }

/** False only when the process is certainly gone (ESRCH); EPERM means it exists. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The `started_at` of every lock row this process wrote and still holds. */
const heldHere = new Set<string>()

/**
 * Whether a lock row may be taken over.
 *
 * On this host a dead pid is stale at once. It used to count as live until its
 * heartbeat was 30 s old, so a run killed with Ctrl+C could not be resumed
 * straight away — `resume` said "another opencastle process is already
 * running" about a process that no longer existed.
 *
 * A live pid is not enough to prove the holder is alive, though. Containers
 * restart with the same hostname and small, predictable pids, so the pid may
 * now belong to another process, or to this one. Both were refused for good,
 * until someone deleted the row by hand. A row with this process's own pid
 * that this process did not write is an earlier process's, and stale at once.
 * Any other live pid still needs a recent heartbeat. Another host's pid means
 * nothing here, so there only the heartbeat can tell.
 */
function checkStaleness(row: LockRow): boolean {
  if (row.hostname === getHostname()) {
    if (!pidAlive(row.pid)) return true
    if (row.pid === process.pid && !heldHere.has(row.started_at)) return true
  }
  const heartbeatAge = Date.now() - new Date(row.last_heartbeat).getTime()
  // An unreadable timestamp is no proof of life.
  return !(heartbeatAge <= HEARTBEAT_STALE_MS)
}

export function isLockStale(db: DatabaseSync): boolean {
  const row = db
    .prepare('SELECT pid, hostname, started_at, last_heartbeat FROM engine_lock WHERE id = 1')
    .get() as LockRow | undefined
  if (!row) return true
  return checkStaleness(row)
}

export function acquireEngineLock(
  db: DatabaseSync,
  _dbPath: string,
): {
  release: () => void
  startHeartbeat: () => NodeJS.Timeout
} {
  // BEGIN IMMEDIATE acquires a write lock upfront, preventing concurrent writers
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
      throw new EngineAlreadyRunningError(0, 'unknown')
    }
    throw err
  }

  const existing = db
    .prepare('SELECT pid, hostname, started_at, last_heartbeat FROM engine_lock WHERE id = 1')
    .get() as LockRow | undefined

  if (existing) {
    const stale = checkStaleness(existing)
    if (!stale) {
      db.exec('ROLLBACK')
      throw new EngineAlreadyRunningError(existing.pid, existing.hostname)
    }
  }

  const now = new Date().toISOString()
  db.prepare(
    'INSERT OR REPLACE INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)',
  ).run(process.pid, getHostname(), now, now)
  db.exec('COMMIT')
  heldHere.add(now)

  let heartbeatInterval: NodeJS.Timeout | undefined

  function startHeartbeat(): NodeJS.Timeout {
    heartbeatInterval = setInterval(() => {
      try {
        db.prepare('UPDATE engine_lock SET last_heartbeat = ? WHERE id = 1').run(
          new Date().toISOString(),
        )
      } catch {
        // Ignore errors — DB may have been closed
      }
    }, 10_000)
    return heartbeatInterval
  }

  function release(): void {
    if (heartbeatInterval !== undefined) {
      clearInterval(heartbeatInterval)
      heartbeatInterval = undefined
    }
    heldHere.delete(now)
    try {
      db.exec('DELETE FROM engine_lock WHERE id = 1')
    } catch {
      // Ignore errors — DB may have been closed
    }
  }

  return { release, startHeartbeat }
}
