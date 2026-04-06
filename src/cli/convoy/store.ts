import { copyFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { DashboardConvoyDetail } from './dashboard-types.js'
import type {
  ConvoyRecord,
  ConvoyStatus,
  TaskRecord,
  ConvoyTaskStatus,
  WorkerRecord,
  WorkerStatus,
  EventRecord,
  PipelineRecord,
  PipelineStatus,
  DlqRecord,
  ArtifactRecord,
  AgentIdentityRecord,
  TaskStepRecord,
} from './types.js'

const SCHEMA_VERSION = 12

// ── Size limits (bytes) ────────────────────────────────────────────────────────
const LIMIT_SPEC_YAML = 256 * 1024      // 256 KB
const LIMIT_OUTPUT = 1024 * 1024         // 1 MB (head 512KB + tail 512KB)
const LIMIT_OUTPUT_HALF = 512 * 1024     // 512 KB per half
const LIMIT_EVENT_DATA = 64 * 1024       // 64 KB
const LIMIT_SUMMARY = 4096              // 4 KB

export class FieldSizeLimitError extends Error {
  constructor(field: string, actual: number, limit: number) {
    super(`Field "${field}" exceeds size limit: ${actual} bytes > ${limit} bytes`)
    this.name = 'FieldSizeLimitError'
  }
}

function enforceLimit(value: string | null | undefined, field: string, limit: number): void {
  if (value == null) return
  const size = Buffer.byteLength(value, 'utf8')
  if (size > limit) {
    throw new FieldSizeLimitError(field, size, limit)
  }
}

function truncateOutput(value: string | null | undefined): string | null {
  if (value == null) return null
  const size = Buffer.byteLength(value, 'utf8')
  if (size <= LIMIT_OUTPUT) return value
  // Head + tail truncation with marker
  const head = value.slice(0, LIMIT_OUTPUT_HALF)
  const tail = value.slice(-LIMIT_OUTPUT_HALF)
  return head + '\n\n... [truncated: ' + size + ' bytes total, showing first/last 512KB] ...\n\n' + tail
}

export class ConvoyArtifactLimitError extends Error {
  constructor(convoyId: string) {
    super(`Convoy ${convoyId} has reached the maximum of 50 artifacts`)
    this.name = 'ConvoyArtifactLimitError'
  }
}

export interface ConvoyStore {
  insertConvoy(
    record: Omit<
      ConvoyRecord,
      | 'started_at' | 'finished_at' | 'total_tokens' | 'total_cost_usd'
      | 'pipeline_id' | 'circuit_state' | 'review_tokens_total' | 'review_budget'
    > & { pipeline_id?: string | null },
  ): void
  getConvoy(id: string): ConvoyRecord | undefined
  getLatestConvoy(): ConvoyRecord | undefined
  updateConvoyStatus(
    id: string,
    status: ConvoyStatus,
    extra?: { started_at?: string; finished_at?: string; total_tokens?: number | null; total_cost_usd?: number | null },
  ): void
  updateConvoyReviewTokens(convoyId: string, tokens: number): void
  updateConvoyCircuitState(convoyId: string, state: string | null): void
  insertTask(
    record: Omit<
      TaskRecord,
      | 'worker_id' | 'worktree' | 'output' | 'exit_code' | 'started_at' | 'finished_at'
      | 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost_usd'
      | 'on_exhausted' | 'injected' | 'provenance' | 'idempotency_key'
      | 'current_step' | 'total_steps' | 'review_level' | 'review_verdict'
      | 'review_tokens' | 'review_model' | 'panel_attempts' | 'dispute_id'
      | 'drift_score' | 'drift_retried' | 'discovered_issues' | 'compaction_count'
    > & { outputs?: string | null; inputs?: string | null },
  ): void
  insertInjectedTask(record: TaskRecord): void
  getTask(id: string, convoyId: string): TaskRecord | undefined
  getTasksByConvoy(convoyId: string): TaskRecord[]
  getTaskByIdempotencyKey(convoyId: string, key: string): TaskRecord | undefined
  getTaskByDisputeId(disputeId: string): TaskRecord | undefined
  getDisputedTasks(convoyId?: string): TaskRecord[]
  updateTaskStatus(
    id: string,
    convoyId: string,
    status: ConvoyTaskStatus,
    extra?: Partial<
      Pick<
        TaskRecord,
        | 'worker_id' | 'worktree' | 'output' | 'exit_code' | 'started_at' | 'finished_at'
        | 'retries' | 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost_usd' | 'prompt'
        | 'contract_result' | 'model'
      >
    >,
  ): void
  updateTaskReview(
    taskId: string,
    convoyId: string,
    fields: Partial<Pick<TaskRecord, 'review_level' | 'review_verdict' | 'review_tokens' | 'review_model' | 'panel_attempts' | 'dispute_id'>>,
  ): void
  updateTaskDrift(
    taskId: string,
    convoyId: string,
    fields: Partial<Pick<TaskRecord, 'drift_score' | 'drift_retried'>>,
  ): void
  updateTaskCompaction(taskId: string, convoyId: string, compactionCount: number): void
  updateTaskDisputeStatus(taskId: string, convoyId: string, status: ConvoyTaskStatus, disputeId: string): void
  getReadyTasks(convoyId: string): TaskRecord[]
  insertTaskStep(record: Omit<TaskStepRecord, 'id'>): number
  updateTaskStep(
    id: number,
    fields: Partial<Pick<TaskStepRecord, 'status' | 'exit_code' | 'output' | 'started_at' | 'finished_at'>>,
  ): void
  insertWorker(record: Omit<WorkerRecord, 'finished_at' | 'last_heartbeat'>): void
  getWorker(id: string): WorkerRecord | undefined
  updateWorkerStatus(
    id: string,
    status: WorkerStatus,
    extra?: Partial<Pick<WorkerRecord, 'finished_at' | 'last_heartbeat' | 'pid'>>,
  ): void
  insertEvent(record: Omit<EventRecord, 'id'>): number
  getEvents(convoyId: string): EventRecord[]
  insertDlqEntry(record: DlqRecord): void
  listDlqEntries(convoyIdFilter?: string): DlqRecord[]
  resolveDlqEntry(id: string, resolution: string): void
  insertArtifact(record: ArtifactRecord): void
  getArtifact(convoyId: string, name: string): ArtifactRecord | undefined
  getArtifactsByTask(taskId: string): ArtifactRecord[]
  getArtifactsByConvoy(convoyId: string): ArtifactRecord[]
  deleteArtifactsOlderThan(days: number): number
  insertAgentIdentity(record: AgentIdentityRecord): void
  getAgentIdentities(agent: string, limit: number): AgentIdentityRecord[]
  listAgentIdentitySummary(): Array<{ agent: string; task_count: number; latest_date: string }>
  purgeAgentIdentities(agent: string): number
  deleteAgentIdentitiesOlderThan(days: number): number
  getScratchpadValue(key: string): string | null
  setScratchpadValue(key: string, value: string): void
  clearScratchpad(): void
  clearScratchpadOlderThan(days: number): void
  insertPipeline(record: Omit<PipelineRecord, 'started_at' | 'finished_at' | 'total_tokens' | 'total_cost_usd'>): void
  getPipeline(id: string): PipelineRecord | undefined
  getLatestPipeline(): PipelineRecord | undefined
  updatePipelineStatus(
    id: string,
    status: PipelineStatus,
    extra?: { started_at?: string; finished_at?: string; total_tokens?: number | null; total_cost_usd?: number | null },
  ): void
  getConvoysByPipeline(pipelineId: string): ConvoyRecord[]
  getConvoyCounts(): { total: number; running: number; done: number; failed: number; gate_failed: number }
  getConvoyDurationStats(): { avg_sec: number | null; p95_sec: number | null; max_sec: number | null }
  getTokenAndCostTotals(): { total_tokens: number; total_cost_usd: number }
  getTopAgents(limit: number): Array<{ agent: string; task_count: number; total_tokens: number }>
  getTopModels(limit: number): Array<{ model: string; task_count: number; total_tokens: number }>
  getDlqSummary(): { count: number; top_failure_types: Array<{ type: string; count: number }> }
  getConvoyTaskSummary(convoyId: string): { total: number; done: number; running: number; failed: number; review_blocked: number; disputed: number; reviewed: number; panel_reviewed: number; tasks_with_drift: number; max_drift_score: number | null; drift_retried: number }
  getConvoyList(limit: number, offset: number): ConvoyRecord[]
  getConvoyDetails(convoyId: string): DashboardConvoyDetail | null
  withTransaction<T>(fn: () => T): T
  close(): void
}

class ConvoyStoreImpl implements ConvoyStore {
  private db: DatabaseSync
  private dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA foreign_keys = 0')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.initSchema()
  }

  private initSchema(): void {
    let version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS convoy (
          id                   TEXT PRIMARY KEY,
          name                 TEXT NOT NULL,
          spec_hash            TEXT NOT NULL,
          status               TEXT NOT NULL DEFAULT 'pending',
          branch               TEXT,
          created_at           TEXT NOT NULL,
          started_at           TEXT,
          finished_at          TEXT,
          spec_yaml            TEXT NOT NULL,
          total_tokens         INTEGER,
          total_cost_usd       TEXT,
          total_cost_usd_num   REAL,
          pipeline_id          TEXT,
          circuit_state        TEXT,
          review_tokens_total  INTEGER,
          review_budget        INTEGER
        );

        CREATE TABLE IF NOT EXISTS pipeline (
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
          total_cost_usd  TEXT,
          total_cost_usd_num REAL
        );

        CREATE TABLE IF NOT EXISTS task (
          id          TEXT NOT NULL,
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
          cost_usd          TEXT,
          cost_usd_num      REAL,
          gates             TEXT,
          on_exhausted      TEXT NOT NULL DEFAULT 'dlq',
          injected          INTEGER NOT NULL DEFAULT 0,
          provenance        TEXT,
          idempotency_key   TEXT,
          current_step      INTEGER,
          total_steps       INTEGER,
          review_level      TEXT,
          review_verdict    TEXT,
          review_tokens     INTEGER,
          review_model      TEXT,
          panel_attempts    INTEGER NOT NULL DEFAULT 0,
          dispute_id        TEXT,
          drift_score       REAL,
          drift_retried     INTEGER NOT NULL DEFAULT 0,
          compaction_count  INTEGER NOT NULL DEFAULT 0,
          outputs           TEXT,
          inputs            TEXT,
          discovered_issues TEXT,
          contract_result   TEXT,
          PRIMARY KEY (id, convoy_id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_idempotency ON task(convoy_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS task_step (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     TEXT NOT NULL REFERENCES task(id),
          step_index  INTEGER NOT NULL,
          prompt      TEXT NOT NULL,
          gates       TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          exit_code   INTEGER,
          output      TEXT,
          started_at  TEXT,
          finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS worker (
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

        CREATE TABLE IF NOT EXISTS event (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          convoy_id  TEXT REFERENCES convoy(id),
          task_id    TEXT,
          worker_id  TEXT,
          type       TEXT NOT NULL,
          data       TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dlq (
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

        CREATE TABLE IF NOT EXISTS artifact (
          id          TEXT PRIMARY KEY,
          convoy_id   TEXT NOT NULL REFERENCES convoy(id),
          task_id     TEXT NOT NULL REFERENCES task(id),
          name        TEXT NOT NULL,
          type        TEXT NOT NULL,
          content     TEXT NOT NULL CHECK (length(content) <= 1048576),
          created_at  TEXT NOT NULL,
          UNIQUE(convoy_id, name)
        );

        CREATE TABLE IF NOT EXISTS agent_identity (
          id             TEXT PRIMARY KEY,
          agent          TEXT NOT NULL,
          convoy_id      TEXT NOT NULL,
          task_id        TEXT NOT NULL,
          summary        TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          retention_days INTEGER NOT NULL DEFAULT 90
        );

        CREATE TABLE IF NOT EXISTS scratchpad (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS engine_lock (
          id             INTEGER PRIMARY KEY,
          pid            INTEGER NOT NULL,
          hostname       TEXT NOT NULL,
          started_at     TEXT NOT NULL,
          last_heartbeat TEXT NOT NULL
        );
      `)
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      version = SCHEMA_VERSION
    }
    if (version === 1) {
      this.db.exec('ALTER TABLE task ADD COLUMN adapter TEXT')
      this.db.exec('PRAGMA user_version = 2')
      version = 2
    }
    if (version === 2) {
      this.db.exec('ALTER TABLE task ADD COLUMN prompt_tokens INTEGER')
      this.db.exec('ALTER TABLE task ADD COLUMN completion_tokens INTEGER')
      this.db.exec('ALTER TABLE task ADD COLUMN total_tokens INTEGER')
      this.db.exec('ALTER TABLE task ADD COLUMN cost_usd TEXT')
      this.db.exec('ALTER TABLE convoy ADD COLUMN total_tokens INTEGER')
      this.db.exec('ALTER TABLE convoy ADD COLUMN total_cost_usd TEXT')
      this.db.exec('PRAGMA user_version = 3')
      version = 3
    }
    if (version === 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline (
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
        )
      `)
      this.db.exec('ALTER TABLE convoy ADD COLUMN pipeline_id TEXT')
      this.db.exec('PRAGMA user_version = 4')
      version = 4
    }
    if (version === 4) {
      migrateSchema(this.db, this.dbPath, 4, 5)
      version = 5
    }
    if (version === 5) {
      migrateSchema(this.db, this.dbPath, 5, 6)
      version = 6
    }
    if (version === 6) {
      migrateSchema(this.db, this.dbPath, 6, 7)
      version = 7
    }
    if (version === 7) {
      migrateSchema(this.db, this.dbPath, 7, 8)
      version = 8
    }
    if (version === 8) {
      migrateSchema(this.db, this.dbPath, 8, 9)
      version = 9
    }
    if (version === 9) {
      migrateSchema(this.db, this.dbPath, 9, 10)
      version = 10
    }
    if (version === 10) {
      migrateSchema(this.db, this.dbPath, 10, 11)
      version = 11
    }
    if (version === 11) {
      migrateSchema(this.db, this.dbPath, 11, 12)
      version = 12
    }
  }

  insertConvoy(
    record: Omit<
      ConvoyRecord,
      | 'started_at' | 'finished_at' | 'total_tokens' | 'total_cost_usd'
      | 'pipeline_id' | 'circuit_state' | 'review_tokens_total' | 'review_budget'
    > & { pipeline_id?: string | null },
  ): void {
    enforceLimit(record.spec_yaml, 'spec_yaml', LIMIT_SPEC_YAML)
    this.db
      .prepare(
        `INSERT INTO convoy
           (id, name, spec_hash, status, branch, created_at, started_at, finished_at,
            spec_yaml, pipeline_id)
         VALUES
           (:id, :name, :spec_hash, :status, :branch, :created_at, NULL, NULL,
            :spec_yaml, :pipeline_id)`,
      )
      .run({ ...record, pipeline_id: record.pipeline_id ?? null })
  }

  getConvoy(id: string): ConvoyRecord | undefined {
    return this.db
      .prepare('SELECT *, total_cost_usd_num AS total_cost_usd FROM convoy WHERE id = :id')
      .get({ id }) as ConvoyRecord | undefined
  }

  getLatestConvoy(): ConvoyRecord | undefined {
    return this.db
      .prepare('SELECT *, total_cost_usd_num AS total_cost_usd FROM convoy ORDER BY created_at DESC LIMIT 1')
      .get() as ConvoyRecord | undefined
  }

  updateConvoyStatus(
    id: string,
    status: ConvoyStatus,
    extra?: { started_at?: string; finished_at?: string; total_tokens?: number | null; total_cost_usd?: number | null },
  ): void {
    const sets = ['status = :status']
    const params: Record<string, string | number | null> = { id, status }

    if (extra?.started_at !== undefined) {
      sets.push('started_at = :started_at')
      params.started_at = extra.started_at
    }
    if (extra?.finished_at !== undefined) {
      sets.push('finished_at = :finished_at')
      params.finished_at = extra.finished_at
    }
    if (extra?.total_tokens !== undefined) {
      sets.push('total_tokens = :total_tokens')
      params.total_tokens = extra.total_tokens
    }
    if (extra?.total_cost_usd !== undefined) {
      sets.push('total_cost_usd = :total_cost_usd_text')
      sets.push('total_cost_usd_num = :total_cost_usd_num')
      params.total_cost_usd_text = extra.total_cost_usd !== null ? String(extra.total_cost_usd) : null
      params.total_cost_usd_num = extra.total_cost_usd
    }

    this.db.prepare(`UPDATE convoy SET ${sets.join(', ')} WHERE id = :id`).run(params)
  }

  updateConvoyReviewTokens(convoyId: string, tokens: number): void {
    this.db
      .prepare(
        `UPDATE convoy
         SET review_tokens_total = :tokens
         WHERE id = :id`,
      )
      .run({ id: convoyId, tokens })
  }

  updateConvoyCircuitState(convoyId: string, state: string | null): void {
    this.db
      .prepare('UPDATE convoy SET circuit_state = :state WHERE id = :id')
      .run({ id: convoyId, state: state ?? null })
  }

  insertTask(
    record: Omit<
      TaskRecord,
      | 'worker_id' | 'worktree' | 'output' | 'exit_code' | 'started_at' | 'finished_at'
      | 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost_usd'
      | 'on_exhausted' | 'injected' | 'provenance' | 'idempotency_key'
      | 'current_step' | 'total_steps' | 'review_level' | 'review_verdict'
      | 'review_tokens' | 'review_model' | 'panel_attempts' | 'dispute_id'
      | 'drift_score' | 'drift_retried' | 'discovered_issues' | 'compaction_count'
    > & { outputs?: string | null; inputs?: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO task
           (id, convoy_id, phase, prompt, agent, adapter, model, timeout_ms, status,
            worker_id, worktree, output, exit_code, started_at, finished_at,
            retries, max_retries, files, depends_on, gates,
            on_exhausted, injected, provenance, idempotency_key,
            outputs, inputs)
         VALUES
           (:id, :convoy_id, :phase, :prompt, :agent, :adapter, :model, :timeout_ms, :status,
            NULL, NULL, NULL, NULL, NULL, NULL,
            :retries, :max_retries, :files, :depends_on, :gates,
            'dlq', 0, NULL, NULL,
            :outputs, :inputs)`,
      )
      .run({ ...record, outputs: record.outputs ?? null, inputs: record.inputs ?? null })
  }

  insertInjectedTask(record: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO task
           (id, convoy_id, phase, prompt, agent, adapter, model, timeout_ms, status,
            worker_id, worktree, output, exit_code, started_at, finished_at,
            retries, max_retries, files, depends_on, gates,
            on_exhausted, injected, provenance, idempotency_key,
            current_step, total_steps, review_level, review_verdict,
            review_tokens, review_model, panel_attempts, dispute_id,
            drift_score, drift_retried, outputs, inputs, discovered_issues)
         VALUES
           (:id, :convoy_id, :phase, :prompt, :agent, :adapter, :model, :timeout_ms, :status,
            :worker_id, :worktree, :output, :exit_code, :started_at, :finished_at,
            :retries, :max_retries, :files, :depends_on, :gates,
            :on_exhausted, :injected, :provenance, :idempotency_key,
            :current_step, :total_steps, :review_level, :review_verdict,
            :review_tokens, :review_model, :panel_attempts, :dispute_id,
            :drift_score, :drift_retried, :outputs, :inputs, :discovered_issues)`,
      )
      .run(record as unknown as Record<string, string | number | null>)
  }

  getTask(id: string, convoyId: string): TaskRecord | undefined {
    return this.db
      .prepare('SELECT *, cost_usd_num AS cost_usd FROM task WHERE id = :id AND convoy_id = :convoy_id')
      .get({ id, convoy_id: convoyId }) as TaskRecord | undefined
  }

  getTasksByConvoy(convoyId: string): TaskRecord[] {
    return this.db
      .prepare('SELECT *, cost_usd_num AS cost_usd FROM task WHERE convoy_id = :convoy_id ORDER BY phase, id')
      .all({ convoy_id: convoyId }) as unknown as TaskRecord[]
  }

  getTaskByIdempotencyKey(convoyId: string, key: string): TaskRecord | undefined {
    return this.db
      .prepare('SELECT *, cost_usd_num AS cost_usd FROM task WHERE convoy_id = :convoy_id AND idempotency_key = :key')
      .get({ convoy_id: convoyId, key }) as TaskRecord | undefined
  }

  getTaskByDisputeId(disputeId: string): TaskRecord | undefined {
    return this.db
      .prepare('SELECT *, cost_usd_num AS cost_usd FROM task WHERE dispute_id = :dispute_id LIMIT 1')
      .get({ dispute_id: disputeId }) as TaskRecord | undefined
  }

  getDisputedTasks(convoyId?: string): TaskRecord[] {
    if (convoyId) {
      return this.db
        .prepare("SELECT *, cost_usd_num AS cost_usd FROM task WHERE status = 'disputed' AND convoy_id = :convoy_id ORDER BY phase, id")
        .all({ convoy_id: convoyId }) as unknown as TaskRecord[]
    }
    return this.db
      .prepare("SELECT *, cost_usd_num AS cost_usd FROM task WHERE status = 'disputed' ORDER BY convoy_id, phase, id")
      .all({}) as unknown as TaskRecord[]
  }

  updateTaskStatus(
    id: string,
    convoyId: string,
    status: ConvoyTaskStatus,
    extra?: Partial<
      Pick<
        TaskRecord,
        | 'worker_id' | 'worktree' | 'output' | 'exit_code' | 'started_at' | 'finished_at'
        | 'retries' | 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost_usd' | 'prompt'
        | 'contract_result' | 'model'
      >
    >,
  ): void {
    if (extra?.output !== undefined) {
      extra = { ...extra, output: truncateOutput(extra.output) }
    }
    const sets = ['status = :status']
    const params: Record<string, string | number | null> = { id, convoy_id: convoyId, status }
    const extraFields = [
      'worker_id', 'worktree', 'output', 'exit_code', 'started_at', 'finished_at',
      'retries', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cost_usd', 'prompt',
      'contract_result', 'model',
    ] as const

    if (extra) {
      for (const field of extraFields) {
        if (field in extra && extra[field] !== undefined) {
          sets.push(`${field} = :${field}`)
          params[field] = extra[field] as string | number | null
        }
      }
      if ('cost_usd' in extra && extra.cost_usd !== undefined) {
        sets.push('cost_usd_num = :cost_usd_num')
        params.cost_usd_num = extra.cost_usd
      }
    }

    this.db
      .prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = :id AND convoy_id = :convoy_id`)
      .run(params)
  }

  getReadyTasks(convoyId: string): TaskRecord[] {
    const allTasks = this.getTasksByConvoy(convoyId)
    const doneTaskIds = new Set(allTasks.filter(t => t.status === 'done').map(t => t.id))

    return allTasks.filter(task => {
      if (task.status !== 'pending') return false
      if (!task.depends_on) return true
      const deps = JSON.parse(task.depends_on) as string[]
      return deps.length === 0 || deps.every(depId => doneTaskIds.has(depId))
    })
  }

  insertTaskStep(record: Omit<TaskStepRecord, 'id'>): number {
    this.db
      .prepare(
        `INSERT INTO task_step
           (task_id, step_index, prompt, gates, status, exit_code, output, started_at, finished_at)
         VALUES
           (:task_id, :step_index, :prompt, :gates, :status, :exit_code, :output, :started_at, :finished_at)`,
      )
      .run(record)
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
    return row.id
  }

  updateTaskStep(
    id: number,
    fields: Partial<Pick<TaskStepRecord, 'status' | 'exit_code' | 'output' | 'started_at' | 'finished_at'>>,
  ): void {
    const sets: string[] = []
    const params: Record<string, string | number | null> = { id }
    const stepFields = ['status', 'exit_code', 'output', 'started_at', 'finished_at'] as const

    for (const field of stepFields) {
      if (field in fields && fields[field] !== undefined) {
        sets.push(`${field} = :${field}`)
        params[field] = fields[field] as string | number | null
      }
    }

    if (sets.length === 0) return
    this.db.prepare(`UPDATE task_step SET ${sets.join(', ')} WHERE id = :id`).run(params)
  }

  updateTaskReview(
    taskId: string,
    convoyId: string,
    fields: Partial<Pick<TaskRecord, 'review_level' | 'review_verdict' | 'review_tokens' | 'review_model' | 'panel_attempts' | 'dispute_id'>>,
  ): void {
    const sets: string[] = []
    const params: Record<string, string | number | null> = { id: taskId, convoy_id: convoyId }
    const reviewFields = ['review_level', 'review_verdict', 'review_tokens', 'review_model', 'panel_attempts', 'dispute_id'] as const

    for (const field of reviewFields) {
      if (field in fields && fields[field] !== undefined) {
        sets.push(`${field} = :${field}`)
        params[field] = fields[field] as string | number | null
      }
    }

    if (sets.length === 0) return
    this.db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = :id AND convoy_id = :convoy_id`).run(params)
  }

  updateTaskDrift(
    taskId: string,
    convoyId: string,
    fields: Partial<Pick<TaskRecord, 'drift_score' | 'drift_retried'>>,
  ): void {
    const sets: string[] = []
    const params: Record<string, string | number | null> = { id: taskId, convoy_id: convoyId }

    if (fields.drift_score !== undefined) {
      sets.push('drift_score = :drift_score')
      params.drift_score = fields.drift_score
    }
    if (fields.drift_retried !== undefined) {
      sets.push('drift_retried = :drift_retried')
      params.drift_retried = fields.drift_retried
    }

    if (sets.length === 0) return
    this.db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = :id AND convoy_id = :convoy_id`).run(params)
  }

  updateTaskCompaction(taskId: string, convoyId: string, compactionCount: number): void {
    this.db
      .prepare('UPDATE task SET compaction_count = :compaction_count WHERE id = :id AND convoy_id = :convoy_id')
      .run({ id: taskId, convoy_id: convoyId, compaction_count: compactionCount })
  }

  updateTaskDisputeStatus(taskId: string, convoyId: string, status: ConvoyTaskStatus, disputeId: string): void {
    this.db
      .prepare(
        `UPDATE task SET status = :status, dispute_id = :dispute_id
         WHERE id = :id AND convoy_id = :convoy_id`,
      )
      .run({ id: taskId, convoy_id: convoyId, status, dispute_id: disputeId })
  }

  insertWorker(record: Omit<WorkerRecord, 'finished_at' | 'last_heartbeat'>): void {
    this.db
      .prepare(
        `INSERT INTO worker
           (id, task_id, adapter, pid, session_id, status, worktree, created_at,
            finished_at, last_heartbeat)
         VALUES
           (:id, :task_id, :adapter, :pid, :session_id, :status, :worktree, :created_at,
            NULL, NULL)`,
      )
      .run(record)
  }

  getWorker(id: string): WorkerRecord | undefined {
    return this.db
      .prepare('SELECT * FROM worker WHERE id = :id')
      .get({ id }) as WorkerRecord | undefined
  }

  updateWorkerStatus(
    id: string,
    status: WorkerStatus,
    extra?: Partial<Pick<WorkerRecord, 'finished_at' | 'last_heartbeat' | 'pid'>>,
  ): void {
    const sets = ['status = :status']
    const params: Record<string, string | number | null> = { id, status }

    if (extra?.finished_at !== undefined) {
      sets.push('finished_at = :finished_at')
      params.finished_at = extra.finished_at
    }
    if (extra?.last_heartbeat !== undefined) {
      sets.push('last_heartbeat = :last_heartbeat')
      params.last_heartbeat = extra.last_heartbeat
    }
    if (extra?.pid !== undefined) {
      sets.push('pid = :pid')
      params.pid = extra.pid
    }

    this.db.prepare(`UPDATE worker SET ${sets.join(', ')} WHERE id = :id`).run(params)
  }

  insertEvent(record: Omit<EventRecord, 'id'>): number {
    enforceLimit(record.data, 'event.data', LIMIT_EVENT_DATA)
    this.db
      .prepare(
        `INSERT INTO event (convoy_id, task_id, worker_id, type, data, created_at)
         VALUES (:convoy_id, :task_id, :worker_id, :type, :data, :created_at)`,
      )
      .run(record)
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
    return row.id
  }

  getEvents(convoyId: string): EventRecord[] {
    return this.db
      .prepare('SELECT * FROM event WHERE convoy_id = :convoy_id ORDER BY id')
      .all({ convoy_id: convoyId }) as unknown as EventRecord[]
  }

  insertDlqEntry(record: DlqRecord): void {
    this.db
      .prepare(
        `INSERT INTO dlq
           (id, convoy_id, task_id, agent, failure_type, error_output, attempts,
            tokens_spent, escalation_task_id, resolved, resolution, created_at, resolved_at)
         VALUES
           (:id, :convoy_id, :task_id, :agent, :failure_type, :error_output, :attempts,
            :tokens_spent, :escalation_task_id, :resolved, :resolution, :created_at, :resolved_at)`,
      )
      .run(record as unknown as Record<string, string | number | null>)
  }

  listDlqEntries(convoyIdFilter?: string): DlqRecord[] {
    if (convoyIdFilter) {
      return this.db
        .prepare('SELECT * FROM dlq WHERE convoy_id = :convoy_id ORDER BY created_at DESC')
        .all({ convoy_id: convoyIdFilter }) as unknown as DlqRecord[]
    }
    return this.db
      .prepare('SELECT * FROM dlq ORDER BY created_at DESC')
      .all() as unknown as DlqRecord[]
  }

  resolveDlqEntry(id: string, resolution: string): void {
    this.db
      .prepare(
        `UPDATE dlq SET resolved = 1, resolution = :resolution, resolved_at = :resolved_at
         WHERE id = :id`,
      )
      .run({ id, resolution, resolved_at: new Date().toISOString() })
  }

  insertArtifact(record: ArtifactRecord): void {
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS cnt FROM artifact WHERE convoy_id = :convoy_id')
        .get({ convoy_id: record.convoy_id }) as { cnt: number }
    ).cnt
    if (count >= 50) {
      throw new ConvoyArtifactLimitError(record.convoy_id)
    }
    this.db
      .prepare(
        `INSERT INTO artifact (id, convoy_id, task_id, name, type, content, created_at)
         VALUES (:id, :convoy_id, :task_id, :name, :type, :content, :created_at)`,
      )
      .run(record as unknown as Record<string, string | number | null>)
  }

  getArtifact(convoyId: string, name: string): ArtifactRecord | undefined {
    return this.db
      .prepare('SELECT * FROM artifact WHERE convoy_id = :convoy_id AND name = :name')
      .get({ convoy_id: convoyId, name }) as ArtifactRecord | undefined
  }

  getArtifactsByTask(taskId: string): ArtifactRecord[] {
    return this.db
      .prepare('SELECT * FROM artifact WHERE task_id = :task_id ORDER BY created_at')
      .all({ task_id: taskId }) as unknown as ArtifactRecord[]
  }

  getArtifactsByConvoy(convoyId: string): ArtifactRecord[] {
    return this.db
      .prepare('SELECT * FROM artifact WHERE convoy_id = :convoy_id ORDER BY created_at')
      .all({ convoy_id: convoyId }) as unknown as ArtifactRecord[]
  }

  deleteArtifactsOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const result = this.db
      .prepare(
        `DELETE FROM artifact WHERE convoy_id IN (
           SELECT id FROM convoy WHERE finished_at IS NOT NULL AND finished_at < :cutoff
         )`,
      )
      .run({ cutoff })
    return (result as unknown as { changes: number }).changes
  }

  insertAgentIdentity(record: AgentIdentityRecord): void {
    const summarySize = Buffer.byteLength(record.summary, 'utf8')
    const truncatedSummary = summarySize > LIMIT_SUMMARY
      ? record.summary.slice(0, LIMIT_SUMMARY)
      : record.summary
    this.db
      .prepare(
        `INSERT INTO agent_identity
           (id, agent, convoy_id, task_id, summary, created_at, retention_days)
         VALUES
           (:id, :agent, :convoy_id, :task_id, :summary, :created_at, :retention_days)`,
      )
      .run({ ...record, summary: truncatedSummary } as unknown as Record<string, string | number | null>)
  }

  getAgentIdentities(agent: string, limit: number): AgentIdentityRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM agent_identity WHERE agent = :agent ORDER BY created_at DESC LIMIT :limit',
      )
      .all({ agent, limit }) as unknown as AgentIdentityRecord[]
  }

  listAgentIdentitySummary(): Array<{ agent: string; task_count: number; latest_date: string }> {
    return this.db
      .prepare(
        `SELECT agent, COUNT(*) AS task_count, MAX(created_at) AS latest_date
         FROM agent_identity GROUP BY agent ORDER BY agent`,
      )
      .all() as unknown as Array<{ agent: string; task_count: number; latest_date: string }>
  }

  purgeAgentIdentities(agent: string): number {
    const result = this.db
      .prepare('DELETE FROM agent_identity WHERE agent = :agent')
      .run({ agent })
    return (result as unknown as { changes: number }).changes
  }

  deleteAgentIdentitiesOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const result = this.db
      .prepare(
        `DELETE FROM agent_identity
         WHERE created_at < :cutoff
            OR (retention_days IS NOT NULL
                AND created_at < datetime('now', '-' || retention_days || ' days'))`,
      )
      .run({ cutoff })
    return (result as unknown as { changes: number }).changes
  }

  getScratchpadValue(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM scratchpad WHERE key = :key')
      .get({ key }) as { value: string } | undefined
    return row?.value ?? null
  }

  setScratchpadValue(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO scratchpad (key, value, updated_at)
         VALUES (:key, :value, :updated_at)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ key, value, updated_at: new Date().toISOString() })
  }

  clearScratchpad(): void {
    this.db.exec('DELETE FROM scratchpad')
  }

  clearScratchpadOlderThan(days: number): void {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    this.db.prepare('DELETE FROM scratchpad WHERE updated_at < :cutoff').run({ cutoff })
  }

  insertPipeline(record: Omit<PipelineRecord, 'started_at' | 'finished_at' | 'total_tokens' | 'total_cost_usd'>): void {
    enforceLimit(record.spec_yaml, 'pipeline.spec_yaml', LIMIT_SPEC_YAML)
    this.db
      .prepare(
        `INSERT INTO pipeline (id, name, status, branch, spec_yaml, convoy_specs, created_at,
           started_at, finished_at, total_tokens, total_cost_usd)
         VALUES (:id, :name, :status, :branch, :spec_yaml, :convoy_specs, :created_at,
           NULL, NULL, NULL, NULL)`,
      )
      .run(record)
  }

  getPipeline(id: string): PipelineRecord | undefined {
    return this.db
      .prepare('SELECT *, total_cost_usd_num AS total_cost_usd FROM pipeline WHERE id = :id')
      .get({ id }) as PipelineRecord | undefined
  }

  getLatestPipeline(): PipelineRecord | undefined {
    return this.db
      .prepare('SELECT *, total_cost_usd_num AS total_cost_usd FROM pipeline ORDER BY created_at DESC LIMIT 1')
      .get() as PipelineRecord | undefined
  }

  updatePipelineStatus(
    id: string,
    status: PipelineStatus,
    extra?: { started_at?: string; finished_at?: string; total_tokens?: number | null; total_cost_usd?: number | null },
  ): void {
    const sets = ['status = :status']
    const params: Record<string, string | number | null> = { id, status }

    if (extra?.started_at !== undefined) {
      sets.push('started_at = :started_at')
      params.started_at = extra.started_at
    }
    if (extra?.finished_at !== undefined) {
      sets.push('finished_at = :finished_at')
      params.finished_at = extra.finished_at
    }
    if (extra?.total_tokens !== undefined) {
      sets.push('total_tokens = :total_tokens')
      params.total_tokens = extra.total_tokens
    }
    if (extra?.total_cost_usd !== undefined) {
      sets.push('total_cost_usd = :total_cost_usd_text')
      sets.push('total_cost_usd_num = :total_cost_usd_num')
      params.total_cost_usd_text = extra.total_cost_usd !== null ? String(extra.total_cost_usd) : null
      params.total_cost_usd_num = extra.total_cost_usd
    }

    this.db.prepare(`UPDATE pipeline SET ${sets.join(', ')} WHERE id = :id`).run(params)
  }

  getConvoysByPipeline(pipelineId: string): ConvoyRecord[] {
    return this.db
      .prepare('SELECT *, total_cost_usd_num AS total_cost_usd FROM convoy WHERE pipeline_id = :pipeline_id ORDER BY created_at')
      .all({ pipeline_id: pipelineId }) as unknown as ConvoyRecord[]
  }

  getConvoyCounts(): { total: number; running: number; done: number; failed: number; gate_failed: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS cnt FROM convoy GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>
    const map: Record<string, number> = {}
    for (const row of rows) map[row.status] = row.cnt
    return {
      total: rows.reduce((s, r) => s + r.cnt, 0),
      running: map['running'] ?? 0,
      done: map['done'] ?? 0,
      failed: (map['failed'] ?? 0),
      gate_failed: (map['gate-failed'] ?? 0) + (map['hook-failed'] ?? 0),
    }
  }

  getConvoyDurationStats(): { avg_sec: number | null; p95_sec: number | null; max_sec: number | null } {
    const statsRow = this.db.prepare(
      `SELECT
         AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_sec,
         MAX((julianday(finished_at) - julianday(started_at)) * 86400) AS max_sec,
         COUNT(*) AS cnt
       FROM convoy
       WHERE finished_at IS NOT NULL AND started_at IS NOT NULL`,
    ).get() as { avg_sec: number | null; max_sec: number | null; cnt: number } | undefined
    if (!statsRow || statsRow.cnt === 0) return { avg_sec: null, p95_sec: null, max_sec: null }
    const offset = Math.max(0, Math.floor(statsRow.cnt * 0.95) - 1)
    const p95Row = this.db.prepare(
      `SELECT (julianday(finished_at) - julianday(started_at)) * 86400 AS duration
       FROM convoy
       WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
       ORDER BY duration
       LIMIT 1 OFFSET :offset`,
    ).get({ offset }) as { duration: number } | undefined
    return {
      avg_sec: statsRow.avg_sec,
      p95_sec: p95Row?.duration ?? null,
      max_sec: statsRow.max_sec,
    }
  }

  getTokenAndCostTotals(): { total_tokens: number; total_cost_usd: number } {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(total_cost_usd_num), 0) AS total_cost_usd
       FROM convoy`,
    ).get() as { total_tokens: number; total_cost_usd: number }
    return { total_tokens: row.total_tokens, total_cost_usd: row.total_cost_usd }
  }

  getTopAgents(limit: number): Array<{ agent: string; task_count: number; total_tokens: number }> {
    return this.db.prepare(
      `SELECT agent,
              COUNT(*) AS task_count,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM task
       GROUP BY agent
       ORDER BY task_count DESC
       LIMIT :limit`,
    ).all({ limit }) as Array<{ agent: string; task_count: number; total_tokens: number }>
  }

  getTopModels(limit: number): Array<{ model: string; task_count: number; total_tokens: number }> {
    return this.db.prepare(
      `SELECT model,
              COUNT(*) AS task_count,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM task
       WHERE model IS NOT NULL
       GROUP BY model
       ORDER BY task_count DESC
       LIMIT :limit`,
    ).all({ limit }) as Array<{ model: string; task_count: number; total_tokens: number }>
  }

  getDlqSummary(): { count: number; top_failure_types: Array<{ type: string; count: number }> } {
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM dlq').get() as { cnt: number }
    const typeRows = this.db.prepare(
      `SELECT failure_type AS type, COUNT(*) AS count
       FROM dlq
       GROUP BY failure_type
       ORDER BY count DESC`,
    ).all() as Array<{ type: string; count: number }>
    return { count: countRow.cnt, top_failure_types: typeRows }
  }

  getConvoyTaskSummary(convoyId: string): { total: number; done: number; running: number; failed: number; review_blocked: number; disputed: number; reviewed: number; panel_reviewed: number; tasks_with_drift: number; max_drift_score: number | null; drift_retried: number } {
    const row = this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('running', 'assigned') THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status IN ('failed', 'gate-failed', 'timed-out', 'hook-failed') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'review-blocked' THEN 1 ELSE 0 END) AS review_blocked,
         SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS disputed,
         SUM(CASE WHEN review_verdict IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
         SUM(CASE WHEN panel_attempts > 0 THEN 1 ELSE 0 END) AS panel_reviewed,
         SUM(CASE WHEN drift_score IS NOT NULL THEN 1 ELSE 0 END) AS tasks_with_drift,
         MAX(drift_score) AS max_drift_score,
         SUM(CASE WHEN drift_retried = 1 THEN 1 ELSE 0 END) AS drift_retried
       FROM task
       WHERE convoy_id = :convoy_id`,
    ).get({ convoy_id: convoyId }) as { total: number; done: number; running: number; failed: number; review_blocked: number; disputed: number; reviewed: number; panel_reviewed: number; tasks_with_drift: number; max_drift_score: number | null; drift_retried: number } | undefined
    if (!row || row.total === 0) {
      return { total: 0, done: 0, running: 0, failed: 0, review_blocked: 0, disputed: 0, reviewed: 0, panel_reviewed: 0, tasks_with_drift: 0, max_drift_score: null, drift_retried: 0 }
    }
    return {
      total: row.total ?? 0,
      done: row.done ?? 0,
      running: row.running ?? 0,
      failed: row.failed ?? 0,
      review_blocked: row.review_blocked ?? 0,
      disputed: row.disputed ?? 0,
      reviewed: row.reviewed ?? 0,
      panel_reviewed: row.panel_reviewed ?? 0,
      tasks_with_drift: row.tasks_with_drift ?? 0,
      max_drift_score: row.max_drift_score ?? null,
      drift_retried: row.drift_retried ?? 0,
    }
  }

  getConvoyList(limit: number, offset: number): ConvoyRecord[] {
    return this.db.prepare(
      `SELECT *, total_cost_usd_num AS total_cost_usd
       FROM convoy
       ORDER BY created_at DESC
       LIMIT :limit OFFSET :offset`,
    ).all({ limit, offset }) as unknown as ConvoyRecord[]
  }

  getConvoyDetails(convoyId: string): DashboardConvoyDetail | null {
    const convoy = this.getConvoy(convoyId)
    if (!convoy) return null

    const tasks = this.getTasksByConvoy(convoyId)
    const taskSummary = this.getConvoyTaskSummary(convoyId)
    const dlqEntries = this.listDlqEntries(convoyId)
    const rawEvents = this.getEvents(convoyId)
    const artifacts = this.getArtifactsByConvoy(convoyId)
    const limitedEvents = rawEvents.slice().reverse().slice(0, 500)

    return {
      convoy: {
        id: convoy.id,
        name: convoy.name,
        status: convoy.status,
        created_at: convoy.created_at,
        finished_at: convoy.finished_at,
        branch: convoy.branch,
        total_tokens: convoy.total_tokens,
        total_cost_usd: convoy.total_cost_usd,
      },
      taskSummary,
      quality: {
        reviewed_tasks: taskSummary.reviewed,
        review_blocked_tasks: taskSummary.review_blocked,
        disputed_tasks: taskSummary.disputed,
        panel_reviews: taskSummary.panel_reviewed,
      },
      drift: {
        tasks_with_drift: taskSummary.tasks_with_drift,
        max_drift_score: taskSummary.max_drift_score,
        drift_retried_tasks: taskSummary.drift_retried,
      },
      dlq_count: dlqEntries.length,
      dlq_entries: dlqEntries.map(d => ({
        id: d.id,
        task_id: d.task_id,
        agent: d.agent,
        failure_type: d.failure_type,
        attempts: d.attempts,
        resolved: d.resolved,
      })),
      artifact_count: artifacts.length,
      artifacts: artifacts.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        task_id: a.task_id,
        created_at: a.created_at,
      })),
      has_more_events: rawEvents.length > 500,
      events: limitedEvents.map(e => ({
        type: e.type,
        task_id: e.task_id,
        data: e.data ? (() => { try { return JSON.parse(e.data as string) } catch { return e.data } })() : null,
        created_at: e.created_at,
      })),
      tasks: tasks.map(t => ({
        id: t.id,
        phase: t.phase,
        agent: t.agent,
        model: t.model,
        status: t.status,
        retries: t.retries,
        started_at: t.started_at,
        finished_at: t.finished_at,
        total_tokens: t.total_tokens,
        cost_usd: t.cost_usd,
        review_level: t.review_level,
        review_verdict: t.review_verdict,
        review_tokens: t.review_tokens,
        review_model: t.review_model,
        panel_attempts: t.panel_attempts,
        dispute_id: t.dispute_id,
        drift_score: t.drift_score,
        drift_retried: t.drift_retried,
        files: t.files ? (() => { try { return JSON.parse(t.files as string) } catch { return null } })() : null,
      })),
    }
  }

  withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}

export function migrateSchema(db: DatabaseSync, dbPath: string, fromVersion: number, toVersion: number): void {
  for (let v = fromVersion; v < toVersion; v++) {
    const backupPath = `${dbPath}.v${v}.bak`
    copyFileSync(dbPath, backupPath)
    db.exec('BEGIN')
    try {
      if (v === 4) {
        db.exec(`
          ALTER TABLE task ADD COLUMN gates TEXT;
          ALTER TABLE task ADD COLUMN on_exhausted TEXT NOT NULL DEFAULT 'dlq';
          ALTER TABLE task ADD COLUMN injected INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE task ADD COLUMN provenance TEXT;
          ALTER TABLE task ADD COLUMN idempotency_key TEXT;
          CREATE UNIQUE INDEX idx_task_idempotency ON task(convoy_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
          ALTER TABLE convoy ADD COLUMN circuit_state TEXT;
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
      }
      if (v === 5) {
        db.exec(`
          ALTER TABLE task ADD COLUMN current_step INTEGER;
          ALTER TABLE task ADD COLUMN total_steps INTEGER;
          ALTER TABLE task ADD COLUMN review_level TEXT;
          ALTER TABLE task ADD COLUMN review_verdict TEXT;
          ALTER TABLE task ADD COLUMN review_tokens INTEGER;
          ALTER TABLE task ADD COLUMN review_model TEXT;
          ALTER TABLE task ADD COLUMN panel_attempts INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE task ADD COLUMN dispute_id TEXT;
          ALTER TABLE convoy ADD COLUMN review_tokens_total INTEGER;
          ALTER TABLE convoy ADD COLUMN review_budget INTEGER;
          CREATE TABLE task_step (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id     TEXT NOT NULL REFERENCES task(id),
            step_index  INTEGER NOT NULL,
            prompt      TEXT NOT NULL,
            gates       TEXT,
            status      TEXT NOT NULL DEFAULT 'pending',
            exit_code   INTEGER,
            output      TEXT,
            started_at  TEXT,
            finished_at TEXT
          );
        `)
      }
      if (v === 6) {
        db.exec(`
          ALTER TABLE task ADD COLUMN drift_score REAL;
          ALTER TABLE task ADD COLUMN drift_retried INTEGER NOT NULL DEFAULT 0;
        `)
      }
      if (v === 7) {
        db.exec(`
          ALTER TABLE task ADD COLUMN outputs TEXT;
          ALTER TABLE task ADD COLUMN inputs TEXT;
          ALTER TABLE task ADD COLUMN discovered_issues TEXT;
          CREATE TABLE artifact (
            id          TEXT PRIMARY KEY,
            convoy_id   TEXT NOT NULL REFERENCES convoy(id),
            task_id     TEXT NOT NULL REFERENCES task(id),
            name        TEXT NOT NULL,
            type        TEXT NOT NULL,
            content     TEXT NOT NULL CHECK (length(content) <= 1048576),
            created_at  TEXT NOT NULL,
            UNIQUE(convoy_id, name)
          );
          CREATE TABLE agent_identity (
            id             TEXT PRIMARY KEY,
            agent          TEXT NOT NULL,
            convoy_id      TEXT NOT NULL,
            task_id        TEXT NOT NULL,
            summary        TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            retention_days INTEGER NOT NULL DEFAULT 90
          );
        `)
      }
      if (v === 8) {
        db.exec(`
          CREATE TABLE scratchpad (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `)
      }
      if (v === 9) {
        db.exec(`
          ALTER TABLE convoy ADD COLUMN total_cost_usd_num REAL;
          ALTER TABLE task ADD COLUMN cost_usd_num REAL;
          ALTER TABLE pipeline ADD COLUMN total_cost_usd_num REAL;
          UPDATE convoy SET total_cost_usd_num = CAST(total_cost_usd AS REAL) WHERE total_cost_usd IS NOT NULL;
          UPDATE task SET cost_usd_num = CAST(cost_usd AS REAL) WHERE cost_usd IS NOT NULL;
          UPDATE pipeline SET total_cost_usd_num = CAST(total_cost_usd AS REAL) WHERE total_cost_usd IS NOT NULL;
        `)
      }
      if (v === 10) {
        db.exec(`
          ALTER TABLE task ADD COLUMN contract_result TEXT;
          ALTER TABLE task ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0;
        `)
      }
      if (v === 11) {
        db.exec(`
          CREATE TABLE task_new (
            id                TEXT NOT NULL,
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
            cost_usd_num      REAL,
            gates             TEXT,
            on_exhausted      TEXT NOT NULL DEFAULT 'dlq',
            injected          INTEGER NOT NULL DEFAULT 0,
            provenance        TEXT,
            idempotency_key   TEXT,
            current_step      INTEGER,
            total_steps       INTEGER,
            review_level      TEXT,
            review_verdict    TEXT,
            review_tokens     INTEGER,
            review_model      TEXT,
            panel_attempts    INTEGER NOT NULL DEFAULT 0,
            dispute_id        TEXT,
            drift_score       REAL,
            drift_retried     INTEGER NOT NULL DEFAULT 0,
            compaction_count  INTEGER NOT NULL DEFAULT 0,
            outputs           TEXT,
            inputs            TEXT,
            discovered_issues TEXT,
            contract_result   TEXT,
            PRIMARY KEY (id, convoy_id)
          );
          INSERT INTO task_new SELECT
            id, convoy_id, phase, prompt, agent, adapter, model, timeout_ms,
            status, worker_id, worktree, output, exit_code, started_at, finished_at,
            retries, max_retries, files, depends_on, prompt_tokens, completion_tokens,
            total_tokens, cost_usd, cost_usd_num, gates, on_exhausted, injected,
            provenance, idempotency_key, current_step, total_steps, review_level,
            review_verdict, review_tokens, review_model, panel_attempts, dispute_id,
            drift_score, drift_retried, compaction_count, outputs, inputs,
            discovered_issues, contract_result
          FROM task;
          DROP TABLE task;
          ALTER TABLE task_new RENAME TO task;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_task_idempotency ON task(convoy_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
        `)
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw new Error(`Migration v${v}→v${v + 1} failed. Backup at ${backupPath}. Original error: ${(err as Error).message}`)
    }
    db.exec(`PRAGMA user_version = ${v + 1}`)
  }
}

export function createConvoyStore(dbPath: string): ConvoyStore {
  return new ConvoyStoreImpl(dbPath)
}
