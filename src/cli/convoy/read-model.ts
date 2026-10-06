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
import { existsSync, statSync } from 'node:fs'
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
  /**
   * The status to show: the recorded one, except that a run recorded as pending
   * or running with no live process is `interrupted`. A crash or a kill leaves
   * the status column saying "running" for ever; nothing is running it.
   */
  display_status: string
}

export interface TaskRow {
  id: string
  phase: number
  agent: string
  status: string
  /** `interrupted` for a task recorded as running or assigned in a run nothing is working on. */
  display_status: string
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
  /**
   * The review's verdict: `pass`, `block`, or `skipped` when a review was due
   * and reached no verdict — which is not a pass. Null when none was recorded;
   * undefined when the store has no review columns.
   */
  review_verdict: ReviewVerdict | null | undefined
  /** `auto-pass`, `fast` or `panel`; auto-pass means no reviewer read it. */
  review_level: string | null | undefined
  /** Why the engine says it failed (the `task_failed` reason), when it failed. */
  failure_reason: string | null
  /** The last lines of the failed attempt's output. */
  error_tail: string | null
}

export type ReviewVerdict = 'pass' | 'block' | 'skipped'

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

/** A session: the `session` event the engine writes for each task a convoy finishes. */
export interface SessionRow {
  source: 'convoy'
  convoy_id: string | null
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
 * The dashboard used to read the current directory only, so started from
 * `proj/src` it showed nothing while a run from the same place was writing to
 * `proj/.opencastle`.
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
  const status = String(convoy.status ?? 'unknown')
  const alive = runAlive(r, convoy, lock, now)

  return {
    id: String(convoy.id),
    name: String(convoy.name ?? convoy.id),
    status,
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
    alive,
    display_status: displayStatus(status, alive),
  }
}

/** A task's status to show: `interrupted` for one recorded as running or assigned in a run nothing is working on. */
export function taskDisplayStatus(status: string, runAlive: boolean): string {
  return RUNNING_TASK_STATUSES.has(status) && !runAlive ? 'interrupted' : status
}

/** The recorded status, or `interrupted` for a run that claims to be active with nothing running it. */
export function displayStatus(status: string, alive: boolean): string {
  return ACTIVE_STATUSES.has(status) && !alive ? 'interrupted' : status
}

/** Summaries of the newest `limit` runs, or of every run when `limit` is null. */
function summaries(r: Reader, limit: number | null): RunSummary[] {
  if (!r.hasTable('convoy')) return []
  const convoys = r.all(
    `SELECT ${r.select('convoy', CONVOY_COLS)} FROM convoy ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    limit === null ? -1 : Math.max(1, Math.floor(limit)),
  )
  if (convoys.length === 0) return []
  const wanted = new Set(convoys.map((c) => String(c.id)))
  // One pass over the task table rather than an IN list, which SQLite caps.
  const tasks = r.hasTable('task') ? r.all(`SELECT ${r.select('task', TASK_SUMMARY_COLS)} FROM task`) : []
  const byConvoy = new Map<string, Row[]>()
  for (const t of tasks) {
    const key = String(t.convoy_id)
    if (!wanted.has(key)) continue
    let list = byConvoy.get(key)
    if (!list) byConvoy.set(key, (list = []))
    list.push(t)
  }
  const lock = readLock(r)
  const now = Date.now()
  return convoys.map((c) => summarize(r, c, byConvoy.get(String(c.id)) ?? [], lock, now))
}

/** Runs, newest first. An empty list when the project has never run a convoy. */
export function readRuns(projectRoot: string, limit = 50): RunSummary[] {
  return withDb(projectRoot, [] as RunSummary[], (r) => summaries(r, limit))
}

const TASK_COLS = [
  'id', 'convoy_id', 'phase', 'agent', 'status', 'depends_on', 'adapter', 'model', 'retries', 'worker_id',
  'started_at', 'finished_at', 'prompt_tokens', 'completion_tokens', 'total_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'cost_usd_num', 'cost_estimated',
  'review_verdict', 'review_level',
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
    // The message says what went wrong; the reason is the engine's code for the kind of failure.
    const message = str(d.message)?.split('\n')[0].trim().slice(0, 300) || null
    const detail = [message ? reason : null, str(d.gate) ?? str(d.hook), typeof d.exit_code === 'number' ? `exit ${d.exit_code}` : null].filter(Boolean)
    const head = message ?? reason
    out.set(String(row.task_id), detail.length ? `${head} (${detail.join(', ')})` : head)
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

function reviewVerdict(row: Row): ReviewVerdict | null | undefined {
  if (!('review_verdict' in row)) return undefined
  const v = str(row.review_verdict)
  return v === 'pass' || v === 'block' || v === 'skipped' ? v : null
}

function toTask(t: Row, workers: Map<string, string>, reasons: Map<string, string>, tails: Map<string, string>, alive: boolean): TaskRow {
  const id = String(t.id)
  const status = String(t.status ?? 'unknown')
  const failed = FAILED_TASK_STATUSES.includes(String(t.status))
  const model = str(t.model)
  const started = str(t.started_at)
  const finished = str(t.finished_at)
  return {
    id,
    phase: num(t.phase) ?? 0,
    agent: String(t.agent ?? ''),
    status,
    display_status: taskDisplayStatus(status, alive),
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
    review_verdict: reviewVerdict(t),
    review_level: 'review_level' in t ? str(t.review_level) : undefined,
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
    const summary = summarize(r, convoy, rows, readLock(r), Date.now())
    const tasks = rows.map((t) => toTask(t, workers, reasons, tails, summary.alive))

    const adapters = new Set<string>()
    if (str(convoy.adapter)) adapters.add(String(convoy.adapter))
    for (const t of tasks) if (t.adapter) adapters.add(t.adapter)
    for (const a of workers.values()) adapters.add(a)
    const models = new Set(tasks.map((t) => t.model).filter((m): m is string => m !== null))

    return { ...summary, adapters: [...adapters].sort(), models: [...models].sort(), tasks }
  })
}

/**
 * The spec a run was started from, and the runtime it recorded, for `resume`
 * and its `--dry-run` preview. Read here so a preview never opens the store,
 * which migrates.
 */
export function readRunSpec(projectRoot: string, convoyId: string): { specYaml: string; adapter: string | null } | null {
  return withDb(projectRoot, null as { specYaml: string; adapter: string | null } | null, (r) => {
    if (!r.hasTable('convoy')) return null
    const row = r.get(`SELECT ${r.select('convoy', ['spec_yaml', 'adapter'])} FROM convoy WHERE id = ?`, convoyId)
    if (!row || typeof row.spec_yaml !== 'string') return null
    return { specYaml: row.spec_yaml, adapter: str(row.adapter) }
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
  if (type.startsWith('merge_') || type === 'task_merged') return 'merge'
  if (/^(review_|dispute_)/.test(type)) return 'review'
  if (/^(gate_|built_in_gate|tdd_|drift_|contract_|partition_|file_partition_|secret_|circuit_breaker_)/.test(type)) return 'check'
  if (/^(task_|worker_|dlq_|file_injection_|artifact|agent_identity_)|^(session|delegation)$/.test(type)) return 'task'
  if (/^(convoy_|post_convoy_|swarm_|watch_|ndjson_)/.test(type)) return 'run'
  return 'other'
}

const PROBLEM_TYPE =
  /_failed$|violation|conflict|killed|tripped|blocked|rejected|leak|limit_reached|^dlq_|^drift_detected$|^task_skipped$|^task_retried$|^review_skipped$|interrupted|fallback/

/**
 * A failure or a warning: by type, a check whose data says it did not pass, or
 * a review that blocked. A review that reached no verdict is `review_skipped`:
 * the work went unreviewed, which is worth seeing, not a pass.
 */
export function isProblemEvent(type: string, data: unknown): boolean {
  if (PROBLEM_TYPE.test(type)) return true
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  if (type === 'review_verdict') return d.verdict === 'block' || d.verdict === 'skipped'
  return d.passed === false
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

// ── Agent sessions ────────────────────────────────────────────────────────────

/**
 * Agent sessions, newest first: the engine's `session` event for each task a
 * convoy finished. Agents outside a convoy no longer log their sessions by
 * hand — it never happened consistently — so this is the only record.
 */
export function readAllSessions(projectRoot: string, limit = 50): SessionRow[] {
  return readEngineSessions(projectRoot, null, limit)
}

/** The engine's `session` events, newest first: of one run, or of every run when `convoyId` is null. */
export function readEngineSessions(projectRoot: string, convoyId: string | null, limit = 50): SessionRow[] {
  return withDb(projectRoot, [] as SessionRow[], (r) => engineSessions(r, convoyId, limit))
}

function engineSessions(r: Reader, convoyId: string | null, limit: number): SessionRow[] {
  if (!r.hasTable('event')) return []
  const rows = r.all(
    `SELECT ${r.select('event', ['convoy_id', 'task_id', 'data', 'created_at'])} FROM event
     WHERE type = 'session'${convoyId === null ? '' : ' AND convoy_id = ?'} ORDER BY id DESC LIMIT ?`,
    ...(convoyId === null ? [] : [convoyId]),
    Math.max(1, Math.floor(limit)),
  )
  return rows.map((e) => {
    const d = asRecord(parseJson(e.data))
    return {
      source: 'convoy' as const,
      convoy_id: str(e.convoy_id) ?? str(d.convoy_id),
      timestamp: str(e.created_at),
      agent: str(d.agent),
      task: str(d.task) ?? str(e.task_id),
      tracker_issue: null,
      outcome: str(d.outcome),
      model: modelOrNull(d.model),
      duration_min: num(d.duration_min),
      files_changed: num(d.files_changed),
      retries: num(d.retries),
    }
  })
}

// ── Aggregates for the dashboard ──────────────────────────────────────────────
//
// Every figure here is counted from rows the engine wrote: the run, task, dlq
// and artifact tables, and the events. Nothing is estimated or filled in. A
// figure the store does not hold reads as null (shown as "not reported"), never
// as 0: a project whose database predates the event table has no reviews on
// record, which is not the same as having had none.

export type Tally = Record<string, number>

export interface ReviewStats {
  /** Reviews that reached a reviewer: `fast` and `panel` verdicts. */
  ran: number
  passed: number
  blocked: number
  /** A review was due and reached no verdict (`review_skipped`). The work went unreviewed. */
  skipped: number
  /** Passed without a reviewer reading it (`level: auto-pass`). Not a review. */
  auto_pass: number
  /** Tokens the reviews that ran spent, as recorded on their verdicts. */
  tokens: number
  by_level: Record<string, { pass: number; block: number }>
  /** The reviewer model each verdict names; `not reported` where it names none. */
  models: Tally
  disputes: number
}

export interface CheckStats {
  ran: number
  passed: number
  failed: number
  /** The spec's own `gates` (`gate_result`) and the built-in gates (`built_in_gate_result`). */
  gates: { passed: number; failed: number }
  built_in: { passed: number; failed: number }
  by_scope: { task: { passed: number; failed: number }; convoy: { passed: number; failed: number } }
  /** Warnings that kept the work: `contract_violation`, `partition_violation`. */
  warnings: number
  /** `secret_leak_prevented` events: a secret found and masked or withheld. */
  secrets_prevented: number
}

export interface ReviewRow {
  event_id: number
  task_id: string | null
  level: string | null
  verdict: string | null
  tokens: number | null
  model: string | null
  /** Panel votes, when the verdict is a panel's. */
  passes: number | null
  blocks: number | null
  feedback_length: number | null
  /** The attempt of the task this review read: the `attempt` of its latest `task_started`. */
  attempt: number | null
  created_at: string
}

export interface SkippedReviewRow {
  event_id: number
  task_id: string | null
  level: string | null
  reason: string | null
  attempt: number | null
  created_at: string
}

export interface CheckRow {
  event_id: number
  /** `gate` for a command in the spec, `built-in` for one of OpenCastle's own gates. */
  kind: 'gate' | 'built-in'
  /** `task` ran in a task's worktree; `convoy` ran once on the merged result. */
  scope: 'task' | 'convoy'
  task_id: string | null
  /** The command, or the built-in gate's name. */
  name: string
  passed: boolean | null
  exit_code: number | null
  level: string | null
  /** The end of the output the event kept, when it kept any. */
  output: string | null
  /** Task scope: the attempt it checked, from the task's latest `task_started`. */
  attempt: number | null
  /**
   * Convoy scope: which time this check ran on the merged result. Round 2 and
   * later follow a gate-fix attempt, the run's `gate_retries`.
   */
  round: number | null
  created_at: string
}

export interface DlqRow {
  id: string
  task_id: string | null
  agent: string | null
  failure_type: string | null
  attempts: number | null
  tokens_spent: number | null
  resolved: boolean
  resolution: string | null
  created_at: string | null
  resolved_at: string | null
  error_tail: string | null
}

export interface ArtifactRow {
  name: string
  /** `file` is a path from the task's `files`; `summary` and `json` hold what the agent answered. */
  type: string
  task_id: string | null
  created_at: string | null
  size_bytes: number | null
}

export interface RunInsights {
  /** Tasks by the tier their `delegation` event recorded (the latest one per task). */
  tiers: Array<{ tier: string; tasks: number }>
  /** Tasks with no `delegation` event: not finished yet, skipped, or from an engine that wrote none. */
  tiers_not_recorded: number
  task_tiers: Record<string, string>
  /** Task attempts by the `mechanism` and `adapter` their `task_started` event recorded. */
  mechanisms: Array<{ mechanism: string; attempts: number }>
  runtimes: Array<{ runtime: string; attempts: number }>
  /** `task_started` events per task: one per attempt, plus any restart after an interrupt. */
  starts: Record<string, number>
  reviews: ReviewRow[]
  reviews_skipped: SkippedReviewRow[]
  review_stats: ReviewStats
  disputes: Array<{ event_id: number; task_id: string | null; dispute_id: string | null; reason: string | null; panel_attempts: number | null; created_at: string }>
  checks: CheckRow[]
  check_stats: CheckStats
  warnings: Array<{ event_id: number; type: string; task_id: string | null; items: string[]; created_at: string }>
  secrets_prevented: Array<{ event_id: number; task_id: string | null; context: string | null; patterns: string[]; created_at: string }>
  /** Files each merged task changed, from `task_merged`. */
  merges: Record<string, number>
  retries: Array<{ event_id: number; task_id: string | null; attempt: number | null; previous_status: string | null; reason: string | null; created_at: string }>
  interruptions: Array<{ event_id: number; type: string; task_id: string | null; signal: string | null; created_at: string }>
  sessions: SessionRow[]
  /** Null when the database has no dlq or artifact table. */
  dlq: DlqRow[] | null
  artifacts: ArtifactRow[] | null
  /** False when the database has no event table: every event-derived figure is unknown, not zero. */
  events_recorded: boolean
}

export interface OverviewTask {
  convoy_id: string
  id: string
  agent: string
  display_status: string
  model: string | null
  retries: number
}

/**
 * One project's share of the overview, in a form several projects' shares can
 * be combined from: lists and counts, never a ratio or a percentile. The live
 * dashboard combines one project's; the website snapshot combines several.
 */
export interface OverviewParts {
  runs: RunSummary[]
  tasks: OverviewTask[]
  tiers: Tally
  mechanisms: Tally
  runtimes: Tally
  reviews: ReviewStats | null
  checks: CheckStats | null
  dlq: { entries: number; unresolved: number } | null
  artifacts: number | null
}

export interface Overview {
  runs: { total: number; alive: number; by_status: Tally; ended: number; done: number; success_rate: number | null }
  /** Over runs that have finished: finished minus started. */
  duration: { measured: number; avg_ms: number | null; p95_ms: number | null; max_ms: number | null }
  tokens: { total: number | null; runs_reported: number; runs_not_reported: number }
  cost: { total_usd: number | null; estimated: boolean | undefined; runs_reported: number; runs_not_reported: number }
  /** Runs per UTC day they were created on, oldest first. */
  activity: Array<{ date: string; total: number; done: number; failed: number; interrupted: number; other: number }>
  tasks: { total: number; retries: number; by_status: Tally }
  agents: Array<{ agent: string; total: number; done: number; failed: number; running: number; other: number }>
  models: Array<{ model: string; tasks: number }>
  models_not_reported: number
  tiers: Array<{ tier: string; tasks: number }>
  tiers_not_recorded: number
  mechanisms: Array<{ mechanism: string; attempts: number }>
  runtimes: Array<{ runtime: string; attempts: number }>
  reviews: ReviewStats | null
  checks: CheckStats | null
  dlq: { entries: number; unresolved: number } | null
  artifacts: number | null
}

const INSIGHT_TYPES = [
  'task_started', 'delegation', 'review_verdict', 'review_skipped', 'dispute_opened',
  'gate_result', 'built_in_gate_result', 'contract_violation', 'partition_violation', 'secret_leak_prevented',
  'task_merged', 'task_retried', 'worker_killed', 'convoy_interrupted', 'convoy_resumed',
] as const

interface EventLite {
  id: number
  convoy_id: string | null
  task_id: string | null
  type: string
  data: Record<string, unknown>
  created_at: string
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function modelOrNull(v: unknown): string | null {
  const m = str(v)
  return m && !RUNTIME_NAMES.has(m) ? m : null
}

function bump(t: Tally, key: string, by = 1): void {
  t[key] = (t[key] ?? 0) + by
}

function addTally(into: Tally, from: Tally): void {
  for (const [k, v] of Object.entries(from)) bump(into, k, v)
}

function sortedTally<K extends string>(t: Tally, key: K, count: string): Array<Record<K, string> & Record<string, number | string>> {
  return Object.entries(t)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ [key]: k, [count]: v }) as Record<K, string> & Record<string, number | string>)
}

function flag(v: unknown): boolean | null {
  if (v === true || v === 1 || v === 'true') return true
  if (v === false || v === 0 || v === 'false') return false
  return null
}

function stringItems(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function insightEvents(r: Reader, convoyId: string | null): EventLite[] {
  if (!r.hasTable('event')) return []
  const rows = r.all(
    `SELECT ${r.select('event', ['id', 'convoy_id', 'task_id', 'type', 'data', 'created_at'])} FROM event
     WHERE type IN (${placeholders(INSIGHT_TYPES.length)})${convoyId === null ? '' : ' AND convoy_id = ?'} ORDER BY id`,
    ...INSIGHT_TYPES,
    ...(convoyId === null ? [] : [convoyId]),
  )
  return rows.map((e) => {
    const data = asRecord(parseJson(e.data))
    return {
      id: num(e.id) ?? 0,
      convoy_id: str(e.convoy_id),
      task_id: str(e.task_id) ?? str(data.task_id),
      type: String(e.type),
      data,
      created_at: String(e.created_at ?? ''),
    }
  })
}

function emptyReviewStats(): ReviewStats {
  return { ran: 0, passed: 0, blocked: 0, skipped: 0, auto_pass: 0, tokens: 0, by_level: {}, models: {}, disputes: 0 }
}

function emptyCheckStats(): CheckStats {
  return {
    ran: 0, passed: 0, failed: 0,
    gates: { passed: 0, failed: 0 }, built_in: { passed: 0, failed: 0 },
    by_scope: { task: { passed: 0, failed: 0 }, convoy: { passed: 0, failed: 0 } },
    warnings: 0, secrets_prevented: 0,
  }
}

/**
 * Reviews, checks and the rest, read from one run's events (or every run's,
 * for the overview) in the order they were written. The attempt a review or a
 * gate belongs to is the `attempt` of the task's latest `task_started` before
 * it; a check on the merged result counts its rounds by how often that check
 * has run in the run so far.
 */
function digest(events: EventLite[]) {
  const reviews: ReviewRow[] = []
  const skipped: SkippedReviewRow[] = []
  const disputes: RunInsights['disputes'] = []
  const checks: CheckRow[] = []
  const warnings: RunInsights['warnings'] = []
  const secrets: RunInsights['secrets_prevented'] = []
  const retries: RunInsights['retries'] = []
  const interruptions: RunInsights['interruptions'] = []
  const merges: Record<string, number> = {}
  const starts: Record<string, number> = {}
  const mechanisms: Tally = {}
  const runtimes: Tally = {}
  const taskTiers: Record<string, string> = {}
  const reviewStats = emptyReviewStats()
  const checkStats = emptyCheckStats()

  const attempt = new Map<string, number>()
  const rounds = new Map<string, number>()
  const key = (e: EventLite): string => `${e.convoy_id ?? ''}\u0000${e.task_id ?? ''}`
  const taskKey = (e: EventLite): string => (e.task_id ?? '')

  for (const e of events) {
    const d = e.data
    switch (e.type) {
      case 'task_started': {
        const n = num(d.attempt)
        if (n !== null) attempt.set(key(e), n)
        if (e.task_id) starts[e.task_id] = (starts[e.task_id] ?? 0) + 1
        bump(mechanisms, str(d.mechanism) ?? 'not recorded')
        bump(runtimes, str(d.adapter) ?? 'not recorded')
        break
      }
      case 'delegation': {
        const tier = str(d.tier)
        // The latest per task: a task that failed and was resumed reports twice.
        if (tier && e.task_id) taskTiers[`${e.convoy_id ?? ''}\u0000${e.task_id}`] = tier
        break
      }
      case 'review_verdict': {
        const level = str(d.level)
        const verdict = str(d.verdict)
        if (level === 'auto-pass') {
          reviewStats.auto_pass++
        } else {
          reviewStats.ran++
          if (verdict === 'pass') reviewStats.passed++
          if (verdict === 'block') reviewStats.blocked++
          if (verdict === 'skipped') reviewStats.skipped++
          const byLevel = (reviewStats.by_level[level ?? 'not recorded'] ??= { pass: 0, block: 0 })
          if (verdict === 'pass') byLevel.pass++
          if (verdict === 'block') byLevel.block++
          reviewStats.tokens += num(d.tokens) ?? 0
          bump(reviewStats.models, str(d.model) ?? 'not reported')
        }
        reviews.push({
          event_id: e.id, task_id: e.task_id, level, verdict,
          tokens: num(d.tokens), model: str(d.model), passes: num(d.passes), blocks: num(d.blocks),
          feedback_length: num(d.feedback_length), attempt: attempt.get(key(e)) ?? null, created_at: e.created_at,
        })
        break
      }
      case 'review_skipped':
        reviewStats.skipped++
        skipped.push({
          event_id: e.id, task_id: e.task_id, level: str(d.level), reason: str(d.reason),
          attempt: attempt.get(key(e)) ?? null, created_at: e.created_at,
        })
        break
      case 'dispute_opened':
        reviewStats.disputes++
        disputes.push({
          event_id: e.id, task_id: e.task_id, dispute_id: str(d.dispute_id), reason: str(d.reason),
          panel_attempts: num(d.panel_attempts), created_at: e.created_at,
        })
        break
      case 'gate_result':
      case 'built_in_gate_result': {
        const builtIn = e.type === 'built_in_gate_result'
        const name = (builtIn ? str(d.gate) : str(d.command)) ?? 'unnamed'
        const scope: 'task' | 'convoy' = builtIn
          ? (e.task_id ? 'task' : 'convoy')
          : str(d.scope) === 'convoy' || (!str(d.scope) && !e.task_id) ? 'convoy' : 'task'
        const passed = flag(d.passed)
        let round: number | null = null
        if (scope === 'convoy') {
          const roundKey = `${e.convoy_id ?? ''}\u0000${builtIn ? 'b' : 'g'}\u0000${name}`
          round = (rounds.get(roundKey) ?? 0) + 1
          rounds.set(roundKey, round)
        }
        checks.push({
          event_id: e.id, kind: builtIn ? 'built-in' : 'gate', scope, task_id: e.task_id, name, passed,
          exit_code: num(d.exit_code), level: str(d.level), output: tail(d.output),
          attempt: scope === 'task' ? attempt.get(key(e)) ?? null : null, round, created_at: e.created_at,
        })
        if (passed !== null) {
          checkStats.ran++
          const outcome = passed ? 'passed' : 'failed'
          checkStats[outcome]++
          checkStats[builtIn ? 'built_in' : 'gates'][outcome]++
          checkStats.by_scope[scope][outcome]++
        }
        break
      }
      case 'contract_violation':
      case 'partition_violation':
        checkStats.warnings++
        warnings.push({
          event_id: e.id, type: e.type, task_id: e.task_id,
          // `__contract_block` is the engine's name for an answer with no output
          // summary block at all; say that, not the key.
          items: e.type === 'partition_violation'
            ? stringItems(d.violations)
            : [...stringItems(d.missing), ...stringItems(d.warnings)].map((m) => (m === '__contract_block' ? 'no output summary block in the answer' : m)),
          created_at: e.created_at,
        })
        break
      case 'secret_leak_prevented':
        checkStats.secrets_prevented++
        secrets.push({ event_id: e.id, task_id: e.task_id, context: str(d.context), patterns: stringItems(d.patterns), created_at: e.created_at })
        break
      case 'task_merged':
        if (e.task_id) merges[taskKey(e)] = num(d.files) ?? 0
        break
      case 'task_retried':
        retries.push({
          event_id: e.id, task_id: e.task_id, attempt: num(d.attempt), previous_status: str(d.previous_status),
          reason: str(d.reason), created_at: e.created_at,
        })
        break
      case 'worker_killed':
      case 'convoy_interrupted':
      case 'convoy_resumed':
        interruptions.push({ event_id: e.id, type: e.type, task_id: e.task_id, signal: str(d.signal) ?? str(d.reason), created_at: e.created_at })
        break
    }
  }
  return {
    reviews, skipped, disputes, checks, warnings, secrets, retries, interruptions, merges, starts,
    mechanisms, runtimes, taskTiers, reviewStats, checkStats,
  }
}

function tierTally(taskTiers: Record<string, string>): Tally {
  const out: Tally = {}
  for (const tier of Object.values(taskTiers)) bump(out, tier)
  return out
}

function dlqRows(r: Reader, convoyId: string | null): DlqRow[] | null {
  if (!r.hasTable('dlq')) return null
  const rows = r.all(
    `SELECT ${r.select('dlq', ['id', 'task_id', 'agent', 'failure_type', 'attempts', 'tokens_spent', 'resolved', 'resolution', 'created_at', 'resolved_at'])}
       ${r.columns('dlq').has('error_output') ? ', substr(error_output, -4000) AS tail_text' : ''}
     FROM dlq${convoyId === null ? '' : ' WHERE convoy_id = ?'} ORDER BY rowid`,
    ...(convoyId === null ? [] : [convoyId]),
  )
  return rows.map((d) => ({
    id: String(d.id ?? ''),
    task_id: str(d.task_id),
    agent: str(d.agent),
    failure_type: str(d.failure_type),
    attempts: num(d.attempts),
    tokens_spent: num(d.tokens_spent),
    resolved: flag(d.resolved) === true,
    resolution: str(d.resolution),
    created_at: str(d.created_at),
    resolved_at: str(d.resolved_at),
    error_tail: tail(d.tail_text),
  }))
}

function artifactRows(r: Reader, convoyId: string): ArtifactRow[] | null {
  if (!r.hasTable('artifact')) return null
  const size = r.columns('artifact').has('content') ? ', length(content) AS size_bytes' : ''
  return r.all(
    `SELECT ${r.select('artifact', ['name', 'type', 'task_id', 'created_at'])}${size} FROM artifact WHERE convoy_id = ? ORDER BY created_at, rowid`,
    convoyId,
  ).map((a) => ({
    name: String(a.name ?? ''),
    type: String(a.type ?? 'unknown'),
    task_id: str(a.task_id),
    created_at: str(a.created_at),
    size_bytes: num(a.size_bytes),
  }))
}

/**
 * What the run's events and side tables say beyond its tasks: tiers,
 * mechanisms, every review and check with the attempt it belonged to, retries,
 * interrupts, the dead-letter queue, artifacts and the engine's sessions.
 * Null when there is no such run.
 */
export function readRunInsights(projectRoot: string, convoyId: string): RunInsights | null {
  return withDb(projectRoot, null as RunInsights | null, (r) => {
    if (!r.hasTable('convoy') || !r.get('SELECT id FROM convoy WHERE id = ?', convoyId)) return null
    const events = r.hasTable('event')
    const g = digest(insightEvents(r, convoyId))
    const taskIds = r.hasTable('task')
      ? r.all('SELECT id FROM task WHERE convoy_id = ?', convoyId).map((t) => String(t.id))
      : []
    const tiers: Record<string, string> = {}
    for (const [k, tier] of Object.entries(g.taskTiers)) tiers[k.split('\u0000')[1]] = tier
    return {
      tiers: sortedTally(tierTally(g.taskTiers), 'tier', 'tasks') as RunInsights['tiers'],
      tiers_not_recorded: taskIds.filter((id) => !(id in tiers)).length,
      task_tiers: tiers,
      mechanisms: sortedTally(g.mechanisms, 'mechanism', 'attempts') as RunInsights['mechanisms'],
      runtimes: sortedTally(g.runtimes, 'runtime', 'attempts') as RunInsights['runtimes'],
      starts: g.starts,
      reviews: g.reviews,
      reviews_skipped: g.skipped,
      review_stats: g.reviewStats,
      disputes: g.disputes,
      checks: g.checks,
      check_stats: g.checkStats,
      warnings: g.warnings,
      secrets_prevented: g.secrets,
      merges: g.merges,
      retries: g.retries,
      interruptions: g.interruptions,
      sessions: engineSessions(r, convoyId, 500),
      dlq: dlqRows(r, convoyId),
      artifacts: artifactRows(r, convoyId),
      events_recorded: events,
    }
  })
}

/** One project's share of the overview. See `OverviewParts`. */
export function readOverviewParts(projectRoot: string): OverviewParts {
  const empty: OverviewParts = {
    runs: [], tasks: [], tiers: {}, mechanisms: {}, runtimes: {}, reviews: null, checks: null, dlq: null, artifacts: null,
  }
  return withDb(projectRoot, empty, (r) => {
    const runs = summaries(r, null)
    const alive = new Map(runs.map((run) => [run.id, run.alive]))
    const tasks: OverviewTask[] = r.hasTable('task')
      ? r.all(`SELECT ${r.select('task', ['id', 'convoy_id', 'agent', 'status', 'model', 'retries'])} FROM task`).map((t) => ({
          convoy_id: String(t.convoy_id ?? ''),
          id: String(t.id ?? ''),
          agent: str(t.agent) ?? 'not recorded',
          display_status: taskDisplayStatus(String(t.status ?? 'unknown'), alive.get(String(t.convoy_id)) ?? false),
          model: modelOrNull(t.model),
          retries: num(t.retries) ?? 0,
        }))
      : []
    const events = r.hasTable('event')
    const g = digest(insightEvents(r, null))
    const dlq = dlqRows(r, null)
    let artifacts: number | null = null
    if (r.hasTable('artifact')) artifacts = num(r.get('SELECT COUNT(*) AS n FROM artifact')?.n) ?? 0
    return {
      runs,
      tasks,
      tiers: tierTally(g.taskTiers),
      mechanisms: g.mechanisms,
      runtimes: g.runtimes,
      reviews: events ? g.reviewStats : null,
      checks: events ? g.checkStats : null,
      dlq: dlq === null ? null : { entries: dlq.length, unresolved: dlq.filter((d) => !d.resolved).length },
      artifacts,
    }
  })
}

const ENDED = new Set(['done', 'failed', 'gate-failed', 'hook-failed', 'interrupted'])
const FAILED_RUN = new Set(['failed', 'gate-failed', 'hook-failed'])

function mergeReviews(a: ReviewStats | null, b: ReviewStats | null): ReviewStats | null {
  if (!a) return b && { ...b, by_level: structuredClone(b.by_level), models: { ...b.models } }
  if (!b) return a
  const out: ReviewStats = { ...a, by_level: structuredClone(a.by_level), models: { ...a.models } }
  for (const k of ['ran', 'passed', 'blocked', 'skipped', 'auto_pass', 'tokens', 'disputes'] as const) out[k] += b[k]
  for (const [level, v] of Object.entries(b.by_level)) {
    const into = (out.by_level[level] ??= { pass: 0, block: 0 })
    into.pass += v.pass
    into.block += v.block
  }
  addTally(out.models, b.models)
  return out
}

function mergeChecks(a: CheckStats | null, b: CheckStats | null): CheckStats | null {
  if (!a) return b && structuredClone(b)
  if (!b) return a
  const out = structuredClone(a)
  out.ran += b.ran
  out.passed += b.passed
  out.failed += b.failed
  out.warnings += b.warnings
  out.secrets_prevented += b.secrets_prevented
  for (const group of ['gates', 'built_in'] as const) {
    out[group].passed += b[group].passed
    out[group].failed += b[group].failed
  }
  for (const scope of ['task', 'convoy'] as const) {
    out.by_scope[scope].passed += b.by_scope[scope].passed
    out.by_scope[scope].failed += b.by_scope[scope].failed
  }
  return out
}

/** The nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

/** The overview of one or more projects' shares. */
export function overviewFrom(parts: OverviewParts[]): Overview {
  const runs = parts.flatMap((p) => p.runs)
  const tasks = parts.flatMap((p) => p.tasks)

  const byStatus: Tally = {}
  for (const run of runs) bump(byStatus, run.display_status)
  const ended = runs.filter((run) => ENDED.has(run.display_status))
  const done = ended.filter((run) => run.display_status === 'done').length

  const durations = runs
    .filter((run) => run.finished_at !== null && run.duration_ms !== null)
    .map((run) => run.duration_ms as number)
    .sort((a, b) => a - b)

  const tokenRuns = runs.filter((run) => run.tokens !== null)
  const costRuns = runs.filter((run) => run.cost_usd !== null)
  const flagKnown = costRuns.some((run) => run.cost_estimated !== undefined)

  const days = new Map<string, Overview['activity'][number]>()
  for (const run of runs) {
    const date = run.created_at.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    let day = days.get(date)
    if (!day) days.set(date, (day = { date, total: 0, done: 0, failed: 0, interrupted: 0, other: 0 }))
    day.total++
    if (run.display_status === 'done') day.done++
    else if (FAILED_RUN.has(run.display_status)) day.failed++
    else if (run.display_status === 'interrupted') day.interrupted++
    else day.other++
  }

  const taskStatus: Tally = {}
  const agents = new Map<string, Overview['agents'][number]>()
  const models: Tally = {}
  let modelsNotReported = 0
  for (const t of tasks) {
    bump(taskStatus, t.display_status)
    let a = agents.get(t.agent)
    if (!a) agents.set(t.agent, (a = { agent: t.agent, total: 0, done: 0, failed: 0, running: 0, other: 0 }))
    a.total++
    if (t.display_status === 'done') a.done++
    else if (FAILED_TASK_STATUSES.includes(t.display_status)) a.failed++
    else if (RUNNING_TASK_STATUSES.has(t.display_status)) a.running++
    else a.other++
    if (t.model) bump(models, t.model)
    else modelsNotReported++
  }

  const tiers: Tally = {}
  const mechanisms: Tally = {}
  const runtimes: Tally = {}
  for (const p of parts) {
    addTally(tiers, p.tiers)
    addTally(mechanisms, p.mechanisms)
    addTally(runtimes, p.runtimes)
  }
  const tiered = Object.values(tiers).reduce((s, n) => s + n, 0)

  let dlq = null as Overview['dlq']
  let artifacts = null as number | null
  let reviews = null as ReviewStats | null
  let checks = null as CheckStats | null
  for (const p of parts) {
    if (p.dlq) dlq = { entries: (dlq?.entries ?? 0) + p.dlq.entries, unresolved: (dlq?.unresolved ?? 0) + p.dlq.unresolved }
    if (p.artifacts !== null) artifacts = (artifacts ?? 0) + p.artifacts
    reviews = mergeReviews(reviews, p.reviews)
    checks = mergeChecks(checks, p.checks)
  }

  return {
    runs: {
      total: runs.length,
      alive: runs.filter((run) => run.alive).length,
      by_status: byStatus,
      ended: ended.length,
      done,
      success_rate: ended.length > 0 ? done / ended.length : null,
    },
    duration: {
      measured: durations.length,
      avg_ms: durations.length > 0 ? durations.reduce((s, n) => s + n, 0) / durations.length : null,
      p95_ms: percentile(durations, 0.95),
      max_ms: durations.length > 0 ? durations[durations.length - 1] : null,
    },
    tokens: {
      total: tokenRuns.length > 0 ? tokenRuns.reduce((s, run) => s + (run.tokens as number), 0) : null,
      runs_reported: tokenRuns.length,
      runs_not_reported: runs.length - tokenRuns.length,
    },
    cost: {
      total_usd: costRuns.length > 0 ? costRuns.reduce((s, run) => s + (run.cost_usd as number), 0) : null,
      estimated: flagKnown ? costRuns.some((run) => run.cost_estimated === true) : undefined,
      runs_reported: costRuns.length,
      runs_not_reported: runs.length - costRuns.length,
    },
    activity: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    tasks: { total: tasks.length, retries: tasks.reduce((s, t) => s + t.retries, 0), by_status: taskStatus },
    agents: [...agents.values()].sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
    models: sortedTally(models, 'model', 'tasks') as Overview['models'],
    models_not_reported: modelsNotReported,
    tiers: sortedTally(tiers, 'tier', 'tasks') as Overview['tiers'],
    tiers_not_recorded: Math.max(0, tasks.length - tiered),
    mechanisms: sortedTally(mechanisms, 'mechanism', 'attempts') as Overview['mechanisms'],
    runtimes: sortedTally(runtimes, 'runtime', 'attempts') as Overview['runtimes'],
    reviews,
    checks,
    dlq,
    artifacts,
  }
}

/** The overview of one project. */
export function readOverview(projectRoot: string): Overview {
  return overviewFrom([readOverviewParts(projectRoot)])
}
