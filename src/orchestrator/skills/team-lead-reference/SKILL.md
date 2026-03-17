---
name: team-lead-reference
description: "Reference data for Team Lead orchestration — model routing, pre-delegation checks, cost tracking template, and DLQ format. Load when starting a delegation session."
---

# Team Lead Reference

For the specialist agent registry and model assignments, see [agent-registry.md](../../.opencastle/agents/agent-registry.md).

## Cost-Aware Model Routing

| Tier | Cost | Use For |
|------|------|---------|
| **Premium** | $$$$ | Team Lead orchestration, highest-stakes decisions |
| **Quality** | $$$ | Feature implementation, UI/frontend, security, architecture, complex reasoning |
| **Standard** | $$ | Large-scale analysis, schema design, cost-efficient coding, repo exploration |
| **Fast** | $$ | Terminal-heavy tasks, E2E tests, data pipelines, agentic workflows |
| **Economy** | $ | Docs, simple config, formatting, boilerplate |

**Selection:** Default to agent's assigned tier. Downgrade pure docs/config → Economy. Upgrade security/architecture ambiguity → Quality/Premium. Never Premium/Quality for boilerplate. 3+ parallel agents → prefer Economy/Fast/Standard.

## Complexity-Based Task Scoring

| Factor | Low → High |
|--------|------------|
| **Files touched** | 1–2 → 3–5 → 6+ / cross-library |
| **Reasoning depth** | Boilerplate → pattern matching → architecture/security/tradeoffs |
| **Ambiguity** | Clear spec → some judgment → multiple valid approaches |
| **Risk** | Reversible → moderate impact → DB/auth/breaking |
| **Dependencies** | None → 1–2 upstream → complex chain |

| Score | Tier | Examples |
|-------|------|----------|
| 1–2 | Economy/Fast | Docs update, config tweak, rename, simple test |
| 3–5 | Standard/Quality | Component, CMS query, API route, migration |
| 8 | Quality | Architecture decision, security audit, complex refactor |
| 13 | Quality + Panel | DB migration with data transform, auth flow redesign |

**Overrides:** Blocker (blocking 2+ downstream) → upgrade one tier. Security-touching → Quality+. Pure docs → Economy. Registry default takes precedence unless complexity clearly warrants change.

## Deepen-Plan Protocol

| Plan Complexity | Action |
|----------------|--------|
| 1–2 subtasks, familiar | Skip — delegate directly |
| 3–5 subtasks, mixed | Quick deepen — single Researcher sub-agent |
| 6+ subtasks, unfamiliar | Full deepen — parallel Researcher sub-agents |

**Quick deepen:** Fire one Researcher for exact file paths & line numbers, patterns to follow (file:line examples), relevant lessons from `LESSONS-LEARNED.md`, and risks/blockers per subtask.
**Full deepen:** Split by domain into parallel Researchers. See [agent-registry.md](../../.opencastle/agents/agent-registry.md) for scope examples.

| Field | Before Deepen | After Deepen |
|-------|--------------|------------------|
| **Files** | "some component" | Exact path + line range |
| **Pattern** | "follow existing style" | Specific file:line reference |
| **Risks** | unknown | Known issues identified |
| **Lessons** | unchecked | Relevant lessons applied |
| **Dependencies** | assumed | Verified with exact imports |

## Agent Output Status Handling

| Status | Action |
|--------|--------|
| Complete | All AC addressed → fast review |
| Complete with concerns | Resolve correctness/scope before review |
| Needs context | Provide info, re-dispatch same agent |
| Blocked | Provide context/upgrade model/escalate; never re-dispatch unchanged |

## Pre-Delegation Policy Checks

See Team Lead agent § Pre-Delegation Checks for the mandatory 5-point checklist.
- **Feature work** adds: (6) Known issues reviewed, (7) Architecture docs read, (8) Existing code searched.
- **High-risk work** adds: (9) Panel review planned, (10) Rollback path identified.

## Compact Delegation Envelope

```json
{
  "tracker": "TAS-XX",
  "agent": "Agent Name",
  "objective": "One sentence: what to do and why.",
  "files": ["path/to/file.ts", "path/to/other.ts"],
  "acceptance_criteria": ["AC 1", "AC 2"],
  "constraints": "Only modify listed files. Read LESSONS-LEARNED.md first.",
  "output_contract": "Return: files changed, lint/type/test pass/fail, discovered issues."
}
```

`tracker` required; `acceptance_criteria` verbatim from tracker; `files` = exact resolved paths (not globs); `output_contract` = agent's Base Output Contract. Maintain running delegation log in session checkpoint (see **session-checkpoints** skill).

## Context Source Tagging

Prefix each agent's output summary `### [Agent Name] TAS-XX Description`. Never merge outputs from different agents. Cite source agent when referencing prior output. Include Agent column in checkpoint "Completed Work" tables.

## Dead Letter Queue Format

Log to `.opencastle/AGENT-FAILURES.md` when agent fails 2+ attempts, background output fails all gates, or unrecoverable error occurs. Panel 3x BLOCK → create dispute instead.

Entry (`DLQ-XXX: Short description`): **Date**, **Agent**, **Tracker Issue**, **Failure Type** (`verification-fail` / `tool-error` / `panel-block` / `timeout` / `scope-creep`), **Attempts**, **Task**, **Failure Details**, **Resolution**. Scan DLQ for pending retries at session start.

## Error Recovery

For common failure modes and recovery procedures, load the **orchestration-protocols** skill.

## Dispute Protocol

| Scenario | Action |
|----------|--------|
| Tool error / timeout / MCP failure | DLQ entry |
| Scope creep | DLQ entry + redirect |
| Agent fails 2+ times (simple) | DLQ entry |
| Panel 3x BLOCK / agent-reviewer disagreement / criteria contradictions / no convergence / needs human | Dispute record |

Create in `.opencastle/DISPUTES.md` (inspired by [Steroids CLI](https://github.com/UnlikeOtherAI/steroids-cli)):

1. Number (`DSP-XXX`) and set priority (critical/high/medium/low)
2. Document both perspectives with file/code references
3. Build attempt history with one-line verdict summaries
4. Present ≥2 options with rationale/risk; note recommended action
5. Link panel reports, review logs, changed files, DLQ entries
6. Log with **observability-logging** dispute command; add ID to tracker and Index

**After human resolution:** Set `Status` → `resolved`/`deferred`. Record chosen option. Resolved → re-delegate with decision as explicit constraint. Deferred → create follow-up issue. Log in `events.ndjson`.


