---
name: observability-logging
description: "Logs sessions, tracks activity, records delegation decisions, and stores review/dispute outcomes as NDJSON audit trails. Use when logging session activity, tracking work, recording decisions, building audit trails, capturing delegation history, or running pre-response verification checklists. Trigger terms: log, track activity, audit trail, session record, delegation log, NDJSON"
---

# Observability Logging

> **⛔ HARD GATE.** Every agent MUST log every session to `events.ndjson` before responding. No exceptions. Session without logs is a failed session.

| File | Event types | Who | When |
|------|------------|-----|------|
| `events.ndjson` | `session`, `delegation`, `review`, `panel`, `dispute` | All agents / Team Lead / Panel runner | After each applicable event |

See `.opencastle/logs/README.md` for full schema.

Use `opencastle log` CLI. One record per task; never batch-log retrospectively.

**Session** (ALL agents, EVERY session):
```sh
opencastle log --type session --agent Developer --model claude-opus-4-6 \
  --task "Fix login redirect bug" --outcome success --duration_min 15 \
  --files_changed 3 --retries 0
```

**Delegation** (Team Lead, after each delegation — never batched):
```sh
opencastle log --type delegation --session_id feat/prj-57 --agent Developer \
  --model claude-sonnet-4-6 --tier quality --mechanism sub-agent \
  --tracker_issue PRJ-57 --outcome success --retries 0 --phase 2 \
  --file_partition "src/components/"
```

> `model` and `tier` must reflect the delegated agent's assignment from the agent registry.

**Review** (Team Lead, after each fast review):
```sh
opencastle log --type review --tracker_issue PRJ-42 --agent Developer \
  --reviewer_model gpt-5-mini --verdict pass --attempt 1 \
  --issues_critical 0 --issues_major 0 --issues_minor 2 \
  --confidence high --escalated false --duration_sec 45
```

**Panel** (Panel runner, after each vote):
```sh
opencastle log --type panel --panel_key auth-review --verdict pass \
  --pass_count 3 --block_count 0 --must_fix 0 --should_fix 3 \
  --reviewer_model claude-opus-4-6 --weighted false --attempt 1 \
  --tracker_issue PRJ-42 --artifacts_count 5
```

**Dispute** (Team Lead, after each dispute):
```sh
opencastle log --type dispute --dispute_id DSP-001 --tracker_issue PRJ-42 \
  --priority high --trigger panel-3x-block --implementing_agent Developer \
  --reviewing_agents "Reviewer,Panel (3x)" --total_attempts 6 --status pending
```

Verify any append: `tail -1 .opencastle/logs/events.ndjson`

## Pre-Response Checklist

**⛔ STOP.** Verify before responding — fix any missing log NOW.

- [ ] **Lessons read** — `.opencastle/LESSONS-LEARNED.md` read at session start
- [ ] **Session logged** — `events.ndjson` has a `session` record (ALWAYS)
- [ ] **Delegations logged** — `delegation` record per delegation (Team Lead) (if applicable)
- [ ] **Reviews logged** — `review` record per fast review (if applicable)

## Base Output Contract

> Inherits: [base-output-contract](../../snippets/base-output-contract.md)
