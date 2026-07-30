import { hostname as getHostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

export class EngineAlreadyRunningError extends Error {
  constructor(public readonly pid: number, public readonly hostname: string) {
    super(
      `Another opencastle process (PID ${pid} on ${hostname}) is already running against this database.`,
    )
    this.name = 'EngineAlreadyRunningError'
  }
}

type LockRow = { pid: number; hostname: string; last_heartbeat: string }

function checkStaleness(row: LockRow): boolean {
  const heartbeatAge = Date.now() - new Date(row.last_heartbeat).getTime()
  if (heartbeatAge <= 30_000) return false
  if (row.hostname !== getHostname()) return true
  try {
    process.kill(row.pid, 0)
    return false // PID is alive on this host
  } catch {
    return true // PID is dead
  }
}

export function isLockStale(db: DatabaseSync): boolean {
  const row = db
    .prepare('SELECT pid, hostname, last_heartbeat FROM engine_lock WHERE id = 1')
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
    .prepare('SELECT pid, hostname, last_heartbeat FROM engine_lock WHERE id = 1')
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
    try {
      db.exec('DELETE FROM engine_lock WHERE id = 1')
    } catch {
      // Ignore errors — DB may have been closed
    }
  }

  return { release, startHeartbeat }
}
