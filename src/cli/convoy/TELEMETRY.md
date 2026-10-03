# Convoy Telemetry Model

The events the convoy engine (experimental) records, and how its concepts map
to [OpenTelemetry](https://opentelemetry.io/) semantics. OpenCastle does not
export OpenTelemetry; the mapping is for anyone writing an exporter.

## Conceptual Mapping

| Convoy Concept | OTel Concept | ID Field | Description |
|---------------|-------------|----------|-------------|
| **Convoy** | Trace | `convoy_id` → `trace_id` | A single execution run of a `.convoy.yml` spec |
| **Task** | Span | `task_id` → `span_id` | One unit of work within a convoy |
| **TaskStep** | Sub-span | `step_index` | Sequential steps within a multi-step task |
| **Event** | Log / SpanEvent | `type` | Structured occurrence during execution |
| **Metrics** | Derived aggregates | — | Computed from events (tokens, cost, duration) |

### ID Correlation

```
trace_id  = convoy_id   (globally unique, set at convoy creation)
span_id   = task_id      (unique within convoy, from spec)
worker_id = worker trace (ephemeral, tied to adapter process)
```

Every event carries `convoy_id`, `task_id`, and `worker_id` (all nullable) to enable correlation across the trace hierarchy.

## Storage

- **Primary**: SQLite (`.opencastle/convoy.db`) — durable, queryable, crash-safe
- **Supplementary**: NDJSON, one file per convoy (`.opencastle/logs/convoys/<convoy-id>.ndjson`) — append-only log for streaming/grep

SQLite is the source of truth. On resume, `recoverNdjson()` truncates a partial last line and replays the SQLite events missing from the NDJSON file.

These are separate from the agent log, `.opencastle/logs/events.ndjson`, which `opencastle log` appends to ([schema](../../orchestrator/customizations/logs/README.md)).

### Write Strategy (v1)

NDJSON writes use synchronous `appendFileSync` + `fsyncSync` per event. This ensures crash-safety — every event is durable before the engine proceeds. Trade-offs:

- **Latency**: ~1-2ms per event (sync I/O). For convoys with <10,000 events this is negligible.
- **Throughput**: Not suitable for >10,000 events/second workloads.
- **Crash-safety**: Every event is fsynced before the engine continues, so a crash never loses the last event.

An async buffered writer is deferred until profiling shows sync writes are a bottleneck.

## Event Type Reference

All 39 canonical event types in `KNOWN_EVENT_TYPES` ([`types.ts`](types.ts)). Sources are relative to `src/cli/`.

### Convoy Lifecycle

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `convoy_started` | convoy/engine.ts | `name?: string; branch?: string; base?: string \| null; concurrency?: number` |
| `convoy_finished` | convoy/engine.ts | `status: string` |
| `convoy_failed` | convoy/engine.ts | `status: string; reason?: string` |
| `convoy_guard` | convoy/engine.ts | `checks?: string[]` |
| `convoy_resumed` | convoy/engine.ts | `original_created_at?: string; reset?: string[]` |
| `convoy_interrupted` | convoy/engine.ts | `signal?: string; requeued?: string[]` |

### Task Lifecycle

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `task_started` | convoy/engine.ts | `worker_id?: string` |
| `task_done` | convoy/engine.ts | `status?: string; retries?: number; worker_id?: string` |
| `task_failed` | convoy/engine.ts | `reason: string; worker_id?: string; gate?: string; hook?: string` |
| `task_skipped` | convoy/engine.ts | `reason: string` |
| `task_retried` | convoy/engine.ts | `previous_status: string` |
| `task_merged` | convoy/engine.ts | `branch?: string; files?: number` |

### Review & Disputes

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `review_started` | convoy/engine.ts | `level: string; task_id?: string; model?: string` |
| `review_verdict` | convoy/engine.ts | `level: string; verdict: string; tokens: number; model?: string; feedback_length?: number; budget_exceeded?: boolean; budget_downgrade?: boolean; budget_skip?: boolean; passes?: number; blocks?: number` |
| `review_skipped` | convoy/engine.ts | `level: string; reason: string` — a review was due and reached no verdict; never recorded as a pass |
| `dispute_opened` | convoy/engine.ts | `dispute_id: string; task_id: string; agent?: string; reason?: string` |
| `dlq_entry_created` | convoy/engine.ts | `dlq_id: string; task_id: string; agent?: string; attempts?: number` |

### Circuit Breaker

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `circuit_breaker_tripped` | convoy/engine.ts | `agent?: string; failure_count?: number; threshold?: number` |
| `circuit_breaker_fallback` | convoy/engine.ts | `original_agent?: string; fallback_agent?: string; task_id?: string` |
| `circuit_breaker_blocked` | convoy/engine.ts | `agent?: string; task_id?: string` |

### Merge & Worktree

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `merge_conflict_detected` | convoy/engine.ts | `task_id?: string; files?: string[]` |
| `merge_failed` | convoy/engine.ts | `branch: string; error: string; conflicting_files?: string[]` — the task fails and its branch is kept |

### Artifacts

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `artifact_limit_reached` | convoy/engine.ts | `task_id?: string; limit?: number; current?: number` |
| `artifacts_extracted` | convoy/engine.ts | `task_id?: string; count?: number; artifacts?: Array<{ filename: string; summary?: string }>` |

### Agent Intelligence

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `agent_identity_captured` | convoy/engine.ts | `agent?: string; task_id?: string` |
| `agent_identity_rejected` | convoy/engine.ts | `agent?: string; task_id?: string; reason?: string` |

### Hooks

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `post_convoy_hook_failed` | convoy/engine.ts | `hook?: string; error?: string` |

### Observability / Session

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `session` | convoy/engine.ts | `agent?: string; model?: string; task?: string; outcome?: string; duration_min?: number` |
| `delegation` | convoy/engine.ts | `agent?: string; model?: string; tier?: string; mechanism?: string; outcome?: string` |

`opencastle log` writes `session` and `delegation` records to the agent log, `.opencastle/logs/events.ndjson`, rather than to a convoy's events.

### Security & Reliability

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `secret_leak_prevented` | convoy/engine.ts, convoy/events.ts | `original_type?: string; patterns?: string[]; task_id?: string; findings_count?: number; context?: string` |
| `ndjson_write_failed` | convoy/events.ts | `original_type?: string` |

### Gates

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `gate_result` | convoy/engine.ts | `command: string; passed: boolean; exit_code?: number; scope?: string; output?: string` — a spec gate, per task (`scope: task`) or once after the tasks (`scope: convoy`) |
| `built_in_gate_result` | convoy/engine.ts | `gate: string; passed: boolean; output?: string; level?: string` |

### Worker Health

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `worker_killed` | convoy/engine.ts | `reason?: string; worker_id?: string; task_id?: string` |

### Contracts & Partitions

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `contract_violation` | convoy/engine.ts | `task_id?: string; agent?: string; missing?: string[]; warnings?: string[]` |
| `partition_violation` | convoy/engine.ts | `task_id?: string; allowed?: string[]; actual?: string[]; violations?: string[]` |

### TDD Gate

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `tdd_check_passed` | convoy/engine.ts | `task_id?: string; new_source_files?: number; existing_test_files?: number` |
| `tdd_check_failed` | convoy/engine.ts | `task_id?: string; missing_test_files?: string[]; new_source_files?: number` |
| `tdd_check_skipped` | convoy/engine.ts | `task_id?: string; reason?: string; agent?: string` |

## Derived Metrics

These are computed from raw events, not emitted directly.

| Metric | Derivation |
|--------|-----------|
| Task duration | `task_done.timestamp - task_started.timestamp` |
| Convoy duration | `convoy_finished.timestamp - convoy_started.timestamp` |
| Retry rate | `COUNT(task_retried) / COUNT(task_started)` |
| Gate failure rate | `COUNT(built_in_gate_result WHERE !passed) / COUNT(built_in_gate_result)` |
| Review pass rate | `COUNT(review_verdict WHERE verdict='pass') / COUNT(review_verdict)` |
| Token usage | `SUM(review_verdict.tokens)` per convoy |
| Circuit breaker trips | `COUNT(circuit_breaker_tripped)` per agent |

## Runtime Validation

- `validateEventType(type)` — checks membership in `KNOWN_EVENT_TYPES` (a `Set<string>` exported from [`types.ts`](types.ts)). Unknown types trigger a `console.warn` but do not throw, preserving extensibility for custom event types.
- `validateEventData(type, data)` — validates the `data` payload shape for known event types. Defined in [`event-schemas.ts`](event-schemas.ts). Returns `{ valid: boolean; issues?: string[] }`. Invalid payloads trigger a `console.warn` but do not block emission.

Both validators are called at emit time in [`events.ts`](events.ts).

## Viewing events

`opencastle convoy dashboard` (experimental) serves a project's runs from
`.opencastle/convoy.db`. Building the dashboard itself from the demo database is
described in [CONTRIBUTING.md](../../../CONTRIBUTING.md#the-dashboard).
