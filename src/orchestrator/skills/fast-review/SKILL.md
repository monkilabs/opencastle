````skill
---
name: fast-review
description: "Mandatory single-reviewer gate that runs after every agent delegation. Provides automatic retry with feedback and escalation to panel review after repeated failures. Essential for overnight/long-running autonomous sessions."
---

# Skill: Fast Review

## Contract

| Rule | Detail |
|------|--------|
| Trigger | After **every** delegation — no exceptions |
| Reviewer | Single sub-agent; Economy tier (Standard for premium/security work) |
| Verdict | PASS or FAIL with structured feedback |
| Retry | ≤2 retries on FAIL; 3rd FAIL → panel review |
| Budget | ~2–5 min |

## Procedure

### 1 — Collect Context

Issue + acceptance criteria, file diff, file partition, deterministic results (lint/test/build), agent self-report.

### 2 — Spawn Reviewer

Single `runSubagent`. Context = acceptance criteria, diff, partition, deterministic results **only** — no session history, no delegation prompt.

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
| FAIL 1–2 | Log; re-delegate same agent: "Retry N/2 — address listed issues" |
| FAIL 3 | Log `escalated: true`; load **panel-majority-vote** skill |
| Panel BLOCK ×3 | Dispute in `.opencastle/DISPUTES.md` (see **team-lead-reference** § Dispute Protocol) |

## Reviewer Prompt Template

```markdown
You are a code reviewer. Be concise and specific.

## Task: [ID] — [Title]
Acceptance Criteria: [list]

## File Partition: [allowed dirs/files]
## Changed Files: [path + key diff]
## Deterministic: Lint: [P/F] | Tests: [P/F] | Build: [P/F]

## Checklist
1. Acceptance criteria met?
2. Partition respected?
3. No regressions?
4. Errors surfaced (no swallowed exceptions)?
5. Type safety (no `as any`)?
6. No secrets/injection vectors?
7. Edge cases handled?

## Prior Feedback (retry only): [previous FAIL]

VERDICT: PASS | FAIL
ISSUES: - [severity:critical|major|minor] Description
FEEDBACK: [Actionable feedback.]
CONFIDENCE: low | medium | high
```

## Logging

> **⛔ HARD GATE — Log the review before proceeding.** Use **observability-logging** skill's review record command.

## Integration & Overnight Mode

`on-post-delegate` Gate 5 (after deterministic Gates 1–4), ~5–15% token overhead. Overnight: upgrade one tier, escalate after 2 FAILs, checkpoint before panel.

## Anti-Patterns

- **Skipping fast review** — never, including "trivial" changes.
- **Panel as fast review** — wastes ~3× tokens.
- **Reviewer sees delegation prompt** — evaluate against acceptance criteria only.
- **Ignoring minor issues** — track; 3+ recurrences → ticket.
- **Force-accepting FAIL** — retry or escalate.
- **Skipping deterministic checks** — does NOT replace lint/test/build.

````
