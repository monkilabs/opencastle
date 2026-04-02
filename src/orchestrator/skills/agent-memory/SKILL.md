---
name: agent-memory
description: "Creates and queries agent expertise profiles in AGENT-EXPERTISE.md, increments file-familiarity counters after each task, and ranks candidate agents by recency and task-area match. Use when deciding which agent should handle a file, checking who last worked on a module, recording task outcomes, or assigning work based on past performance."
---

# Agent Memory Protocol

## Expertise File

**Location:** `.opencastle/AGENT-EXPERTISE.md` — one section per agent with Strong Areas, Weak Areas, and File Familiarity tables.

Entry format: `Area | Evidence | Last Updated` — e.g. `Server Components | Built TAS-42 | 2026-03-15`. File familiarity: `- src/lib/search/ — 3 tasks`.

## Update Triggers

| Trigger | Action |
|---------|--------|
| First-attempt success | Update Strong |
| 2+ retries | Update Weak |
| File modified | Increment familiarity |
| DLQ failure | Add Weak with ref |
| >3 months stale | Mark as "stale" |

## Retrieval & Delegation

Query before delegating, then include a concise context block in the prompt:

```sh
grep -A5 "## Developer" .opencastle/AGENT-EXPERTISE.md
```

Example prompt block: `Agent Context: Strong — Server Components (3 tasks); Weak — Component styling (2 retries); Familiar — src/lib/search/ (2 tasks)`

**Update after task completion:**

```bash
# Append a Strong Area entry
printf '| %s | %s | %s |\n' "Server Components" "Built TAS-42" "$(date +%Y-%m-%d)" >> .opencastle/AGENT-EXPERTISE.md

# Increment file familiarity
awk '/src\/lib\/search\// { if (match($0, /[0-9]+/)) { n = substr($0, RSTART, RLENGTH) + 1; sub(/[0-9]+[[:space:]]*tasks?/, n " tasks") } found=1 } {print} END { if(!found) print "- `src/lib/search/` — 1 task" }' \
  .opencastle/AGENT-EXPERTISE.md > tmp && mv tmp .opencastle/AGENT-EXPERTISE.md
```

## Workflow

1. **Before delegating:** Read `.opencastle/AGENT-EXPERTISE.md`, check Strong/Weak areas, add concise `Agent Context` to the prompt.
  - Validate: the selected agent has a Strong area matching the task or no conflicting Weak entries.
2. **After task completes:** Update expertise (success → Strong, 2+ retries → Weak, files → Familiarity) and append file relationships to `.opencastle/KNOWLEDGE-GRAPH.md`.
  - Validate: the expertise file contains the new entry and the timestamp is today's date.
3. **On DLQ failure:** Add Weak Area with reference to the failure ID and link to logs.
  - Validate: failure ID and link appear in the Weak Area entry.

## Pruning

Prune entries older than 6 months, remove familiarity for deleted paths, and consolidate duplicates.
 - Validate: run `rg "— [0-9]+ tasks" .opencastle/AGENT-EXPERTISE.md` after pruning to confirm no stale paths remain.
## Knowledge Graph

File dependency graph and cross-agent relationships. See [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) for entity types, templates, triggers, and queries.
