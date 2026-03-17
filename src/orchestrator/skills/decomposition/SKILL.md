---
name: decomposition
description: "Task decomposition patterns for the Team Lead: dependency resolution, phase assignment, delegation spec templates, prompt quality examples, and orchestration patterns."
---

# Task Decomposition

Load at: Decompose & Partition phase (Step 2) or when writing delegation prompts (Step 3).

## Dependency Resolution

`TaskB → TaskA` = B depends on A (must finish first).

**Topological sort:** No-dep tasks → Phase 1. Tasks depending only on Phase N → Phase N+1. Same-phase tasks with no mutual deps run in parallel.

**Cycle detection:** If A → B → C → A, split one task into an independent part + a dependent part.

```
Graph:        Plan:
E → C → A    Phase 1: A, B (parallel)
D → B        Phase 2: C, D (parallel)
F → C, D     Phase 3: E, F (parallel)
```

## Delegation Spec (Score 5+)

For score 1-3, objective + files + criteria is sufficient.

```
## Delegation Spec: [Task Title]
**Tracker Issue:** TAS-XX — [Title]
**Complexity:** [score]/13 → [tier] tier
**Agent:** [Agent Name]

### Objective
1-3 sentences: what to build/change and why.

### Context
- Key files: [list]
- Related patterns: [file:line references]
- Prior phase output: [compacted summary if applicable]
- Relevant lessons: [LES-XXX from LESSONS-LEARNED.md]

### Constraints
- File partition: Only modify files under [paths]
- Do NOT modify: [explicit exclusions]
- Dependencies: Requires [TAS-XX] Done first

### Acceptance Criteria
- [ ] Criterion 1

### Expected Output
Files changed · Verification (lint/test/build) · AC status (✅/❌) · Discovered issues · Lessons applied
```

Read `.opencastle/LESSONS-LEARNED.md` before starting. Add a lesson if you retry any approach.

## Prompt Quality

| Quality | Example |
|---------|---------|
| Strong (score 2) | "**TAS-42** — Fix token refresh. Users get 'Invalid token' after 30 min. JWT 1h expiry in `libs/auth/src/server.ts`. Fix refresh logic. Only `libs/auth/`. Run auth tests." |
| Strong (score 8) | Use Delegation Spec Template above (all sections). |
| Weak | "Fix the authentication bug." |

## Delegation Mechanism

```
Need result immediately?
 YES → Is dependency for next step?
         YES → Sub-Agent (inline)
         NO  → Sub-Agent or Background (if large)
 NO  → Expected > 5 min?
         YES → Background Agent
         NO  → Sub-Agent (sequential)
```

## Mixed Delegation

| Phase | Mode | Work |
|-------|------|------|
| 1 | sub-agent | Research — context, patterns, file map |
| 2 | background | Foundation — DB migration + scaffolding (parallel) |
| 3 | sub-agent | Integration — wire components to data |
| 4 | background | Validation — security audit + tests + docs (parallel) |
| 5 | sub-agent | QA gate — verify phases, run builds |
| 6 | sub-agent | Panel review — load panel-majority-vote skill |

## Foundation-First Pattern

Apply when: 2+ pages/views/UI sections · multiple agents produce visual output · no existing design system.

```
Phase 1: foundation-setup
├── Creates: design tokens, layout, UI component library, style guide brief
└── All visual tasks → depends_on: [foundation-setup]

Phase 2+: page tasks (parallel)
├── Each prompt includes 5 Foundation References
└── Consume tokens — never create new values
```

**Partition rules:**
- Foundation owns: `src/styles/`, `src/components/Layout.*`, `src/components/ui/`
- Page tasks own: their page file + page-specific components only
- No page task may list a foundation-owned path in its `files[]`

**Common mistake:** Decomposing pages as independent Phase 1 tasks → each agent invents its own design.

> Load the **project-consistency** skill for the full Foundation Phase pattern, prompt templates, and anti-patterns.
