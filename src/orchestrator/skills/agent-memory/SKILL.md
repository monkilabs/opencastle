---
name: agent-memory
description: "Creates, queries agent expertise profiles in AGENT-EXPERTISE.md; increments file-familiarity counters after each task; ranks candidate agents by recency, task-area match. Use when deciding which agent should handle a file, checking who last worked on a module, recording task outcomes, or assigning work based on past performance."
---

# Agent Memory Protocol

## Expertise File

**Location:** `.opencastle/AGENT-EXPERTISE.md` — one section per agent with Strong Areas, Weak Areas, File Familiarity tables.

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

Query before delegating; include concise context block in prompt:

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

1. **Before delegating:** Read `.opencastle/AGENT-EXPERTISE.md`; check Strong/Weak areas; add concise `Agent Context` to prompt.
  - Validate: selected agent has Strong area matching task or no conflicting Weak entries.
2. **After task completes:** Update expertise (success → Strong, 2+ retries → Weak, files → Familiarity); append file relationships to `.opencastle/KNOWLEDGE-GRAPH.md`.
  - Validate: expertise file contains new entry; timestamp is today's date.
3. **On DLQ failure:** Add Weak Area with reference to failure ID, link to logs.
  - Validate: failure ID, link appear in Weak Area entry.

## Pruning

Prune entries older than 6 months; remove familiarity for deleted paths; consolidate duplicates.
 - Validate: run `rg "— [0-9]+ tasks" .opencastle/AGENT-EXPERTISE.md` after pruning to confirm no stale paths remain.
## Knowledge Graph

File dependency graph, cross-agent relationships. See [KNOWLEDGE-GRAPH.md](./KNOWLEDGE-GRAPH.md) for entity types, templates, triggers, queries.
