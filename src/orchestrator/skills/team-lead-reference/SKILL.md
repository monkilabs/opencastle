---
name: team-lead-reference
description: "Reference data for Team Lead orchestration — model routing, pre-delegation checks, cost tracking template, and DLQ format. Load when starting a delegation session."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Team Lead Reference

For the specialist agent registry and model assignments, see [agent-registry.md](../../.opencastle/agents/agent-registry.md).

## Cost-Aware Model Routing

### Model Cost Tiers

| Tier | Cost | Use For |
|------|------|---------|
| **Premium** | $$$$ | Team Lead orchestration, highest-stakes decisions |
| **Quality** | $$$ | Feature implementation, UI/frontend, security audits, architecture, complex reasoning |
| **Standard** | $$ | Large-scale analysis, schema design, cost-efficient coding, repo-level exploration |
| **Fast** | $$ | Terminal-heavy tasks, E2E tests, data pipelines, agentic workflows |
| **Economy** | $ | Documentation, simple config changes, formatting, boilerplate |

### Selection Rules

1. **Default to the agent's assigned model** — the registry maps tasks to appropriate tiers
2. **Downgrade when possible** — pure docs/config → Economy tier
3. **Upgrade for ambiguity** — security, architecture, or complex tradeoffs → Quality/Premium
4. **Never use Premium/Quality for boilerplate** — scaffolding, docs, config → Economy/Fast/Standard
5. **Parallel sub-agents are cost multipliers** — 3+ parallel agents → prefer Economy/Fast/Standard

## Complexity-Based Task Scoring

### Scoring Criteria

| Factor | Low → High |
|--------|------------|
| **Files touched** | 1–2 → 3–5 → 6+ / cross-library |
| **Reasoning depth** | Boilerplate → pattern matching → architecture/security/tradeoffs |
| **Ambiguity** | Clear spec → some judgment → multiple valid approaches |
| **Risk** | Reversible → moderate impact → DB/auth/breaking changes |
| **Dependencies** | None → 1–2 upstream → complex chain |

### Score to Model Tier Mapping

| Score | Tier | Examples |
|-------|------|----------|
| **1-2** | Economy/Fast | Docs update, config tweak, rename, simple test |
| **3-5** | Standard/Quality | Component build, CMS query, API route, migration |
| **8** | Quality | Architecture decision, security audit, complex refactor |
| **13** | Quality + Panel | DB migration with data transform, auth flow redesign |

### Override Rules

- **Blocker tasks** (blocking 2+ downstream tasks): Upgrade one tier regardless of score
- **Security-touching tasks**: Always Quality or higher, regardless of score
- **Pure documentation**: Always Economy, regardless of estimated scope
- The agent registry default model takes precedence unless the task complexity clearly warrants an upgrade/downgrade

## Deepen-Plan Protocol

### When to Deepen

| Plan Complexity | Action |
|----------------|--------|
| 1-2 subtasks, familiar area | Skip — proceed directly to delegation |
| 3-5 subtasks, mixed familiarity | Quick deepen — single Researcher sub-agent |
| 6+ subtasks, unfamiliar area | Full deepen — parallel Researcher sub-agents |

### Quick Deepen (Single Researcher)

Fire one **Researcher** sub-agent asking for: exact file paths & line numbers for changed code, existing patterns to follow (with file:line examples), relevant lessons from `.opencastle/LESSONS-LEARNED.md`, and risks/blockers per subtask.

### Full Deepen (Parallel Researchers)

For large plans, split research by domain and fire parallel Researcher sub-agents. See [agent-registry.md](../../.opencastle/agents/agent-registry.md) for project-specific scope examples.

### What Deepening Produces

| Field | Before Deepen | After Deepen |
|-------|--------------|--------------|
| **Files** | "some component" | Exact file path with line range |
| **Pattern** | "follow existing style" | Specific file:line reference to follow |
| **Risks** | unknown | Known issues identified |
| **Lessons** | unchecked | Relevant lessons applied |
| **Dependencies** | assumed | Verified with exact imports |

## Agent Output Status Handling

- **Complete** — all acceptance criteria addressed → proceed to fast review
- **Complete with concerns** — address correctness/scope concerns before review
- **Needs context** — provide missing info, re-dispatch same agent
- **Blocked** — provide context, upgrade model, or escalate; never re-dispatch unchanged

Never ignore BLOCKED or NEEDS_CONTEXT — something must change before re-dispatching.

## Pre-Delegation Policy Checks

See the Team Lead agent file § Pre-Delegation Checks for the mandatory 5-point checklist (tracker issue, file partition, dependencies, prompt specifics, self-improvement reminder).

**Additional checks for feature work:** (6) Known issues reviewed, (7) Architecture docs read, (8) Existing code searched.

**Additional checks for high-risk work:** (9) Panel review planned, (10) Rollback path identified.

## Compact Delegation Envelope

Use this envelope for every sub-agent delegation — compact path and convoy alike. Fill all fields; omit none.

```json
{
  "tracker": "TAS-XX",
  "agent": "Agent Name",
  "objective": "One sentence: what to do and why.",
  "files": ["path/to/file.ts", "path/to/other.ts"],
  "acceptance_criteria": ["AC 1", "AC 2"],
  "constraints": "Only modify files listed above. Read LESSONS-LEARNED.md before starting.",
  "output_contract": "Return: files changed, lint/type/test pass/fail, discovered issues listed."
}
```

**Rules:**
- `tracker` required (no issue = no delegation); `acceptance_criteria` copy verbatim from tracker.
- `files` = exact paths in the final envelope (not globs; resolve directory partitions before finalizing); `output_contract` = agent’s Base Output Contract.

During execution, maintain a running delegation log in the session checkpoint (see the **session-checkpoints** skill § Delegation Cost Log).

## Context Source Tagging

Prefix each agent's output summary with `### [Agent Name] TAS-XX Description`. Never merge outputs from different agents into a single undifferentiated block. When referencing prior agent output in a delegation prompt, cite the source agent. Always include the Agent column in session checkpoint "Completed Work" tables.

## Dead Letter Queue Format

Log to `.opencastle/AGENT-FAILURES.md` when a delegated agent fails after 2+ attempts, background agent output fails all verification gates, or an unrecoverable error occurs. When a panel BLOCKs 3 times, create a **dispute record** instead (see § Dispute Protocol).

### Failure Entry Format

Each DLQ entry (`DLQ-XXX: Short description`) must include: **Date**, **Agent**, **Tracker Issue**, **Failure Type** (`verification-fail` / `tool-error` / `panel-block` / `timeout` / `scope-creep`), **Attempts**, **Task** (what was asked), **Failure Details** (what went wrong), and **Resolution** (outcome or "pending").

At session start, scan the DLQ for pending retries, failure patterns, and tool issues.

## Error Recovery

For common failure modes and recovery procedures, load the **orchestration-protocols** skill.

## Dispute Protocol

When automated resolution is exhausted (panel 3x BLOCK, approach conflicts, or criteria contradictions), create a **formal dispute record** in `.opencastle/DISPUTES.md`. Inspired by the [Steroids CLI](https://github.com/UnlikeOtherAI/steroids-cli) dispute/escalation pattern.

### When to Create a Dispute (vs. DLQ Entry)

| Scenario | Action |
|----------|--------|
| Tool error, timeout, MCP failure | DLQ entry |
| Scope creep | DLQ entry + redirect |
| Agent fails 2+ times (simple) | DLQ entry |
| Panel BLOCKs 3 times | **Dispute record** |
| Agent and reviewer fundamentally disagree | **Dispute record** |
| Acceptance criteria contradict each other | **Dispute record** |
| Multiple valid approaches, agents can't converge | **Dispute record** |
| Fix requires external/human action | **Dispute record** |

### Dispute Creation Procedure

1. **Number and prioritize** — increment from last `DSP-XXX`; set priority (critical/high/medium/low)
2. **Document perspectives** — agent's and reviewer's positions with specific file/code references
3. **Build attempt history** — list every fast review and panel attempt with one-line verdict summaries
4. **Present and recommend** — at least 2 options with rationale and risk; identify recommended action
5. **Link artifacts** — panel reports, review logs, changed files, DLQ entries
6. **Log and update** — use **observability-logging** dispute record command; add dispute ID to tracker issue and Index table

### After Human Resolution

1. Update the dispute `Status` → `resolved` or `deferred`
2. Record which option was chosen and any additional instructions
3. If `resolved` → re-delegate the task with the human's decision as an **explicit constraint**
4. If `deferred` → create a follow-up tracker issue and continue with other work
5. Log the resolution in `events.ndjson` using the **observability-logging** skill's dispute record command


