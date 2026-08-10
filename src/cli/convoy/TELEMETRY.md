# Convoy Telemetry Model

How Convoy concepts map to [OpenTelemetry](https://opentelemetry.io/) semantics.

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

- **Primary**: SQLite (`convoy.db`) — durable, queryable, crash-safe
- **Supplementary**: NDJSON (`convoy-events.ndjson`) — append-only log for streaming/grep

SQLite is the source of truth. NDJSON is replayed from SQLite on crash recovery via `recoverNdjson()`.

### Write Strategy (v1)

NDJSON writes use synchronous `appendFileSync` + `fsyncSync` per event. This ensures crash-safety — every event is durable before the engine proceeds. Trade-offs:

- **Latency**: ~1-2ms per event (sync I/O). For convoys with <10,000 events this is negligible.
- **Throughput**: Not suitable for >10,000 events/second workloads.
- **Crash-safety**: Every event is fsynced before the engine continues, so a crash never loses the last event.

An async buffered writer is deferred as an optimization for Phase 5 if profiling shows sync writes become a bottleneck.

## Event Type Reference

All 39 canonical event types emitted by the convoy engine.

### Convoy Lifecycle

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `convoy_started` | engine.ts | `name?: string` |
| `convoy_finished` | engine.ts | `status: string` |
| `convoy_failed` | engine.ts | `status: string; reason?: string` |
| `convoy_guard` | engine.ts | `checks?: string[]` |

### Task Lifecycle

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `task_started` | engine.ts | `worker_id?: string` |
| `task_done` | engine.ts | `status?: string; retries?: number; worker_id?: string` |
| `task_failed` | engine.ts | `reason: string; worker_id?: string; gate?: string; hook?: string` |
| `task_skipped` | engine.ts | `reason: string` |
| `task_retried` | engine.ts | `previous_status: string` |
| `task_waiting_input` | engine.ts | `task_id?: string; reason?: string` |

### Review & Disputes

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `review_started` | engine.ts | `level: string; task_id?: string; model?: string` |
| `review_verdict` | engine.ts | `level: string; verdict: string; tokens: number; model?: string; feedback_length?: number; budget_exceeded?: boolean; budget_downgrade?: boolean; budget_skip?: boolean; passes?: number; blocks?: number` |
| `dispute_opened` | engine.ts | `dispute_id: string; task_id: string; agent?: string; reason?: string` |
| `dlq_entry_created` | engine.ts | `dlq_id: string; task_id: string; agent?: string; attempts?: number` |

### Drift Detection

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `drift_check_result` | engine.ts | `score?: number; threshold?: number; passed?: boolean` |
| `drift_detected` | engine.ts | `score?: number; files?: string[]` |

### Circuit Breaker

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `circuit_breaker_tripped` | engine.ts | `agent?: string; failure_count?: number; threshold?: number` |
| `circuit_breaker_fallback` | engine.ts | `original_agent?: string; fallback_agent?: string; task_id?: string` |
| `circuit_breaker_blocked` | engine.ts | `agent?: string; task_id?: string` |

### Merge & Worktree

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `merge_conflict_detected` | engine.ts | `task_id?: string; files?: string[]` |
| `merge_conflict_failed` | engine.ts | `task_id?: string; error?: string` |

### Artifacts & Injection

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `file_injection_received` | engine.ts | `task_id?: string; from_task?: string; name?: string` |
| `artifact_limit_reached` | engine.ts | `task_id?: string; limit?: number; current?: number` |

### Agent Intelligence

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `agent_identity_captured` | engine.ts | `agent?: string; task_id?: string` |
| `agent_identity_rejected` | engine.ts | `agent?: string; task_id?: string; reason?: string` |
| `swarm_concurrency_update` | engine.ts | `new_concurrency?: number; reason?: string` |

### Hooks

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `post_convoy_hook_failed` | engine.ts | `hook?: string; error?: string` |

### Observability / Session

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `session` | engine.ts | `agent?: string; model?: string; task?: string; outcome?: string; duration_min?: number` |
| `delegation` | engine.ts | `agent?: string; model?: string; tier?: string; mechanism?: string; outcome?: string` |

### Security & Reliability

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `secret_leak_prevented` | engine.ts, events.ts | `original_type?: string; patterns?: string[]; task_id?: string; findings_count?: number; context?: string` |
| `ndjson_write_failed` | events.ts | `original_type?: string` |

### Built-in Gates

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `built_in_gate_result` | engine.ts | `gate: string; passed: boolean; output?: string; level?: string` |

### Watch Mode

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `watch_started` | watch.ts | `trigger_type?: string; pid?: number` |
| `watch_cycle_start` | watch.ts | `cycle_number?: number; triggered_by?: string` |
| `watch_cycle_end` | watch.ts | `cycle_number?: number; status?: string` |
| `watch_stopped` | watch.ts | `reason?: string` |

### Worker Health

| Event Type | Source | Data Fields |
|-----------|--------|-------------|
| `worker_killed` | health.ts | `reason?: string; worker_id?: string; task_id?: string` |

### Discovered Issues

| Event Type | Source | Data Fields |
|-----------|--------|-------------|

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

## Dashboard Build Pipeline

To build the dashboard with real convoy data:

```sh
# 1. Run ETL to extract data from SQLite → JSON
npm run dashboard:etl

# 2. Build the Astro dashboard (reads from public/data/*.json)
npx astro build --root src/dashboard

# 3. Serve locally (optional)
npx astro preview --root src/dashboard
```

In CI, add these steps after tests pass:

```yaml
- run: npm run dashboard:etl
- run: npx astro build --root src/dashboard
```

The ETL script gracefully handles missing databases — it produces empty JSON files so the dashboard renders an empty state instead of crashing.
