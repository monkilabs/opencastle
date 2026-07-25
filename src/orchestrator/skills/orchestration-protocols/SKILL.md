---
name: orchestration-protocols
description: "Coordinate multiple agents: parallel spawning, health monitoring, circuit breakers, escalation. Use for parallel agents, agent timeouts, fan-out tasks, multi-agent delegation."
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

**Sub-agents:** steer live, within the first 5 min. **Background agents:** no live steering — front-load prompt specificity, partition constraints, acceptance criteria checklists.

## Background Agents

Run autonomously in isolated Git worktrees. Reserve for well-scoped tasks >5 min with clear acceptance criteria.

- **Spawn:** Delegate Session → Background → Select agent → Enter prompt
- **Interrupted:** `opencastle convoy resume` picks up where the run stopped

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
opencastle convoy run --file convoy.yml --dry-run
opencastle convoy run --file convoy.yml --verbose
opencastle convoy resume
opencastle convoy
opencastle convoy retry
```

**Post-run verification (copy-paste checks):**

```bash
if [ $? -ne 0 ]; then
  echo "convoy run failed — inspect .opencastle/convoy.log" \
	 && tail -n 200 .opencastle/convoy.log && exit 1
fi

npx opencastle convoy

grep -i "error\|failed" .opencastle/convoy.log || echo "no obvious errors in logs"
```

## Validation & Verification Checkpoints

| Phase | Check | Command / Action |
|-------|-------|-----------------|
| Pre-spawn | Inputs present (task, scope, ACs) | `test -s convoy.yml \|\| exit 1` |
| During-run | Tail for fatal errors | `tail -F .opencastle/convoy.log \| grep -i "fatal\|error"` |
| Pre-merge | All agents exited 0 | `jq -e '.agents[] \| .exit_code == 0' .opencastle/results.json` |
| Output schema | Required fields present | `jq -e '.agents[] \| (.findings and .file_paths)' .opencastle/results.json` |
| Post-merge | Lint + smoke tests pass | `npm run lint && npm test -- -t "smoke"` |
| Blocker | Any failure | Block merge; reopen to original researcher(s) |

