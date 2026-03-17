---
name: context-map
description: "Generate a structured file impact map before making changes. Identifies all files that will be affected, their relationships, and cascade effects — improving file partitioning for parallel work and reducing unexpected side effects."
---

# Skill: Context Map

Generate a **file impact map** before code changes to identify affected files, relationships, and cascades — improving agent file partitions for parallel work.

## When to Use

| Use | Skip |
|-----|------|
| Feature implementation (Phase 1) | Isolated bug fixes ≤2 files |
| Refactoring (Phase 1 Scope) | |
| Schema changes cascading through queries/components | |
| Any task touching `libs/` | |

## Steps

### 1 — Entry Points
Identify files that MUST change from the task description.

### 2 — Trace Outward (dependents)
Use `grep_search` / `list_code_usages`: imports, type consumers, route references, query consumers, test files.

### 3 — Trace Inward (sources)
CMS schemas, `libs/` utilities, config files.
### 4 — Build the Map

```markdown
## Context Map: [Task Name]

### Entry Points (MUST change)
| File | Reason | Owner |
|------|--------|-------|
| `libs/queries/src/lib/places.ts` | Add query field | Content Engineer |
| `libs/ui-kit/.../PlaceCard/` | Display new field | UI/UX Expert |

### Cascade Effects (WILL change)
| File | Triggered By | Reason | Owner |
|------|-------------|--------|-------|
| `apps/web-app/places/page.tsx` | PlaceCard | Update props | Frontend Dev |
| `libs/queries/src/lib/__tests__/places.test.ts` | Query | Update test | Testing Expert |

### Shared Boundaries (WATCH)
| File | Risk | Mitigation |
|------|------|------------|
| `libs/ui-kit/src/lib/index.ts` | Barrel export conflict | Merge sequentially |

### Unaffected
| Area | Why |
|------|-----|
| `db/migrations/` | No DB changes |
| `libs/auth/` | No auth changes |
```

### 5 — Derive File Partitions

Assign ownership — no file in two partitions; shared boundaries to one agent (merged first); test files to Testing Expert unless tightly coupled.

```
Agent A: libs/queries/src/lib/places.ts
Agent B: libs/ui-kit/.../PlaceCard/
Agent C: apps/web-app/places/, apps/admin-panel/places/
Agent D: **/*test*, **/*spec*
```

## Depth Levels

| Complexity | Files | Depth |
|------------|-------|-------|
| Small | 1–3 | Entry points + direct imports |
| Medium | 4–8 | Entry + 1-hop cascade |
| Large | 9+ | Full dependency graph |

## Team Lead Integration

Produced in **Phase 1**; consumed by:
- **Decomposition** — informs file partitions
- **Delegation prompts** — agents receive their map section
- **QA Gate** — compare actual changes against map to detect scope creep

Delegation prompt snippet:
```markdown
## Your File Partition
Modify only: `libs/queries/src/lib/places.ts`, `libs/queries/src/lib/__tests__/places.test.ts`
Do NOT modify: `libs/ui-kit/` (UI/UX Expert), `apps/` (Developer)
```

## Anti-Patterns

- Skipping for "obvious" tasks — shared libs cascade unexpectedly
- Guessing dependencies instead of using `grep_search` / `list_code_usages`
- Over-mapping a 2-file fix
- Using a stale map after plan changes
