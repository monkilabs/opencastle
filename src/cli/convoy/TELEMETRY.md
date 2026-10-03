# Convoy Telemetry Model

The events the convoy engine (experimental) records, and how its concepts map
to [OpenTelemetry](https://opentelemetry.io/) semantics. OpenCastle does not
export OpenTelemetry; the mapping is for anyone writing an exporter.

## Conceptual Mapping

| Convoy Concept | OTel Concept | ID Field | Description |
|---------------|-------------|----------|-------------|
| **Convoy** | Trace | `convoy_id` → `trace_id` | One run of a `.convoy.yml` spec, including its resumes |
| **Task** | Span | `task_id` → `span_id` | One unit of work within a convoy |
| **TaskStep** | Sub-span | `step_index` | Sequential steps within a multi-step task |
| **Event** | Log / SpanEvent | `type` | Structured occurrence during execution |
| **Metrics** | Derived aggregates | — | Computed from events (tokens, cost, duration) |

### ID Correlation

```
trace_id  = convoy_id   (convoy-<start time in ms>, set when the run starts)
span_id   = task_id     (unique within the convoy, from the spec)
worker_id = one attempt at a task: <run>-<task>-<sequence>, also the name of its worktree
```

Every event carries `convoy_id`, `task_id` and `worker_id`, each nullable.
`worker_id` is set on `task_started`, `task_done`, and `task_failed` once a
worktree exists; other task events carry the task only.

## Storage

- **Primary**: SQLite (`.opencastle/convoy.db`) — durable, queryable, crash-safe
- **Supplementary**: NDJSON, one file per convoy (`.opencastle/logs/convoys/<convoy-id>.ndjson`) — append-only log for streaming/grep

SQLite is the source of truth. On resume, `recoverNdjson()` truncates a partial
last line and replays the SQLite events missing from the NDJSON file.

Event data is masked for secrets before either copy is written
([`redact.ts`](redact.ts)); a masked value adds a `secret_leak_prevented` event
with `context: event_redacted`.

These are separate from the agent log, `.opencastle/logs/events.ndjson`, which
`opencastle log` appends to and validates against its
[schema](../../orchestrator/customizations/logs/README.md).

### Write Strategy

NDJSON writes use synchronous `appendFileSync` + `fsyncSync` per event, so every
event is on disk before the engine continues. At ~1–2 ms per event this is
negligible for a run's few hundred events. A failed NDJSON write is recorded in
SQLite as `ndjson_write_failed`.

## Event Type Reference

All 39 event types in `KNOWN_EVENT_TYPES` ([`types.ts`](types.ts)), with the data
fields the engine writes. The shapes are checked by
[`event-schemas.ts`](event-schemas.ts). Unless noted, the source is
`convoy/engine.ts` (relative to `src/cli/`).

Several types come only from parts of a spec that are off unless the spec asks
for them; the **When** column says which.

### Convoy Lifecycle

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `convoy_started` | `name: string; branch: string; base: string \| null; concurrency: number` | A run starts |
| `convoy_finished` | `status: 'done'` | Every task done and every gate passed |
| `convoy_failed` | `status: 'failed' \| 'gate-failed'; reason: string` | A task not done (`"<n> task(s) not done"`), a gate failed (`"Gate check failed"`), or the engine crashed (`"engine crashed: …"`) |
| `convoy_interrupted` | `signal: 'SIGINT' \| 'SIGTERM' \| 'abort'; requeued: string[]` | Ctrl+C or SIGTERM; `requeued` are the tasks put back to pending |
| `convoy_resumed` | `original_created_at: string; reset: string[]` | `convoy resume`; `reset` are the tasks put back to pending |
| `convoy_guard` | `passed: boolean; warnings: string[]` | The end-of-run consistency check found something: a task left non-terminal, fewer log lines than finished tasks, fewer `task_started` events than retries, or totals not stored |

### Task Lifecycle

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `task_started` | `worker_id: string; mechanism: 'worktree'; adapter: string; attempt: number` | An attempt starts in its worktree |
| `task_done` | `exit_code: number; worker_id: string; tokens: number \| null; cost_usd: number \| null; estimated: boolean; model: string \| null` | The task finished and its work merged. `tokens` and `cost_usd` cover every attempt; `cost_usd` includes its review |
| `task_failed` | `reason: string; message: string; gate?: string; hook?: string; exit_code?: number; worker_id?: string` | A task failed for good. `reason` is one of `error`, `timeout`, `gate-failed`, `no-op`, `review-blocked`, `merge-failed`, `worktree`, `commit`, `adapter`, `hook-failed`, `secret-in-prompt`, `missing-input`, `symlink-escape`, `symlink-escape-post`, `engine-error` |
| `task_skipped` | `reason: string` | A dependency failed or never finished, the run stopped dispatching, or a circuit breaker is open |
| `task_retried` | `previous_status: string; reason?: string; attempt?: number` | A failed attempt goes back to pending with its reason (`reason`, `attempt`), or `convoy resume` resets the task (`previous_status` only) |
| `task_merged` | `branch: string; files: number` | The task's commit merged into the convoy branch; `files` is how many it changed |

### Review & Disputes

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `review_started` | `level: 'fast' \| 'panel'; task_id: string; model: string` | A reviewer starts; `model` is the spec's `reviewer_model`, or `default` (the runtime's economy model) |
| `review_verdict` | `level: string; verdict: 'pass' \| 'block'; tokens: number; model: string \| null; feedback_length: number; passes?: number; blocks?: number` | A verdict. `level: 'auto-pass'` with 0 tokens means no reviewer ran; `passes` and `blocks` are set for a panel |
| `review_skipped` | `level: string; reason: string` | A review was due and reached no verdict (the runtime cannot run read-only, the reviewer failed, timed out or gave no verdict, or the review budget is spent). Never recorded as a pass |
| `dispute_opened` | `dispute_id: string; task_id: string; agent: string; panel_attempts: number; reason: string` | `review: panel` blocked the task three times; also written to `.opencastle/DISPUTES.md` |
| `dlq_entry_created` | `dlq_id: string; task_id: string; agent: string; attempts: number` | A task failed for good; its record goes to the `dlq` table and `.opencastle/AGENT-FAILURES.md` |

### Circuit Breaker

Only when the spec sets `defaults.circuit_breaker`.

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `circuit_breaker_tripped` | `agent: string; failure_count: number` | An agent reached the failure threshold (default 3) |
| `circuit_breaker_fallback` | `original_agent: string; fallback_agent: string; task_id: string` | A task's agent is in cooldown and a `fallback_agent` is named. The task is skipped all the same |
| `circuit_breaker_blocked` | `agent: string; task_id: string` | A task's agent is in cooldown and no fallback is named; the task is skipped |

### Merge

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `merge_conflict_detected` | `attempt: number; conflicting_files: string[]` | A merge into the convoy branch conflicted. The task re-runs once from the current tip if it has a retry left |
| `merge_failed` | `branch: string; error: string; conflicting_files?: string[]` | The merge did not land; the task fails and its worker branch (`branch`) is kept |

### Gates

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `gate_result` | `command: string; passed: boolean; exit_code: number; scope: 'task' \| 'convoy'; output?: string` | A spec gate ran: a task's own `gates` in its worktree (`scope: task`), or the spec's `gates` once on the merged result (`scope: convoy`, with the last 2,000 characters of output when it failed) |
| `built_in_gate_result` | `gate: string; passed: boolean; output: string; level?: string` | `no_op` (on by default; recorded only when it fails), and, when the spec turns them on under `defaults.built_in_gates`, `secret_scan`, `blast_radius` (with `level`) and `browser_test` per task, and `regression_test` and `dependency_audit` once at the end |

### Contracts & Partitions

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `contract_violation` | `task_id: string; agent: string; missing: string[]; warnings: string[]` | The agent's answer lacks the output summary its role asks for. A warning; the work is kept |
| `partition_violation` | `task_id: string; allowed: string[]; actual: string[]; violations: string[]` | The task changed files outside its `files`. A warning; the work is kept |

### TDD Gate

Only when the spec sets `defaults.built_in_gates.tdd_check`.

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `tdd_check_passed` | `task_id: string; new_source_files: number; existing_test_files: number` | Every new source file has a test |
| `tdd_check_failed` | `task_id: string; missing_test_files: string[]; new_source_files: number` | A new source file has no test; fails the attempt in `mode: block`, the default |
| `tdd_check_skipped` | `task_id: string; reason: string; agent: string` | `reason` is `exempt_agent` (by default `writer` and `researcher`) or `disabled` |

### Artifacts & Agent Memory

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `artifact_limit_reached` | `task_id: string; limit: 50` | A task declared `outputs` and the convoy already holds 50 artifacts |
| `artifacts_extracted` | `task_id: string; count: number; artifacts: Array<{ filename: string; summary?: string }>` | The agent's answer referenced files under `.opencastle/artifacts/<convoy-id>/` |
| `agent_identity_captured` | `agent: string; task_id: string` | A task with `persistent: true` finished; the end of its answer is kept for the agent's next task |
| `agent_identity_rejected` | `agent: string; task_id: string; reason: 'secrets_detected'` | The same, but the summary held a secret, so it was not kept |

### Hooks

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `post_convoy_hook_failed` | `hook: string; error: string` | A spec-level `post_convoy` hook failed |

### Sessions

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `session` | `agent: string; model: string \| null; task: string; outcome: 'success' \| 'failed'; duration_min: number; files_changed: number; retries: number; convoy_id: string` | A task finished, either way |
| `delegation` | `session_id: string; agent: string; model: string \| null; tier: string; mechanism: 'convoy'; outcome: 'success' \| 'failed'; retries: number; phase: number; convoy_id: string` | Beside every `session` |

`opencastle log` writes its own `session` and `delegation` records to the agent
log, `.opencastle/logs/events.ndjson`, not to a convoy's events.

### Security & Reliability

| Event Type | Data Fields | When |
|-----------|-------------|------|
| `secret_leak_prevented` | `task_id?: string; findings_count?: number; patterns: string[]; context: string; original_type?: string` | A secret was found and masked or withheld. `context` is `prompt` (the task was not sent to the agent), `dlq_redacted` or `dlq_dual_write` (a failure record), `dispute_markdown_write`, or `event_redacted` (from `convoy/events.ts`, with `original_type`) |
| `ndjson_write_failed` | `original_type: string` | Writing an event to the NDJSON file failed (from `convoy/events.ts`) |
| `worker_killed` | `reason: 'interrupted'; task_id: string` | Ctrl+C or SIGTERM stopped a running agent session |

## Derived Metrics

Computed from raw events, not emitted directly.

| Metric | Derivation |
|--------|-----------|
| Task duration | `task_done.timestamp` − the task's last `task_started.timestamp` |
| Run duration | the final `convoy_finished` / `convoy_failed` / `convoy_interrupted` − `convoy_started` (a resume adds a `convoy_resumed`) |
| Retry rate | `COUNT(task_retried WHERE reason)` / `COUNT(task_started)` |
| Gate failure rate | failed / all, over `gate_result` and `built_in_gate_result` |
| Review pass rate | `COUNT(review_verdict WHERE verdict='pass')` / (`COUNT(review_verdict)` + `COUNT(review_skipped)`) |
| Tokens | `SUM(task_done.tokens)` + `SUM(review_verdict.tokens)`; the run's total in `convoy.total_tokens` also counts a gate-fix attempt |
| Cost | `SUM(task_done.cost_usd)`; `estimated: true` marks a figure not reported by the runtime |

## Runtime Validation

- `validateEventType(type)` — checks membership in `KNOWN_EVENT_TYPES` (a `Set<string>` exported from [`types.ts`](types.ts)). Unknown types trigger a `console.warn` but do not throw.
- `validateEventData(type, data)` — validates the `data` payload shape for known event types, in [`event-schemas.ts`](event-schemas.ts). Returns `{ valid: boolean; issues?: string[] }`. Invalid payloads trigger a `console.warn` but do not block emission. The schemas allow extra fields, which is how `session`, `delegation` and `dispute_opened` carry theirs.

Both validators are called at emit time in [`events.ts`](events.ts).

## Viewing events

`opencastle convoy dashboard` (experimental) serves a project's runs, tasks and
events from `.opencastle/convoy.db`, read-only through
[`read-model.ts`](read-model.ts). Working on the viewer itself is described in
[CONTRIBUTING.md](../../../CONTRIBUTING.md#the-run-viewer).
