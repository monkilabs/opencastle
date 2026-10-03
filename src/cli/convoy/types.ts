/**
 * `interrupted` is a run stopped by SIGINT or SIGTERM: its running tasks went
 * back to pending, and `convoy resume` carries on from there.
 */
export type ConvoyStatus = 'pending' | 'running' | 'done' | 'failed' | 'gate-failed' | 'hook-failed' | 'interrupted'

export type ConvoyTaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'done'
  | 'failed'
  | 'gate-failed'
  | 'review-blocked'
  | 'timed-out'
  | 'skipped'
  | 'hook-failed'
  | 'disputed'
  | 'wait-for-input'

export type WorkerStatus = 'spawned' | 'running' | 'done' | 'failed' | 'killed'

export type PipelineStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ConvoyRecord {
  id: string
  name: string
  spec_hash: string
  status: ConvoyStatus
  branch: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  spec_yaml: string
  total_tokens: number | null
  total_cost_usd: number | null
  pipeline_id: string | null
  circuit_state: string | null
  review_tokens_total: number | null
  review_budget: number | null
  /** What the convoy branch was cut from, so a run can say how to review it. */
  base_ref?: string | null
  /** 1 when any token or cost figure in the totals is an estimate. */
  cost_estimated?: number
  /** The runtime the run used (claude, codex, …). */
  adapter?: string | null
}

export interface TaskRecord {
  id: string
  convoy_id: string
  phase: number
  prompt: string
  agent: string
  adapter: string | null
  model: string | null
  timeout_ms: number
  status: ConvoyTaskStatus
  worker_id: string | null
  worktree: string | null
  output: string | null
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  retries: number
  max_retries: number
  files: string | null
  depends_on: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  cost_usd: number | null
  gates: string | null
  on_exhausted: 'dlq' | 'skip' | 'stop'
  injected: number
  provenance: string | null
  idempotency_key: string | null
  current_step: number | null
  total_steps: number | null
  review_level: string | null
  review_verdict: string | null
  review_tokens: number | null
  review_model: string | null
  panel_attempts: number
  dispute_id: string | null
  drift_score: number | null
  drift_retried: number
  outputs?: string | null          // JSON array of TaskOutput
  inputs?: string | null           // JSON array of TaskInput
  contract_result?: string | null  // JSON ContractResult
  /** Input tokens the runtime served from its prompt cache. */
  cache_read_tokens?: number | null
  /** Input tokens the runtime wrote to its prompt cache. */
  cache_write_tokens?: number | null
  /** 1 when the token or cost figures are an estimate, not what the runtime reported. */
  cost_estimated?: number
  /** Why the last attempt failed, told to the next one. Kept apart from `prompt` so retries never stack. */
  retry_note?: string | null
  /** A worker branch kept because its work could not be merged. */
  branch?: string | null
}

export interface WorkerRecord {
  id: string
  task_id: string | null
  adapter: string
  pid: number | null
  session_id: string | null
  status: WorkerStatus
  worktree: string | null
  created_at: string
  finished_at: string | null
  last_heartbeat: string | null
}

export interface EventRecord {
  id?: number
  convoy_id: string | null
  task_id: string | null
  worker_id: string | null
  type: string
  data: string | null
  created_at: string
}

export interface PipelineRecord {
  id: string
  name: string
  status: PipelineStatus
  branch: string | null
  spec_yaml: string
  convoy_specs: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  total_tokens: number | null
  total_cost_usd: number | null
}

export interface TDDGateConfig {
  enabled: boolean
  source_patterns: string[]
  test_patterns: string[]
  exclude_patterns: string[]
  mode: 'warn' | 'block'
  exempt_agents: string[]
}

export interface BuiltInGatesConfig {
  secret_scan?: boolean
  blast_radius?: boolean
  dependency_audit?: 'auto' | boolean
  regression_test?: 'auto' | boolean
  browser_test?: 'auto' | boolean
  /** Fail a task that declared files and produced none. On unless set to false. */
  no_op?: 'auto' | boolean
  gate_timeout?: number
  tdd_check?: boolean | TDDGateConfig
}


export interface BrowserTestConfig {
  urls: string[]
  check_console_errors?: boolean
  visual_diff_threshold?: number
  a11y?: boolean
  severity_threshold?: 'critical' | 'serious' | 'moderate' | 'minor'
  baselines_dir?: string
}
export interface GuardConfig {
  enabled?: boolean      // default: true
  agent?: string         // optional agent name (e.g. 'reviewer')
  checks?: string[]      // e.g. ['observability', 'cleanup', 'cost-report']
}

export interface DlqRecord {
  id: string
  convoy_id: string
  task_id: string
  agent: string
  failure_type: string
  error_output: string | null
  attempts: number
  tokens_spent: number | null
  escalation_task_id: string | null
  resolved: number
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

export interface CircuitBreakerConfig {
  threshold?: number      // failures before Open (default: 3)
  cooldown_ms?: number    // ms in Open before Half-Open (default: 300000 = 5min)
  fallback_agent?: string // reassign pending tasks when circuit opens
}

export interface CompactionConfig {
  enabled: boolean
  token_threshold_pct: number  // e.g., 70 = compact at 70% of model context window
  summary_max_tokens: number   // max tokens for the compaction summary
}

export interface TaskOutput {
  name: string
  type: 'file' | 'summary' | 'json'
  description?: string
}

export interface TaskInput {
  from: string
  name: string
  as?: string
}

export interface ArtifactRecord {
  id: string
  convoy_id: string
  task_id: string
  name: string
  type: 'file' | 'summary' | 'json'
  content: string
  created_at: string
}

export interface AgentIdentityRecord {
  id: string
  agent: string
  convoy_id: string
  task_id: string
  summary: string
  created_at: string
  retention_days: number
}

export interface StepCondition {
  step: string         // reference previous step by id
  exitCode?: { eq?: number; ne?: number; gt?: number; lt?: number }
  fileExists?: { path: string }
}

export interface TaskStep {
  id?: string
  prompt: string
  gates?: string[]
  max_retries?: number // inherits from task if omitted
  if?: StepCondition
}

export interface Hook {
  type: 'review' | 'guard' | 'agent' | 'command' | 'validate'
  name?: string
  prompt?: string  // for agent hooks
  command?: string // for command hooks
  on?: 'pre_task' | 'post_task' | 'post_convoy'
}

export interface TaskStepRecord {
  id: number
  task_id: string
  step_index: number
  prompt: string
  gates: string | null
  status: string
  exit_code: number | null
  output: string | null
  started_at: string | null
  finished_at: string | null
}

export interface ScratchpadRecord {
  key: string
  value: string
  updated_at: string
}

export interface MCPServerConfig {
  name: string
  type: string
  local?: boolean
  command?: string
  args?: string[]
  url?: string
  config?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Discriminated union covering every canonical convoy event type.
// Each variant constrains the `data` shape that callers may pass to emit().
// ---------------------------------------------------------------------------
export type ConvoyEventType =
  | { type: 'convoy_started'; data?: { name?: string; branch?: string; base?: string | null; concurrency?: number } }
  | { type: 'convoy_finished'; data?: { status: string } }
  | { type: 'convoy_failed'; data?: { status: string; reason?: string } }
  | { type: 'convoy_interrupted'; data?: { signal?: string; requeued?: string[] } }
  | { type: 'convoy_guard'; data?: { passed?: boolean; warnings?: string[] } }
  | { type: 'convoy_resumed'; data?: { original_created_at?: string; reset?: string[] } }
  | { type: 'task_started'; data?: { worker_id?: string; mechanism?: string; adapter?: string; attempt?: number } }
  | {
      type: 'task_done'
      data?: {
        exit_code?: number
        worker_id?: string
        tokens?: number | null
        cost_usd?: number | null
        estimated?: boolean
        model?: string | null
      }
    }
  | { type: 'task_failed'; data?: { reason: string; message?: string; worker_id?: string; gate?: string; hook?: string; exit_code?: number } }
  | { type: 'task_skipped'; data?: { reason: string } }
  | { type: 'task_retried'; data?: { previous_status: string; reason?: string; attempt?: number } }
  | { type: 'task_merged'; data?: { branch?: string; files?: number } }
  | { type: 'review_started'; data?: { level: string; task_id?: string; model?: string } }
  | {
      type: 'review_verdict'
      data?: {
        level: string
        verdict: string
        tokens: number
        model?: string | null
        feedback_length?: number
        passes?: number
        blocks?: number
      }
    }
  | { type: 'review_skipped'; data?: { level: string; reason: string } }
  | { type: 'dispute_opened'; data?: { dispute_id: string; task_id: string; agent?: string; reason?: string } }
  | { type: 'dlq_entry_created'; data?: { dlq_id: string; task_id: string; agent?: string; attempts?: number } }
  | { type: 'circuit_breaker_tripped'; data?: { agent?: string; failure_count?: number; threshold?: number } }
  | { type: 'circuit_breaker_fallback'; data?: { original_agent?: string; fallback_agent?: string; task_id?: string } }
  | { type: 'circuit_breaker_blocked'; data?: { agent?: string; task_id?: string } }
  | { type: 'merge_conflict_detected'; data?: { attempt?: number; conflicting_files?: string[] } }
  | { type: 'merge_failed'; data?: { branch: string; error: string; conflicting_files?: string[] } }
  | { type: 'gate_result'; data?: { command: string; passed: boolean; exit_code?: number; scope?: string; output?: string } }
  | { type: 'artifact_limit_reached'; data?: { task_id?: string; limit?: number; current?: number } }
  | { type: 'agent_identity_captured'; data?: { agent?: string; task_id?: string } }
  | { type: 'agent_identity_rejected'; data?: { agent?: string; task_id?: string; reason?: string } }
  | { type: 'post_convoy_hook_failed'; data?: { hook?: string; error?: string } }
  | {
      type: 'session'
      data?: { agent?: string; model?: string | null; task?: string; outcome?: string; duration_min?: number; [key: string]: unknown }
    }
  | {
      type: 'delegation'
      data?: { agent?: string; model?: string | null; tier?: string; mechanism?: string; outcome?: string; [key: string]: unknown }
    }
  | {
      type: 'secret_leak_prevented'
      data?: { original_type?: string; patterns?: string[]; task_id?: string; findings_count?: number; context?: string }
    }
  | { type: 'ndjson_write_failed'; data?: { original_type?: string } }
  | { type: 'built_in_gate_result'; data?: { gate: string; passed: boolean; output?: string; level?: string } }
  | { type: 'worker_killed'; data?: { reason?: string; worker_id?: string; task_id?: string } }
  | { type: 'contract_violation'; data?: { task_id?: string; agent?: string; missing?: string[]; warnings?: string[] } }
  | { type: 'partition_violation'; data?: { task_id?: string; allowed?: string[]; actual?: string[]; violations?: string[] } }
  | { type: 'tdd_check_passed'; data?: { task_id?: string; new_source_files?: number; existing_test_files?: number } }
  | { type: 'tdd_check_failed'; data?: { task_id?: string; missing_test_files?: string[]; new_source_files?: number } }
  | { type: 'tdd_check_skipped'; data?: { task_id?: string; reason?: string; agent?: string } }
  | { type: 'artifacts_extracted'; data?: { task_id?: string; count?: number; artifacts?: Array<{ filename: string; summary?: string }> } }

/** All canonical convoy event type strings. Used for runtime validation. */
export const KNOWN_EVENT_TYPES: Set<string> = new Set<ConvoyEventType['type']>([
  'convoy_started',
  'convoy_finished',
  'convoy_failed',
  'convoy_interrupted',
  'convoy_guard',
  'convoy_resumed',
  'task_started',
  'task_done',
  'task_failed',
  'task_skipped',
  'task_retried',
  'task_merged',
  'review_started',
  'review_verdict',
  'review_skipped',
  'dispute_opened',
  'dlq_entry_created',
  'circuit_breaker_tripped',
  'circuit_breaker_fallback',
  'circuit_breaker_blocked',
  'merge_conflict_detected',
  'merge_failed',
  'gate_result',
  'artifact_limit_reached',
  'agent_identity_captured',
  'agent_identity_rejected',
  'post_convoy_hook_failed',
  'session',
  'delegation',
  'secret_leak_prevented',
  'ndjson_write_failed',
  'built_in_gate_result',
  'worker_killed',
  'contract_violation',
  'partition_violation',
  'tdd_check_passed',
  'tdd_check_failed',
  'tdd_check_skipped',
  'artifacts_extracted',
])
