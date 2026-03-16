---
name: team-lead-reference
description: "Reference data for Team Lead orchestration — model routing, pre-delegation checks, cost tracking template, and DLQ format. Load when starting a delegation session."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Team Lead Reference

For the specialist agent registry and model assignments, see [agent-registry.md](../../.opencastle/agents/agent-registry.md).

## Cost-Aware Model Routing

Choose models deliberately based on task complexity. Not every task needs the most expensive model.

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
2. **Downgrade when possible** — If a task is pure docs/config with no reasoning needed, prefer Economy tier
3. **Upgrade for ambiguity** — If the task involves security, architecture decisions, or complex tradeoffs, use Quality/Premium
4. **Never use Premium/Quality for boilerplate** — Writing test scaffolding, updating docs, or config changes should use Economy/Fast/Standard
5. **Parallel sub-agents are cost multipliers** — When firing 3+ parallel sub-agents, prefer Economy/Fast/Standard unless precision is critical

## Complexity-Based Task Scoring

During decomposition, assign a **complexity score** (Fibonacci: 1, 2, 3, 5, 8, 13) to each subtask. The score determines which model tier handles the task.

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

After initial decomposition, **enrich the plan** with concrete codebase evidence before delegating. This prevents agents from wasting time on discovery that the Team Lead can do upfront.

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

After deepening, each subtask in the plan should have:

| Field | Before Deepen | After Deepen |
|-------|--------------|--------------|
| **Files** | "some component" | Exact file path with line range |
| **Pattern** | "follow existing style" | Specific file:line reference to follow |
| **Risks** | unknown | Known issues identified |
| **Lessons** | unchecked | Relevant lessons applied |
| **Dependencies** | assumed | Verified with exact imports |

### Integrating Results

Take the Researcher output and update delegation prompts with concrete file paths, patterns, and lessons. This transforms vague prompts into precise instructions that agents can execute without discovery overhead.

## Agent Output Status Handling

When a sub-agent returns, interpret the result before proceeding to fast review:

- **Complete** — output addresses all acceptance criteria → proceed to fast review
- **Complete with concerns** — agent flagged doubts → read concerns; if about correctness or scope, address before review
- **Needs context** — agent couldn't proceed → provide missing info, re-dispatch same agent
- **Blocked** — agent hit a wall → context problem: provide context; task too complex: upgrade model; plan wrong: escalate to human

Never ignore a BLOCKED or NEEDS_CONTEXT status. If the agent said it's stuck, something must change before re-dispatching.

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
- `tracker` — required even for compact-path delegations (no issue = no delegation)
- `files` — exact file paths in the final delegation envelope (not directory globs); every file the agent may touch must be listed. Directory-level partitions are acceptable during Step 2 planning/ownership mapping — resolve them to exact paths before finalizing this envelope.
- `acceptance_criteria` — copy verbatim from the tracker issue
- `output_contract` — paste the agent’s Base Output Contract (from the observability-logging skill) if available

After completing a feature (all tracker issues Done), add a cost summary to the roadmap update:

```markdown
**Cost Summary:**
| Metric | Value |
|--------|-------|
| Sub-agent delegations | X |
| Background agent delegations | X |
| Panel reviews | X |
| Model tiers used | Premium: X, Standard: X, Utility: X, Economy: X |
| Upgrades/downgrades | [reason if any] |
| Est. total tokens | ~XXK |
```

This data helps optimize future model assignments.

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

1. **Number the dispute** — Increment from the last `DSP-XXX` ID in the Index table
2. **Set priority** — Use the priority guidelines in DISPUTES.md (critical/high/medium/low)
3. **Document both perspectives** — Agent's position AND reviewer's position with specific file/code references
4. **Build attempt history** — List every fast review and panel attempt with one-line verdict summaries
5. **Present resolution options** — At least 2 concrete options with rationale and risk for each
6. **Recommend an action** — Which option the Team Lead thinks is best, with specific next steps
7. **Link artifacts** — Panel reports, review logs, changed files, DLQ entries
8. **Log to events.ndjson** — Use the **observability-logging** skill's dispute record command
9. **Update the tracker issue** — Add the dispute ID and link to the dispute record
10. **Update the Index table** — Add the new dispute to the bottom of the Index

### After Human Resolution

1. Update the dispute `Status` → `resolved` or `deferred`
2. Record which option was chosen and any additional instructions
3. If `resolved` → re-delegate the task with the human's decision as an **explicit constraint**
4. If `deferred` → create a follow-up tracker issue and continue with other work
5. Log the resolution in `events.ndjson` using the **observability-logging** skill's dispute record command


