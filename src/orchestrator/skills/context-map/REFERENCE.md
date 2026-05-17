> Parent: [SKILL.md](./SKILL.md)

Context Map REFERENCE: full markdown template, Team Lead integration snippet, partition examples.

Use this file for verbose context-map template referenced from `SKILL.md`.
## Context Map Template

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

### Unaffected (optional)
| Area | Why |
|------|-----|
| `db/migrations/` | No DB changes |
| `libs/auth/` | No auth changes |

### 4b — Validate Map
- [ ] Every file appears in exactly one section (Entry/Cascade/Shared/Unaffected)
- [ ] No file appears in two agents' partitions
- [ ] Test files are listed for every changed source file
- [ ] Shared boundaries have explicit mitigation strategies

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
