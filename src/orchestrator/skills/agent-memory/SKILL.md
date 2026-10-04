---
name: agent-memory
description: "Creates, queries agent expertise profiles in AGENT-EXPERTISE.md; increments file-familiarity counters after each task; ranks candidate agents by recency, task-area match. Use when deciding which agent should handle a file, checking who last worked on a module, recording task outcomes, or assigning work based on past performance."
---

# Agent Memory Protocol

## Expertise File

**Location:** `.opencastle/AGENT-EXPERTISE.md`, created on the first update. One `## <Agent>` section per agent that has worked here, each with `### Strong Areas`, `### Weak Areas` and `### File Familiarity`; add the file, then the section, when they are missing.

Entry format: `| Area | Evidence | Last Updated |` — e.g. `| Server Components | Built TAS-42 | 2026-03-15 |`. File familiarity: `- src/lib/search/ — 3 tasks`.

## Update Triggers

| Trigger | Action |
|---------|--------|
| First-attempt success | Update Strong |
| 2+ retries | Update Weak |
| File modified | Increment familiarity |
| DLQ failure | Add Weak with ref |
| >3 months stale | Mark as "stale" |

## Retrieval & Delegation

Query before delegating — there is nothing to read until the file exists — and include a concise context block in the prompt:

```sh
grep -A12 "^## Developer" .opencastle/AGENT-EXPERTISE.md 2>/dev/null
```

Example prompt block: `Agent Context: Strong — Server Components (3 tasks); Weak — Component styling (2 retries); Familiar — src/lib/search/ (2 tasks)`

**After task completion,** edit the agent's section with your file-editing tool: add the row under the right table, or raise the task count on the familiarity line. Appending with `>>` puts the row at the end of the file, under whichever agent's section happens to be last.

After each task also add file relationships to `.opencastle/KNOWLEDGE-GRAPH.md`, created the same way. On DLQ failure, the Weak Area entry must carry the failure ID and a link to its logs.

## Validation Checkpoints

- Before delegating: chosen agent has a Strong area matching the task and no conflicting Weak entry.
- After completion: expertise file has the new entry, timestamped today.
- After pruning: every path on a familiarity line still exists.

## Pruning

Prune entries older than 6 months; remove familiarity for deleted paths; consolidate duplicates.

## Knowledge Graph

File dependency graph, cross-agent relationships. See [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) for entity types, templates, triggers, queries.
