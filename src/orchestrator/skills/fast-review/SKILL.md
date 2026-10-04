---
name: fast-review
description: "Mandatory single-reviewer PASS/FAIL gate on delegated work, and the retry and escalation ladder every skill follows. Use after a delegation returns, before accepting its output."
---

# Skill: Fast Review

## Contract

| Rule | Detail |
|------|--------|
| Trigger | After **every** delegation — no exceptions |
| Reviewer | Single sub-agent; Economy tier (Standard for premium/security work) |
| Verdict | PASS or FAIL with structured feedback |
| Retry & escalation | The Handle Verdict table below, the one ladder every skill refers to |

## Procedure

### 1 — Collect Context

Issue + acceptance criteria, file diff, file partition, deterministic results (lint/test/build), agent self-report.

### 2 — Spawn Reviewer

One sub-agent, dispatched as the Reviewer. Context = acceptance criteria, diff, partition, deterministic results **only** — no session history, no delegation prompt.

```
Agent: Reviewer
Review against these acceptance criteria:
[criteria]
Diff:
[diff]
Deterministic gates: lint ✅ test ✅ build ✅
```

Full reviewer prompt template: [REFERENCE.md](REFERENCE.md).

### 3 — Parse Verdict

```
VERDICT: PASS | FAIL
ISSUES:
- [severity:critical|major|minor] Description
FEEDBACK: Actionable feedback.
CONFIDENCE: low | medium | high
```

- **PASS** — no critical/major issues (minor noted, non-blocking).
- **FAIL** — any critical/major issue, or output format mismatch.

**Auto-PASS** (skip reviewer): pure research/no code changes; docs-only `.md` changes; ≤10 lines across ≤2 non-sensitive files with all deterministic gates passing.

> **Sensitive override:** Auth/middleware, DB migrations, RLS policies, security headers, CSP, env var schemas, CI/CD config always require review — even 1-line changes.

### 4 — Handle Verdict

| Outcome | Action |
|---------|--------|
| PASS | Log review; continue |
| FAIL 1–2 | Re-delegate same agent with the reviewer's feedback: "Retry N/2 — address listed issues" |
| FAIL 3 | Load **panel-majority-vote** skill |
| Panel BLOCK ×3 | Dispute in `.opencastle/DISPUTES.md` (see **team-lead-reference** § Dispute Protocol) |
| Tool/runtime failure ×2 (crash, timeout, empty or off-topic output) | Entry in `.opencastle/AGENT-FAILURES.md` (see **team-lead-reference** § Dead Letter Queue Format) |

## Integration & Overnight Mode

`on-post-delegate` Gate 5 (after deterministic Gates 1–4), ~5–15% token overhead. Overnight: upgrade one tier, checkpoint before panel.

## Anti-Patterns

- **Panel as fast review** — wastes ~3× tokens.
- **Reviewer sees delegation prompt** — evaluate against acceptance criteria only.
- **Ignoring minor issues** — track; 3+ recurrences → ticket.
- **Force-accepting FAIL** — retry or escalate.
- **Skipping deterministic checks** — does NOT replace lint/test/build.
