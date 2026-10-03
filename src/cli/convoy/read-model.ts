/**
 * The one read path into a project's convoy history.
 *
 * The status screen and the viewer both describe the same runs, and two readers
 * of the same state eventually contradict each other. Both read through here.
 *
 * Read-only by construction: the database is opened with `readOnly: true`,
 * queried and closed again. Opening it through the store used to run schema
 * migrations, copy `.bak` files and switch the journal mode — writes, from a
 * page that only looks. A viewer started against an older project must not
 * upgrade that project's database behind the engine's back.
 *
 * The schema is read as it is found, not as this file expects it. Columns are
 * selected only when the table has them, so a database from an older release
 * reads with those fields `undefined`, and one from a newer release (a cost
 * flag, cache token counts, an adapter column) reads without this file knowing
 * about every addition first.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KNOWN_EVENT_TYPES } from './types.js'

/** A run in one of these states may still have a process working on it. */
const ACTIVE_STATUSES = new Set(['pending', 'running'])
const FAILED_TASK_STATUSES = ['failed', 'gate-failed', 'timed-out', 'review-blocked', 'hook-failed', 'disputed']
const RUNNING_TASK_STATUSES = new Set(['running', 'assigned'])

/**
 * The engine beats every 10 seconds. A minute of silence is six missed beats:
 * long enough not to flicker, short enough that a killed run stops reading as
 * live within one glance.
 */
const HEARTBEAT_STALE_MS = 60_000

/** How much of a failed task's output is shown as its reason. */
const TAIL_LINES = 20
const TAIL_CHARS = 2000

/**
 * Runtime names the engine has written into `task.model` when the runtime
 * reported no model. They name an adapter, not a model, so they read as unknown.
 */
const RUNTIME_NAMES = new Set(['claude', 'codex', 'copilot', 'cursor', 'opencode'])

export interface RunSummary {
  id: string
  name: string
  status: string
  branch: string | null
  pipeline_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  /** Finished minus started; null until the run has finished. */
  duration_ms: number | null
  tasks_total: number
  tasks_done: number
  tasks_failed: number
  tasks_running: number
  /** The run's recorded total, or the sum of what its tasks have recorded so far. Null when nothing was recorded. */
  tokens: number | null
  cost_usd: number | null
  /** True when any part of the cost is an estimate; undefined when the store does not say. */
  cost_estimated: boolean | undefined
  /** A process is still working on this run (see `isRunAlive`). */
  alive: boolean
}

export interface TaskRow {
  id: string
  phase: number
  agent: string
  status: string
  depends_on: string[]
  adapter: string | null
  /** The model the runtime reported; null when it reported none. */
  model: string | null
  retries: number
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  cache_read_tokens: number | null | undefined
  cache_write_tokens: number | null | undefined
  cost_usd: number | null
  cost_estimated: boolean | undefined
  /** Why the engine says it failed (the `task_failed` reason), when it failed. */
  failure_reason: string | null
  /** The last lines of the failed attempt's output. */
  error_tail: string | null
}

export interface RunDetail extends RunSummary {
  adapters: string[]
  models: string[]
  tasks: TaskRow[]
}

export type EventCategory = 'run' | 'task' | 'check' | 'review' | 'merge' | 'other'

export interface EventRow {
  /** Monotonic per database: pass the last one seen as `sinceId` to read only what is new. */
  id: number
  type: string
  task_id: string | null
  worker_id: string | null
  data: unknown
  created_at: string
  category: EventCategory
  /** A failure or warning worth surfacing on its own. */
  problem: boolean
}

/** A `type: "session"` record appended with `opencastle log`. */
export interface SessionRow {
  timestamp: string | null
  agent: string | null
  task: string | null
  tracker_issue: string | null
  outcome: string | null
  model: string | null
  duration_min: number | null
  files_changed: number | null
  retries: number | null
}

type Row = Record<string, unknown>

// ── Project discovery ─────────────────────────────────────────────────────────

/**
 * The nearest directory at or above `start` holding `.opencastle/`.
 *
 * The same walk `opencastle log` does. The dashboard used to read the current
 * directory only, so started from `proj/src` it showed nothing while `log`,
 * from the same place, was writing to `proj/.opencastle`.
 */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start)
  for (;;) {
    try {
      if (statSync(join(dir, '.opencastle')).isDirectory()) return dir
    } catch {
      // not here; keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function convoyDbPath(projectRoot: string): string {
  return join(projectRoot, '.opencastle', 'convoy.db')
}

// ── Database access ───────────────────────────────────────────────────────────

/** A read-only connection that knows which tables and columns this database has. */
class Reader {
  private readonly cols = new Map<string, Set<string>>()

  constructor(readonly db: DatabaseSync) {}

  columns(table: string): Set<string> {
    let found = this.cols.get(table)
    if (!found) {
      // Table names here are constants from this file, never request input.
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
      found = new Set(rows.map((r) => String(r.name)))
      this.cols.set(table, found)
    }
    return found
  }

  hasTable(table: string): boolean {
    return this.columns(table).size > 0
  }

  /** A SELECT list of the wanted columns this database has. The others read as undefined. */
  select(table: string, wanted: readonly string[]): string {
    const have = this.columns(table)
    const list = wanted.filter((c) => have.has(c))
    return list.length > 0 ? list.join(', ') : 'NULL AS _none'
  }

  all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  get(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }
}

/**
 * Run `fn` against a read-only connection, or return `fallback` when the project
 * has no database yet. Query errors are not swallowed: a page that says "no
 * runs" when the truth is "could not read them" is the kind of quiet wrongness
 * this module exists to stop.
 */
function withDb<T>(projectRoot: string, fallback: T, fn: (r: Reader) => T): T {
  const path = convoyDbPath(projectRoot)
  if (!existsSync(path)) return fallback
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    // A connection setting, not a write: wait out a checkpoint instead of failing.
    db.exec('PRAGMA busy_timeout = 2000')
    return fn(new Reader(db))
  } finally {
    db.close()
  }
}

// ── Value helpers ─────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** A column that may not exist: undefined when absent, null when empty. */
function optNum(row: Row, key: string): number | null | undefined {
  return key in row ? num(row[key]) : undefined
}

function optFlag(row: Row, key: string): boolean | undefined {
  if (!(key in row)) return undefined
  const v = row[key]
  return v === 1 || v === true || v === '1' || v === 'true'
}

function span(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function sumOrNull(values: Array<number | null>): number | null {
  let total: number | null = null
  for (const v of values) if (v !== null) total = (total ?? 0) + v
  return total
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text ?? null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function stringList(text: unknown): string[] {
  const parsed = parseJson(text)
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
}

function tail(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const lines = text.trimEnd().split('\n')
  let out = lines.slice(-TAIL_LINES).join('\n')
  if (out.length > TAIL_CHARS) out = out.slice(-TAIL_CHARS)
  return out.trim() === '' ? null : out
}

function costOf(row: Row): number | null {
  // `*_num` is the REAL copy; older rows have only the TEXT column.
  return num(row.cost_usd_num) ?? num(row.cost_usd)
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

// ── Liveness ──────────────────────────────────────────────────────────────────

interface LockRow {
  pid: number | null
  hostname: string | null
  started_at: string | null
  last_heartbeat: string | null
}

function readLock(r: Reader): LockRow | null {
  if (!r.hasTable('engine_lock')) return null
  const row = r.get(`SELECT ${r.select('engine_lock', ['pid', 'hostname', 'started_at', 'last_heartbeat'])} FROM engine_lock LIMIT 1`)
  if (!row) return null
  return { pid: num(row.pid), hostname: str(row.hostname), started_at: str(row.started_at), last_heartbeat: str(row.last_heartbeat) }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether the lock's holder is still working: a recent heartbeat, and on this host, a live pid. */
function lockHeld(lock: LockRow, now: number): boolean {
  const beat = lock.last_heartbeat ? Date.parse(lock.last_heartbeat) : NaN
  if (!Number.isFinite(beat) || now - beat > HEARTBEAT_STALE_MS) return false
  if (lock.hostname === hostname()) return lock.pid !== null && pidAlive(lock.pid)
  return true
}

/**
 * The lock covers the whole database, not one run, so a held lock only proves
 * that *some* run is alive. A run that a crash left reading "running" must not
 * borrow that liveness: it counts only if it was created, or wrote an event,
 * after the current holder took the lock.
 */
function runAlive(r: Reader, convoy: Row, lock: LockRow | null, now: number): boolean {
  if (!ACTIVE_STATUSES.has(String(convoy.status))) return false
  if (!lock || !lockHeld(lock, now)) return false
  const since = lock.started_at
  if (!since) return true
  if (String(convoy.created_at ?? '') >= since) return true
  if (!r.hasTable('event')) return false
  const last = r.get('SELECT MAX(created_at) AS t FROM event WHERE convoy_id = ?', String(convoy.id))
  return typeof last?.t === 'string' && last.t >= since
}

// ── Runs ──────────────────────────────────────────────────────────────────────

const CONVOY_COLS = [
  'id', 'name', 'status', 'branch', 'pipeline_id', 'created_at', 'started_at', 'finished_at',
  'total_tokens', 'total_cost_usd', 'total_cost_usd_num', 'cost_estimated', 'adapter',
] as const

const TASK_SUMMARY_COLS = ['convoy_id', 'status', 'total_tokens', 'cost_usd', 'cost_usd_num', 'cost_estimated'] as const

function summarize(r: Reader, convoy: Row, tasks: Row[], lock: LockRow | null, now: number): RunSummary {
  const started = str(convoy.started_at)
  const finished = str(convoy.finished_at)
  const costed = tasks.filter((t) => costOf(t) !== null)
  const taskEstimated = costed.some((t) => optFlag(t, 'cost_estimated'))
  const storeSays = r.columns('task').has('cost_estimated') || r.columns('convoy').has('cost_estimated')
  const runEstimated = optFlag(convoy, 'cost_estimated')

  return {
    id: String(convoy.id),
    name: String(convoy.name ?? convoy.id),
    status: String(convoy.status ?? 'unknown'),
    branch: str(convoy.branch),
    pipeline_id: str(convoy.pipeline_id),
    created_at: String(convoy.created_at ?? ''),
    started_at: started,
    finished_at: finished,
    duration_ms: span(started ?? str(convoy.created_at), finished),
    tasks_total: tasks.length,
    tasks_done: tasks.filter((t) => t.status === 'done').length,
    tasks_failed: tasks.filter((t) => FAILED_TASK_STATUSES.includes(String(t.status))).length,
    tasks_running: tasks.filter((t) => RUNNING_TASK_STATUSES.has(String(t.status))).length,
    tokens: num(convoy.total_tokens) ?? sumOrNull(tasks.map((t) => num(t.total_tokens))),
    cost_usd: num(convoy.total_cost_usd_num) ?? num(convoy.total_cost_usd) ?? sumOrNull(costed.map(costOf)),
    cost_estimated: storeSays ? Boolean(runEstimated) || taskEstimated : undefined,
    alive: runAlive(r, convoy, lock, now),
  }
}

/** Runs, newest first. An empty list when the project has never run a convoy. */
export function readRuns(projectRoot: string, limit = 50): RunSummary[] {
  return withDb(projectRoot, [] as RunSummary[], (r) => {
    if (!r.hasTable('convoy')) return []
    const convoys = r.all(
      `SELECT ${r.select('convoy', CONVOY_COLS)} FROM convoy ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      Math.max(1, Math.floor(limit)),
    )
    if (convoys.length === 0) return []
    const ids = convoys.map((c) => String(c.id))
    const tasks = r.hasTable('task')
      ? r.all(`SELECT ${r.select('task', TASK_SUMMARY_COLS)} FROM task WHERE convoy_id IN (${placeholders(ids.length)})`, ...ids)
      : []
    const byConvoy = new Map<string, Row[]>()
    for (const t of tasks) {
      const key = String(t.convoy_id)
      byConvoy.set(key, [...(byConvoy.get(key) ?? []), t])
    }
    const lock = readLock(r)
    const now = Date.now()
    return convoys.map((c) => summarize(r, c, byConvoy.get(String(c.id)) ?? [], lock, now))
  })
}

const TASK_COLS = [
  'id', 'convoy_id', 'phase', 'agent', 'status', 'depends_on', 'adapter', 'model', 'retries', 'worker_id',
  'started_at', 'finished_at', 'prompt_tokens', 'completion_tokens', 'total_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'cost_usd_num', 'cost_estimated',
] as const

function failureReasons(r: Reader, convoyId: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!r.hasTable('event')) return out
  const rows = r.all(
    "SELECT task_id, data FROM event WHERE convoy_id = ? AND type = 'task_failed' ORDER BY id",
    convoyId,
  )
  for (const row of rows) {
    const data = parseJson(row.data)
    if (!row.task_id || typeof data !== 'object' || data === null) continue
    const d = data as Record<string, unknown>
    const reason = str(d.reason)
    if (!reason) continue
    const detail = [str(d.gate) ?? str(d.hook), typeof d.exit_code === 'number' ? `exit ${d.exit_code}` : null].filter(Boolean)
    out.set(String(row.task_id), detail.length ? `${reason} (${detail.join(', ')})` : reason)
  }
  return out
}

function errorTails(r: Reader, convoyId: string): Map<string, string> {
  const out = new Map<string, string>()
  // The DLQ copy first, so the task's own output wins where both exist.
  if (r.columns('dlq').has('error_output')) {
    for (const row of r.all('SELECT task_id, substr(error_output, -4000) AS t FROM dlq WHERE convoy_id = ? ORDER BY rowid', convoyId)) {
      const text = tail(row.t)
      if (text) out.set(String(row.task_id), text)
    }
  }
  if (r.columns('task').has('output')) {
    const rows = r.all(
      `SELECT id, substr(output, -4000) AS t FROM task WHERE convoy_id = ? AND status IN (${placeholders(FAILED_TASK_STATUSES.length)})`,
      convoyId,
      ...FAILED_TASK_STATUSES,
    )
    for (const row of rows) {
      const text = tail(row.t)
      if (text) out.set(String(row.id), text)
    }
  }
  return out
}

function workerAdapters(r: Reader, convoyId: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!r.columns('worker').has('adapter') || !r.columns('task').has('worker_id')) return out
  const rows = r.all('SELECT id, adapter FROM worker WHERE id IN (SELECT worker_id FROM task WHERE convoy_id = ?)', convoyId)
  for (const row of rows) if (str(row.adapter)) out.set(String(row.id), String(row.adapter))
  return out
}

function toTask(t: Row, workers: Map<string, string>, reasons: Map<string, string>, tails: Map<string, string>): TaskRow {
  const id = String(t.id)
  const failed = FAILED_TASK_STATUSES.includes(String(t.status))
  const model = str(t.model)
  const started = str(t.started_at)
  const finished = str(t.finished_at)
  return {
    id,
    phase: num(t.phase) ?? 0,
    agent: String(t.agent ?? ''),
    status: String(t.status ?? 'unknown'),
    depends_on: stringList(t.depends_on),
    adapter: str(t.adapter) ?? (t.worker_id ? workers.get(String(t.worker_id)) ?? null : null),
    model: model && !RUNTIME_NAMES.has(model) ? model : null,
    retries: num(t.retries) ?? 0,
    started_at: started,
    finished_at: finished,
    duration_ms: span(started, finished),
    prompt_tokens: num(t.prompt_tokens),
    completion_tokens: num(t.completion_tokens),
    total_tokens: num(t.total_tokens),
    cache_read_tokens: optNum(t, 'cache_read_tokens'),
    cache_write_tokens: optNum(t, 'cache_write_tokens'),
    cost_usd: costOf(t),
    cost_estimated: optFlag(t, 'cost_estimated'),
    failure_reason: failed ? reasons.get(id) ?? null : null,
    error_tail: failed ? tails.get(id) ?? null : null,
  }
}

/** One run with its tasks, or null when there is no such run. */
export function readRun(projectRoot: string, convoyId: string): RunDetail | null {
  return withDb(projectRoot, null as RunDetail | null, (r) => {
    if (!r.hasTable('convoy')) return null
    const convoy = r.get(`SELECT ${r.select('convoy', CONVOY_COLS)} FROM convoy WHERE id = ?`, convoyId)
    if (!convoy) return null
    const rows = r.hasTable('task')
      ? r.all(`SELECT ${r.select('task', TASK_COLS)} FROM task WHERE convoy_id = ? ORDER BY phase, rowid`, convoyId)
      : []
    const workers = workerAdapters(r, convoyId)
    const reasons = failureReasons(r, convoyId)
    const tails = errorTails(r, convoyId)
    const tasks = rows.map((t) => toTask(t, workers, reasons, tails))
    const summary = summarize(r, convoy, rows, readLock(r), Date.now())

    const adapters = new Set<string>()
    if (str(convoy.adapter)) adapters.add(String(convoy.adapter))
    for (const t of tasks) if (t.adapter) adapters.add(t.adapter)
    for (const a of workers.values()) adapters.add(a)
    const models = new Set(tasks.map((t) => t.model).filter((m): m is string => m !== null))

    return { ...summary, adapters: [...adapters].sort(), models: [...models].sort(), tasks }
  })
}

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * The feed's grouping, from the event type's own prefix.
 *
 * Read from the name rather than kept as a list so a type the engine adds later
 * lands in the right group without this file changing — the old dashboard kept
 * a hand-written list, offered nine filters for types that did not exist, and
 * hid the real ones under "All".
 */
export function eventCategory(type: string): EventCategory {
  if (type.startsWith('merge_')) return 'merge'
  if (/^(review_|dispute_)/.test(type)) return 'review'
  if (/^(built_in_gate|tdd_|drift_|contract_|partition_|file_partition_|secret_|circuit_breaker_)/.test(type)) return 'check'
  if (/^(task_|worker_|dlq_|file_injection_|artifact|agent_identity_)|^(session|delegation)$/.test(type)) return 'task'
  if (/^(convoy_|post_convoy_|swarm_|watch_|ndjson_)/.test(type)) return 'run'
  return 'other'
}

const PROBLEM_TYPE =
  /_failed$|violation|conflict|killed|tripped|blocked|rejected|leak|limit_reached|^dlq_|^drift_detected$|^task_skipped$|^task_retried$|interrupted|fallback/

/** A failure or a warning: by type, or a check whose data says it did not pass. */
export function isProblemEvent(type: string, data: unknown): boolean {
  if (PROBLEM_TYPE.test(type)) return true
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).passed === false
}

/** Every type the engine can emit, grouped as the feed groups them. */
export function eventCategories(): Record<EventCategory, string[]> {
  const out: Record<EventCategory, string[]> = { run: [], task: [], check: [], review: [], merge: [], other: [] }
  for (const type of [...KNOWN_EVENT_TYPES].sort()) out[eventCategory(type)].push(type)
  return out
}

/** Events of one run after `sinceId`, oldest first. */
export function readEventsSince(projectRoot: string, convoyId: string, sinceId: number, limit = 500): EventRow[] {
  const cap = Math.min(2000, Math.max(1, Math.floor(limit)))
  return withDb(projectRoot, [] as EventRow[], (r) => {
    if (!r.hasTable('event')) return []
    const rows = r.all(
      `SELECT ${r.select('event', ['id', 'type', 'task_id', 'worker_id', 'data', 'created_at'])}
       FROM event WHERE convoy_id = ? AND id > ? ORDER BY id LIMIT ?`,
      convoyId,
      Math.max(0, Math.floor(sinceId)),
      cap,
    )
    return rows.map((e) => {
      const type = String(e.type)
      const data = parseJson(e.data)
      return {
        id: num(e.id) ?? 0,
        type,
        task_id: str(e.task_id),
        worker_id: str(e.worker_id),
        data,
        created_at: String(e.created_at ?? ''),
        category: eventCategory(type),
        problem: isProblemEvent(type, data),
      }
    })
  })
}

/**
 * Whether a process is still working on this run.
 *
 * The run must be pending or running, and the engine lock must be held: a
 * heartbeat within the last minute, and — on this host, where it can be
 * checked — a pid that is alive. A dead pid means not alive, whatever the
 * status column says.
 */
export function isRunAlive(projectRoot: string, convoyId: string): boolean {
  return withDb(projectRoot, false, (r) => {
    if (!r.hasTable('convoy')) return false
    const convoy = r.get('SELECT id, status, created_at FROM convoy WHERE id = ?', convoyId)
    return convoy ? runAlive(r, convoy, readLock(r), Date.now()) : false
  })
}

// ── Agent sessions (`opencastle log`) ─────────────────────────────────────────

/** Read at most this much of the end of the log; sessions are shown newest first. */
const SESSION_LOG_TAIL_BYTES = 2 * 1024 * 1024

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    // Starting mid-file means the first line is a fragment.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

/** Session records from `.opencastle/logs/events.ndjson`, newest first. */
export function readSessions(projectRoot: string, limit = 50): SessionRow[] {
  const path = join(projectRoot, '.opencastle', 'logs', 'events.ndjson')
  if (!existsSync(path)) return []
  const out: SessionRow[] = []
  const lines = readTail(path, SESSION_LOG_TAIL_BYTES).split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof rec !== 'object' || rec === null) continue
    const r = rec as Row
    if (r.type !== 'session') continue
    out.push({
      timestamp: str(r.timestamp),
      agent: str(r.agent),
      task: str(r.task),
      tracker_issue: str(r.tracker_issue),
      outcome: str(r.outcome),
      model: str(r.model),
      duration_min: num(r.duration_min),
      files_changed: num(r.files_changed),
      retries: num(r.retries),
    })
  }
  return out
}
