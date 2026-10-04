---
name: orchestration-protocols
description: "Runtime patterns for running agents in parallel: steering, background agents, parallel research, health signals, circuit breakers and convoy runs. Use when agents run in parallel, stall, loop or fail repeatedly."
---

# Orchestration Protocols

Runtime patterns for delegated agents.

## Active Steering

Intervene early on:

| Signal | Action |
|--------|--------|
| Failing tests/builds | Check dependency resolution; revert if builds break |
| Unexpected file changes | Revert; enforce partition |
| Scope creep | Redirect to scoped files only |
| Circular behavior | Halt; switch approach |
| Intent misunderstanding | Clarify prompt; re-delegate |

When redirecting, state *why* + *how*:

> "Don't modify `libs/data/src/lib/product.ts` — shared across features. Add the new query in `libs/data/src/lib/reviews.ts`."

**Sub-agents:** steer live, at the first off-course tool call or file edit. **Background agents:** no live steering — front-load prompt specificity, partition constraints, acceptance criteria checklists.

## Background Agents

Run autonomously in isolated Git worktrees. Reserve for well-scoped tasks with clear acceptance criteria that need no decisions from you mid-run.

- **Spawn:** start a background agent with whatever the assistant offers (a background or cloud agent, a worktree session)
- **Interrupted convoy:** `opencastle convoy resume` picks up where the run stopped

## Parallel Research Protocol

**Spawn parallel research sub-agents if:** ≥3 independent questions AND answers span multiple codebase areas — else handle sequentially.

### Spawn Strategy

| Rule | Detail |
|------|--------|
| Divide by topic/area | Each researcher owns a coherent domain |
| Max 3–5 researchers | More: diminishing returns, token waste |
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
2. **Checkpoint:** verify every researcher returned a result (no timeout/error); re-run failures before proceeding.
3. Deduplicate (same file/pattern counts once)
4. Resolve conflicts — specific evidence beats general observations
5. Synthesize into concise context block for implementation prompts
6. **Checkpoint:** confirm synthesized block covers every original question; mark unanswered as blockers.

## Batch Reviews

- Group by domain (UI, data); run fast reviews in parallel for independent outputs
- Review sequentially when outputs share partition boundary
- Combine related artifacts into one panel question when sharing acceptance criteria

## Context Compaction

Summarize prior phase output before passing to next agent. **Extract:** files changed, key decisions, verification (pass/fail), blockers. **Discard:** raw tool output, reasoning traces, failed attempts.

**Template:**
```
### Prior Phase Output
**Phase [N] — [Agent Name] — [Task Title]**
- Files changed: [list]
- Decisions: [key decisions affecting downstream work]
- Verification: [lint ✅ | types ✅ | tests ✅]
- Blockers: [none | list]
```

## Health & Recovery Reference

Health thresholds, escalation path, Error Recovery Playbook, Circuit Breaker: see [REFERENCE.md](./REFERENCE.md).

## CLI (spawn & monitor)

Use OpenCastle CLI (`npx opencastle` or `bin/cli.mjs`):

```bash
opencastle convoy run convoy.yml --dry-run   # check the spec, start nothing
opencastle convoy run convoy.yml --verbose
opencastle convoy                            # the last run and the one next step
opencastle convoy resume                     # re-run what is not done
opencastle convoy dashboard                  # watch it live
```

**Post-run verification (copy-paste checks):**

Convoy records to `.opencastle/convoy.db` and `.opencastle/logs/`; there is no
plain-text run log to tail.

```bash
opencastle convoy --json          # last run's status, machine-readable
tail -n 50 .opencastle/logs/events.ndjson | jq -c 'select(.outcome != "success")'
```

## Validation & Verification Checkpoints

| Phase | Check | Command / Action |
|-------|-------|-----------------|
| Pre-spawn | Inputs present (task, scope, ACs) | `test -s convoy.yml \|\| exit 1` |
| During-run | Watch for failures | `opencastle convoy dashboard` |
| Pre-merge | No task left failed or gate-failed | `opencastle convoy --json \| jq -e '.failed == 0'` |
| Unfinished | Nothing failed, skipped or left running | `opencastle convoy --json \| jq -e '.done == .total'` |
| Post-merge | Lint + smoke tests pass | The project's lint and smoke-test commands (Key Commands in `.opencastle/project.instructions.md`) |
| Blocker | Any failure | Block merge; reopen to original researcher(s) |

