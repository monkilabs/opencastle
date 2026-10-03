import * as v from 'valibot'

type AnySchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>

const optNum = v.optional(v.nullable(v.number()))
const optStr = v.optional(v.nullable(v.string()))

const EVENT_DATA_SCHEMAS: Record<string, AnySchema> = {
  convoy_started: v.looseObject({
    name: v.optional(v.string()),
    branch: v.optional(v.string()),
    base: optStr,
    concurrency: v.optional(v.number()),
  }),
  convoy_finished: v.looseObject({ status: v.string() }),
  convoy_failed: v.looseObject({ status: v.string(), reason: v.optional(v.string()) }),
  convoy_interrupted: v.looseObject({
    signal: v.optional(v.string()),
    requeued: v.optional(v.array(v.string())),
  }),
  convoy_guard: v.looseObject({
    passed: v.optional(v.boolean()),
    warnings: v.optional(v.array(v.string())),
  }),
  convoy_resumed: v.looseObject({
    original_created_at: v.optional(v.string()),
    reset: v.optional(v.array(v.string())),
  }),

  task_started: v.looseObject({
    worker_id: v.optional(v.string()),
    mechanism: v.optional(v.string()),
    adapter: v.optional(v.string()),
    attempt: v.optional(v.number()),
  }),
  task_done: v.looseObject({
    exit_code: v.optional(v.number()),
    worker_id: v.optional(v.string()),
    tokens: optNum,
    cost_usd: optNum,
    estimated: v.optional(v.boolean()),
    model: optStr,
  }),
  task_failed: v.looseObject({
    reason: v.string(),
    message: v.optional(v.string()),
    worker_id: v.optional(v.string()),
    gate: v.optional(v.string()),
    hook: v.optional(v.string()),
    exit_code: v.optional(v.number()),
  }),
  task_skipped: v.looseObject({ reason: v.string() }),
  task_retried: v.looseObject({
    previous_status: v.string(),
    reason: v.optional(v.string()),
    attempt: v.optional(v.number()),
  }),
  task_merged: v.looseObject({
    branch: v.optional(v.string()),
    files: v.optional(v.number()),
  }),

  review_started: v.looseObject({
    level: v.string(),
    task_id: v.optional(v.string()),
    model: optStr,
  }),
  review_verdict: v.looseObject({
    level: v.string(),
    verdict: v.string(),
    tokens: v.number(),
    model: optStr,
    feedback_length: v.optional(v.number()),
    passes: v.optional(v.number()),
    blocks: v.optional(v.number()),
  }),
  review_skipped: v.looseObject({ level: v.string(), reason: v.string() }),
  dispute_opened: v.looseObject({
    dispute_id: v.string(),
    task_id: v.string(),
    agent: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  dlq_entry_created: v.looseObject({
    dlq_id: v.string(),
    task_id: v.string(),
    agent: v.optional(v.string()),
    attempts: v.optional(v.number()),
  }),

  circuit_breaker_tripped: v.looseObject({
    agent: v.optional(v.string()),
    failure_count: v.optional(v.number()),
    threshold: v.optional(v.number()),
  }),
  circuit_breaker_fallback: v.looseObject({
    original_agent: v.optional(v.string()),
    fallback_agent: v.optional(v.string()),
    task_id: v.optional(v.string()),
  }),
  circuit_breaker_blocked: v.looseObject({
    agent: v.optional(v.string()),
    task_id: v.optional(v.string()),
  }),

  merge_conflict_detected: v.looseObject({
    attempt: v.optional(v.number()),
    conflicting_files: v.optional(v.array(v.string())),
  }),
  merge_failed: v.looseObject({
    branch: v.string(),
    error: v.string(),
    conflicting_files: v.optional(v.array(v.string())),
  }),
  gate_result: v.looseObject({
    command: v.string(),
    passed: v.boolean(),
    exit_code: v.optional(v.number()),
    scope: v.optional(v.string()),
    output: v.optional(v.string()),
  }),

  artifact_limit_reached: v.looseObject({
    task_id: v.optional(v.string()),
    limit: v.optional(v.number()),
    current: v.optional(v.number()),
  }),

  agent_identity_captured: v.looseObject({
    agent: v.optional(v.string()),
    task_id: v.optional(v.string()),
  }),
  agent_identity_rejected: v.looseObject({
    agent: v.optional(v.string()),
    task_id: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),

  post_convoy_hook_failed: v.looseObject({
    hook: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  session: v.looseObject({
    agent: v.optional(v.string()),
    model: optStr,
    task: v.optional(v.string()),
    outcome: v.optional(v.string()),
    duration_min: v.optional(v.number()),
  }),
  delegation: v.looseObject({
    agent: v.optional(v.string()),
    model: optStr,
    tier: v.optional(v.string()),
    mechanism: v.optional(v.string()),
    outcome: v.optional(v.string()),
  }),
  secret_leak_prevented: v.looseObject({
    original_type: v.optional(v.string()),
    patterns: v.optional(v.array(v.string())),
    task_id: v.optional(v.string()),
    findings_count: v.optional(v.number()),
    context: v.optional(v.string()),
  }),
  ndjson_write_failed: v.looseObject({ original_type: v.optional(v.string()) }),
  built_in_gate_result: v.looseObject({
    gate: v.string(),
    passed: v.boolean(),
    output: v.optional(v.string()),
    level: v.optional(v.string()),
  }),
  watch_started: v.looseObject({
    trigger_type: v.optional(v.string()),
    pid: v.optional(v.number()),
  }),
  watch_cycle_start: v.looseObject({
    cycle_number: v.optional(v.number()),
    triggered_by: v.optional(v.string()),
  }),
  watch_cycle_end: v.looseObject({
    cycle_number: v.optional(v.number()),
    status: v.optional(v.string()),
  }),
  watch_stopped: v.looseObject({ reason: v.optional(v.string()) }),
  worker_killed: v.looseObject({
    reason: v.optional(v.string()),
    worker_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
  }),
  contract_violation: v.looseObject({
    task_id: v.optional(v.string()),
    agent: v.optional(v.string()),
    missing: v.optional(v.array(v.string())),
    warnings: v.optional(v.array(v.string())),
  }),
  partition_violation: v.looseObject({
    task_id: v.optional(v.string()),
    allowed: v.optional(v.array(v.string())),
    actual: v.optional(v.array(v.string())),
    violations: v.optional(v.array(v.string())),
  }),
  tdd_check_passed: v.looseObject({
    task_id: v.optional(v.string()),
    new_source_files: v.optional(v.number()),
    existing_test_files: v.optional(v.number()),
  }),
  tdd_check_failed: v.looseObject({
    task_id: v.optional(v.string()),
    missing_test_files: v.optional(v.array(v.string())),
    new_source_files: v.optional(v.number()),
  }),
  tdd_check_skipped: v.looseObject({
    task_id: v.optional(v.string()),
    reason: v.optional(v.string()),
    agent: v.optional(v.string()),
  }),
  artifacts_extracted: v.looseObject({
    task_id: v.optional(v.string()),
    count: v.optional(v.number()),
    artifacts: v.optional(v.array(v.looseObject({
      filename: v.string(),
      summary: v.optional(v.string()),
    }))),
  }),
}

/** Every event type with a declared data shape — kept equal to KNOWN_EVENT_TYPES by a test. */
export const SCHEMA_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(EVENT_DATA_SCHEMAS))

export function validateEventData(
  type: string,
  data: unknown,
): { valid: boolean; issues?: string[] } {
  const schema = EVENT_DATA_SCHEMAS[type]
  if (schema === undefined) return { valid: true }
  if (data === undefined || data === null) return { valid: true }
  const result = v.safeParse(schema, data)
  if (result.success) return { valid: true }
  return {
    valid: false,
    issues: result.issues.map((i) => i.message),
  }
}
