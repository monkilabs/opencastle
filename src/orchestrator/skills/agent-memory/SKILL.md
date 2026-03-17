---
name: agent-memory
description: "Agent expertise tracking and cross-session knowledge graph. Use when delegating tasks to track agent strengths/weaknesses, or when building context about file relationships and patterns."
---

# Agent Memory Protocol

## Expertise File

**Location:** `.opencastle/AGENT-EXPERTISE.md`

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

## Update Triggers

| Trigger | Action |
|---------|--------|
| First-attempt success | Add/update Strong Area |
| 2+ retries | Add/update Weak Area |
| File modified | Increment File Familiarity |
| DLQ failure | Add Weak Area with ref |
| >3 months stale | Mark as "stale" |

## Retrieval & Delegation

Check `.opencastle/AGENT-EXPERTISE.md` before delegating. Add to prompt:

```
### Agent Context
- Strong: Server Components, CMS queries (3 tasks)  → "Prior experience from TAS-XX."
- Weak: Component styling (retry TAS-AA)            → add context or reassign
- Familiar: libs/queries/src/lib/search/ (2 tasks)  → "You've worked on [file] in TAS-XX."
```

## Pruning

- Remove entries >6 months old; consolidate repetitive entries; remove familiarity for deleted files
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
