# Convex Performance Audit

Diagnose and fix performance problems in Convex applications, one problem class at a time.

## First Step: Gather Signals

1. Run `npx convex insights --details` (use `--prod`, `--preview-name`, or `--deployment-name` as needed)
2. If CLI is too old: `npx -y convex@latest insights --details`
3. If runtime signals unavailable, audit from code — but keep guardrails: don't recommend structural work without a measured signal

## Signal Routing

After gathering signals, identify the problem class and read the matching reference file:

| Signal | Reference |
|--------|-----------|
| High bytes or documents read, JS filtering, unnecessary joins | `references/hot-path-rules.md` |
| OCC conflict errors, write contention, mutation retries | `references/occ-conflicts.md` |
| High subscription count, slow UI updates, excessive re-renders | `references/subscription-cost.md` |
| Function timeouts, transaction size errors, large payloads | `references/function-budget.md` |
| General "it's slow" with no specific signal | Start with `references/hot-path-rules.md` |

Multiple problem classes can overlap. Read the most relevant reference first.

## Workflow

### 1. Scope the problem

Pick one concrete user flow. Write down:
- Entrypoint functions
- Client callsites (`useQuery`, `usePaginatedQuery`, `useMutation`)
- Tables read and tables written
- Whether the path is high-read, high-write, or both

### 2. Trace the full read and write set

For each function:
1. Trace every `ctx.db.get()` and `ctx.db.query()`
2. Trace every `ctx.db.patch()`, `ctx.db.replace()`, `ctx.db.insert()`
3. Note foreign-key lookups, JS-side filtering, and full-document reads
4. Identify sibling functions touching the same tables
5. Identify reactive stats/aggregates on the same page

### 3. Apply fixes from the relevant reference

Read the reference file matching your problem class. Each reference includes specific patterns and a recommended fix order.

Do not stop at the single function named by an insight. Trace sibling readers and writers touching the same tables.

### 4. Fix sibling functions together

When one function has a bug, audit sibling functions for the same pattern. If one list query switches to a digest table, inspect the other list queries for that table. If one mutation needs no-op write protection, inspect all other writers to the same table.

### 5. Escalate invasive fixes

If the fix is invasive, cross-cutting, or migration-heavy:
- Introducing digest or summary tables across multiple flows
- Splitting documents to isolate frequently-updated fields
- Reworking pagination strategy across several screens
- Switching to a new index that needs migration-safe rollout

Stop and present options before editing. Consult `references/migrations.md` when correctness depends on handling old and new states during rollout.

### 6. Verify

Confirm:
1. Results are the same as before — no dropped records
2. Eliminated reads/writes are no longer in the hot path
3. Fallback behavior works when denormalized/indexed fields are missing
4. No unnecessary invalidation when data is unchanged
5. Every relevant sibling reader and writer was inspected

## Reference Files

- `references/hot-path-rules.md` — Read amplification, invalidation, denormalization, indexes, digest tables
- `references/occ-conflicts.md` — Write contention, OCC resolution, hot document splitting
- `references/subscription-cost.md` — Reactive query cost, subscription granularity, point-in-time reads
- `references/function-budget.md` — Execution limits, transaction size, large documents, payload size

Also see [Convex Best Practices](https://docs.convex.dev/understanding/best-practices/).
