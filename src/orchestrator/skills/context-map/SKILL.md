---
name: context-map
description: "Maps file dependencies, flags shared imports, groups files for safe parallel editing before code changes. Use when planning a refactoring, analyzing change impact, or understanding which files a modification will affect."
---

# Skill: Context Map

Generate **file impact map** before code changes to identify affected files, relationships, cascades — improves agent file partitions for parallel work.

## When to Use

| Use | Skip |
|-----|------|
| Feature implementation (Phase 1) | Isolated bug fixes ≤2 files |
| Refactoring (Phase 1 Scope) | |
| Schema changes cascading through queries/components | |
| Any task touching `libs/` | |

## Steps

### 1 — Entry Points
Identify files that MUST change from task description.

### 2 — Trace Outward (dependents)
Find consumers of entry-point exports:
```
grep_search("import.*from.*places", isRegexp=true)   # find importers
vscode_listCodeUsages("PlaceCard")                     # find component consumers
grep_search("places.*route|/places", isRegexp=true)    # find route references
```

### 3 — Trace Inward (sources)
Find what entry points depend on:
```
grep_search("from.*libs/", includePattern="src/places/**")  # shared lib deps
grep_search("from.*config", includePattern="src/places/**")  # config deps
```

### 4 — Build the Map

Produce compact Context Map for Team Lead, downstream agents. Example minimal map (inline):

```markdown
Context Map — Feature: Add priceRange

- Entry points:
	- src/lib/place/schema.ts
	- src/components/PriceRangeFilter/PriceRangeFilter.tsx

- Dependents (trace outward):
	- src/pages/places/page.tsx
	- src/components/PlacesList/PlaceCard.tsx

- Sources (trace inward):
	- src/lib/filters.ts
	- src/shared/types/place.ts

- Unaffected (optional):
	- src/components/Account/**
```

Validation checkpoint: run `grep_search`, `vscode_listCodeUsages` results into map; confirm all listed files open without errors (CI: `pnpm typecheck`). For full template, Team Lead integration snippets see REFERENCE.md in this directory.

## Anti-Patterns

- Skipping for "obvious" tasks — shared libs cascade unexpectedly
- Guessing dependencies instead of using `grep_search` / `list_code_usages`
- Over-mapping a 2-file fix
- Using a stale map after plan changes
