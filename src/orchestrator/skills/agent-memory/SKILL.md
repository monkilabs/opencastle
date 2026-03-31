---
name: agent-memory
description: "Agent expertise tracking and cross-session knowledge graph. Use when delegating tasks to match agents to their strengths, when reviewing task failures to update weakness records, or when building context about file dependencies and codebase patterns across sessions."
---

# Agent Memory Protocol

## Workflow

### Step 1 — Initialize Expertise Registry

Create `.opencastle/AGENT-EXPERTISE.md` if it does not exist. Use the following structure for each agent:

```markdown
# Agent Expertise Registry

## Developer
### Strong Areas
| Area | Evidence | Last Updated |
|------|----------|-------------|
| Feature implementation | Built 5 pages (TAS-XX, TAS-YY) | YYYY-MM-DD |

### Weak Areas
| Area | Evidence | Last Updated |
|------|----------|-------------|
| Styling | 2 retries on TAS-AA | YYYY-MM-DD |

### File Familiarity
- `apps/web-app/places/` — 3 tasks
```

### Step 2 — Update on Task Completion

After each delegation completes, update the expertise registry based on these triggers:

| Trigger | Action |
|---------|--------|
| First-attempt success | Add/update Strong Area |
| 2+ retries | Add/update Weak Area |
| File modified | Increment File Familiarity |
| DLQ failure | Add Weak Area with ref |
| >3 months stale | Mark as "stale" |

**Validation checkpoint:** Confirm the expertise entry includes evidence (tracker ID or task reference) and a current date — entries without evidence are not actionable.

### Step 3 — Query Before Delegation

Check `.opencastle/AGENT-EXPERTISE.md` before delegating. Inject agent context into the delegation prompt:

```
### Agent Context
- Strong: Server Components, CMS queries (3 tasks)  → "Prior experience from TAS-XX."
- Weak: Component styling (retry TAS-AA)            → add context or reassign
- Familiar: libs/queries/src/lib/search/ (2 tasks)  → "You've worked on [file] in TAS-XX."
```

### Step 4 — Prune Periodically

- Remove entries >6 months old
- Consolidate repetitive entries
- Remove familiarity for deleted files
- Prune at start of major feature work

## Knowledge Graph

**Location:** `.opencastle/KNOWLEDGE-GRAPH.md` (append-only)

### Entities & Relationships

| Entity | Notation | Relationships |
|--------|----------|--------------|
| File | `F:path` | `depends-on`, `blocks` |
| Agent | `A:name` | `expert-in` |
| Pattern/Decision | `P:name` / `D:name` | `related-to`, `obsoletes` |
| Bug/Lesson | `B:id` / `L:id` | `caused-by`, `related-to` |

### Graph Template

```markdown
# Knowledge Graph
## Relationships
| Source | Relationship | Target | Added | Context |
|--------|-------------|--------|-------|---------|
| A:Content Engineer | expert-in | P:CMS-queries | 2026-02-23 | 3 tasks |
| F:searchModule.ts | depends-on | F:cms-client.ts | 2026-02-23 | |
```

### Add Relationships When

| Trigger | Record |
|---------|--------|
| Task touches multiple files | `depends-on` |
| Lesson relates to a pattern | `related-to` |
| Agent demonstrates expertise | `expert-in` |
| Decision causes known issue | `caused-by` |
| Pattern supersedes old approach | `obsoletes` |

### Pre-Delegation Queries

Follow `depends-on` for related reads, `expert-in` to confirm agent, `related-to` for patterns, `blocks` for known issues.

### Maintenance

- Add as discovered; prune between sessions
- Max ~100 active relationships; archive quarterly

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Delegating without checking expertise | Always query the registry before assigning tasks |
| Entries without evidence or dates | Every entry must reference a tracker ID and date |
| Letting the registry grow unbounded | Prune at the start of each major feature |
| Recording only strengths | Weaknesses are equally valuable for routing decisions |
