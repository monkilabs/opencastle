---
name: orchestration-protocols
description: "Runtime orchestration patterns for the Team Lead: parallel research spawning, agent health monitoring, active steering, background agent management, Context Compaction, Agent Circuit Breaker, and escalation paths."
---

# Orchestration Protocols

Runtime patterns for managing delegated agents. **Load at:** Execution phase (Step 4+), when monitoring active agents or spawning parallel work.

## Active Steering

Intervene early when you spot:

| Signal | Action |
|--------|--------|
| Failing tests/builds | Can't resolve dependency or breaks existing code |
| Unexpected file changes | Files outside partition in diff |
| Scope creep | Refactors code not in scope |
| Circular behavior | Same failing approach retried without change |
| Intent misunderstanding | Session log shows wrong prompt interpretation |

When redirecting, explain *why* and *how*:

> "Don't modify `libs/data/src/lib/product.ts` — shared across features. Add the new query in `libs/data/src/lib/reviews.ts`."

**Sub-agents:** Catch problems early (5 min in can save an hour). **Background agents:** Steer post-hoc — invest in prompt specificity and partition constraints upfront.

## Background Agents

Run autonomously in isolated Git worktrees. Reserve for well-scoped tasks >5 min with clear acceptance criteria.

- **Spawn:** Delegate Session → Background → Select agent → Enter prompt
- **Auto-compaction:** At 95% token limit; use `--resume` to continue
- **No real-time monitoring:** Invest in specific prompts, strict partition constraints, and acceptance criteria checklists upfront

## Parallel Research Protocol

Spawn multiple research sub-agents in parallel when 3+ independent questions must be answered before implementation. **Use when:** 3+ independent research questions, broad codebase exploration, or multi-area analysis (frontend/backend/CMS). **Skip when:** single-file investigation, answer in one known location, sequential results, or fewer than 3 questions.

### Spawn Strategy

| Rule | Detail |
|------|--------|
| Divide by topic/area | Each researcher owns a coherent domain |
| Max 3–5 researchers | More creates diminishing returns and token waste |
| Focused scope per agent | Explicit dirs, file patterns, or questions |
| Economy/Standard tier | Manage cost for research sub-agents |

**Prompt template:**
```
Research: [specific question]
Scope: [files/directories to search]
Return: key findings, relevant file paths (with line numbers), patterns, unanswered questions
```

### Result Merge Protocol

1. Collect all results into single context
2. Deduplicate (same file/pattern counts once)
3. Resolve conflicts — specific evidence beats general observations
4. Synthesize into concise context block for implementation prompts

## Batch Reviews

- Group by domain (UI, data); run fast reviews in parallel for independent outputs
- Review sequentially when outputs share the same partition boundary
- Combine related artifacts into one panel question when they share acceptance criteria

## Context Compaction

Summarize prior phase output before passing to the next agent. **Extract:** files changed, key decisions, verification (pass/fail), blockers. **Discard:** raw tool output, reasoning traces, failed attempts.

**Template:**
```
### Prior Phase Output
**Phase [N] — [Agent Name] — [Task Title]**
- Files changed: [list]
- Decisions: [key decisions affecting downstream work]
- Verification: [lint ✅ | types ✅ | tests ✅]
- Blockers: [none | list]
```

## Agent Health Monitoring

### Health Signals

| Signal | Threshold | Recovery |
|--------|-----------|----------|
| **Stuck** — no output/changes | Sub: 5 min / BG: 15 min | Nudge; if frozen, abort + re-delegate with simpler scope |
| **Looping** — same error repeated | 3 consecutive failures | Abort; add context; re-delegate with explicit fix path |
| **Scope creep** — files outside partition | Any | Redirect: "Only modify files in [partition]. Revert [file]." |
| **Context exhaustion** — confused/repetitive | Visible instruction amnesia | Checkpoint, end session, resume in fresh context |
| **Permission loop** — waiting for input | 2+ prompts without progress | Auto-approve if safe; abort + re-delegate |

**Cadence:** Sub-agents — continuous (real-time). Background agents — check at 10 min, then every 10 min. Always review full diff before accepting.

### Escalation Path

1. **Failure 1:** Re-delegate with more specific prompt + error context
2. **Failure 2:** Downscope (split into smaller pieces), re-delegate
3. **Failure 3:** Log to `.opencastle/AGENT-FAILURES.md`; if 3× panel BLOCK or conflict, create dispute in `.opencastle/DISPUTES.md` (see **team-lead-reference** § Dispute Protocol)

## Error Recovery Playbook

| Failure | Symptom | Recovery |
|---------|---------|----------|
| **Retry loop** | Same command fails 3+ times | Abort; identify root cause; re-delegate with explicit fix; log lesson |
| **MCP unavailable** | Tool connection/timeout errors | Check server; retry once; fall back to CLI; log to DLQ if critical |
| **Broken BG output** | Lint/type/test errors on return | Fix inline if small; discard + re-delegate if fundamental; DLQ after 2 fails |
| **Parallel merge conflict** | Two agents modified overlapping files | Accept complex side first; re-delegate simple side to adapt; log lesson |
| **Context exhausted** | Confused/repetitive responses | Checkpoint; end session; resume with checkpoint; reduce parallel work |
| **Post-merge test failure** | Tests pass alone but fail merged | Run affected tests; check import/state conflicts; delegate fix to likely cause |

## Agent Circuit Breaker

| Threshold | Action |
|-----------|--------|
| **2 failures** | Investigate: same error class? Model healthy? Prompt pattern? |
| **3 failures** | Open circuit — stop delegating; reassign or escalate to user |
| **Next session** | Half-open — resets; re-open + add lesson if fails again |

Judgment-based, not a hard gate. 3 similar failures with the same error is more concerning than 3 unrelated failures.
