---
name: fast-review
description: "Mandatory post-delegation gate: checks output completeness, verifies acceptance criteria compliance, flags regressions, produces PASS/FAIL verdict. Use when checking delegated work against acceptance criteria, running post-delegation gate, validating agent output before acceptance, verifying sub-agent completed its assignment, or running post-delegation QA check."
---

# Skill: Fast Review

## Contract

| Rule | Detail |
|------|--------|
| Trigger | After **every** delegation — no exceptions |
| Reviewer | Single sub-agent; Economy tier (Standard for premium/security work) |
| Verdict | PASS or FAIL with structured feedback |
| Retry | ≤2 retries on FAIL; 3rd FAIL → panel review |
 

## Procedure

### 1 — Collect Context

Issue + acceptance criteria, file diff, file partition, deterministic results (lint/test/build), agent self-report.

### 2 — Spawn Reviewer

Single `runSubagent`. Context = acceptance criteria, diff, partition, deterministic results **only** — no session history, no delegation prompt.

```js
runSubagent({ agentName: 'Reviewer', prompt: `Review against ACs:\n${criteria}\nDiff:\n${diff}\nGates: lint ✅ test ✅ build ✅` });
```

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

See [REFERENCE.md](REFERENCE.md) for full reviewer prompt template.

## Logging

> **⛔ HARD GATE — Log the review before proceeding.**

```sh
npx opencastle log review --skill <name> --outcome pass|fail --reviewer "Reviewer" --mechanism sub-agent
```

## Integration & Overnight Mode

`on-post-delegate` Gate 5 (after deterministic Gates 1–4), ~5–15% token overhead. Overnight: upgrade one tier, escalate after 2 FAILs, checkpoint before panel.

## Anti-Patterns

- **Skipping fast review** — never, including "trivial" changes.
- **Panel as fast review** — wastes ~3× tokens.
- **Reviewer sees delegation prompt** — evaluate against acceptance criteria only.
- **Ignoring minor issues** — track; 3+ recurrences → ticket.
- **Force-accepting FAIL** — retry or escalate.
- **Skipping deterministic checks** — does NOT replace lint/test/build.
