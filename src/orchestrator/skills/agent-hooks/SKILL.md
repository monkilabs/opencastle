---
name: agent-hooks
description: "Checklists every agent runs at session start and session end, plus the Team Lead's pre- and post-delegation checks. Use when starting, resuming or wrapping up a session."
---

# Agent Lifecycle Hooks

Conventions (not auto-triggers) agents execute at specific lifecycle points. Team Lead includes hook reminders in delegation prompts; specialists follow them in their own workflow.

```
on-session-start → [work loop] → on-session-end
                        ↓   ↑
               on-pre-delegate → on-post-delegate
```

The tracker is the project's own: its skill (Linear, Jira, Trello) or `gh issue` for GitHub Issues.

---


## on-session-start

| # | Action |
|---|--------|
| 1 | Read `.opencastle/LESSONS-LEARNED.md`, then `rg -n "keyword" .opencastle/lessons/` |
| 2 | `cat .opencastle/SESSION-CHECKPOINT.md` (resume if exists) |
| 3 | `rg -n "ERROR\|FAIL" .opencastle/AGENT-FAILURES.md \|\| true` |
| 4 | `cat .opencastle/agents/skill-matrix.json \| jq '.bindings'` — load domain skills |

See [HOOKS-REFERENCE.md](HOOKS-REFERENCE.md) for extended startup checks (approval polling, skill-matrix verification).

---

## on-session-end

> **HARD GATE** — every session gets a record in `.opencastle/logs/events.ndjson`,
> written before you yield, one per task, never batched retrospectively. Load
> **observability-logging** for the Pre-Response Quality Gate.

| # | Action |
|---|--------|
| 1 | `opencastle doctor` |
| 2 | `opencastle log --type session ...` |
| 3 | Write `.opencastle/SESSION-CHECKPOINT.md` if work is incomplete |
| 4 | More than 50 lessons in `.opencastle/lessons/` → flag a **memory-merger** pass |

---

## on-pre-delegate — Team Lead only

| # | Check |
|---|-------|
| 1 | Tracker issue exists for the task |
| 2 | File partition clean (`comm -12 <(sort agent1-files) <(sort agent2-files)` = empty) |
| 3 | Upstream issues are Done in the tracker |
| 4 | Prompt has exact file paths + acceptance criteria |
| 5 | Prompt includes "Read LESSONS-LEARNED.md first" |
| 6 | 5+ files → load **context-map** skill |

All 6 must pass before the sub-agent is dispatched. See [HOOKS-REFERENCE.md](HOOKS-REFERENCE.md) for example commands per check.

## on-post-delegate — Team Lead only

| # | Action |
|---|--------|
| 1 | **⛔** `opencastle log --type delegation …` (the record in **observability-logging**) |
| 2 | Run **fast-review** skill |
| 3 | Lint, typecheck, and test (commands via the **codebase-tool** slot) |
| 4 | Verify each acceptance criterion on the tracker issue is met |
| 5 | If agent retried → verify lesson added via **self-improvement** |
| 6 | Move the issue to Done in the tracker, or follow **fast-review**'s Handle Verdict table |

See [HOOKS-REFERENCE.md](HOOKS-REFERENCE.md) for detailed verification commands.

---

## Anti-Patterns

- Batch-logging retrospectively — loses per-task provenance.
- Running only part of on-post-delegate — build passes while ACs fail.
