---
name: agent-hooks
description: "Four lifecycle hooks every agent runs: on-session-start scans LESSONS-LEARNED.md, resumes checkpoints; on-pre-delegate verifies tracker issues, file partitions; on-post-delegate runs fast-review, CI checks; on-session-end executes session guard, writes logs. Use when starting a new session, running pre-flight checks before delegation, coordinating between agents, reviewing a completed handoff, or wrapping up a session. Trigger terms: multi-agent setup, delegate tasks, agent coordination, session management, run pre-flight checks, start a new session, coordinate between agents, wrap up session"
---

# Agent Lifecycle Hooks

Conventions (not auto-triggers) agents execute at specific lifecycle points. Team Lead includes hook reminders in delegation prompts; specialists follow them in their own workflow.

```
on-session-start → [work loop] → on-session-end
                        ↓   ↑
               on-pre-delegate → on-post-delegate
```

---


## on-session-start

| # | Action |
|---|--------|
| 1 | `rg -n "keyword" .opencastle/LESSONS-LEARNED.md` |
| 2 | `cat .opencastle/SESSION-CHECKPOINT.md` (resume if exists) |
| 3 | `rg -n "ERROR\|FAIL" .opencastle/AGENT-FAILURES.md \|\| true` |
| 4 | `cat .opencastle/agents/skill-matrix.json \| jq '.bindings'` — load domain skills |

See [HOOKS-REFERENCE.md](HOOKS-REFERENCE.md) for extended startup checks (approval polling, skill-matrix verification).

---

## on-session-end

> **⛔ HARD GATE** — See [logging-mandatory](../../snippets/logging-mandatory.md). Load **observability-logging** for the Pre-Response Quality Gate.

| # | Action |
|---|--------|
| 1 | `opencastle doctor --fix` (session guard) |
| 2 | `opencastle log --type session ...` |
| 3 | Write `.opencastle/SESSION-CHECKPOINT.md` if work is incomplete |
| 4 | Flag for memory merge if 5+ new lessons |

---

## on-pre-delegate — Team Lead only

| # | Check |
|---|-------|
| 1 | Tracker issue exists (`gh issue view TAS-XX`) |
| 2 | File partition clean (`comm -12 <(sort agent1-files) <(sort agent2-files)` = empty) |
| 3 | Upstream deps Done (`gh issue view TAS-XX --json state -q '.state'` = CLOSED) |
| 4 | Prompt has exact file paths + acceptance criteria |
| 5 | Prompt includes "Read LESSONS-LEARNED.md first" |
| 6 | 5+ files → load **context-map** skill |

All 6 must pass before `runSubagent`. See [HOOKS-REFERENCE.md](HOOKS-REFERENCE.md) for example commands per check.

## on-post-delegate — Team Lead only

| # | Action |
|---|--------|
| 1 | **⛔** `opencastle log --type=delegation --issue=TAS-XX --status=complete` |
| 2 | Run **fast-review** skill |
| 3 | `pnpm lint && pnpm typecheck && pnpm test` |
| 4 | `gh issue view TAS-XX --json body -q '.body'` — verify each AC met |
| 5 | If agent retried → verify lesson added via **self-improvement** |
| 6 | Move to Done or re-delegate; 3rd failure → `.opencastle/AGENT-FAILURES.md` |

See [HOOKS-REFERENCE.md](HOOKS-REFERENCE.md) for detailed verification commands.

---

## Anti-Patterns

| Anti-pattern | Impact |
|---|---|
| Batch-logging retrospectively | Loses per-task provenance |
| Partial post-delegate checks | False positives — build passes but ACs fail |
