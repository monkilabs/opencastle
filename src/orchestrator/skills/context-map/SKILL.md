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
```bash
rg -n "import .*from .*libs/auth"          # find importers
rg -n "\bAuthCard\b" --type ts --type tsx  # find component consumers
rg -n "auth.*route|/auth"                  # find route references
```
If the assistant exposes a code-usage lookup (find-references), prefer it for
symbols: it resolves re-exports and aliases that a text search misses.

### 3 — Trace Inward (sources)
Find what entry points depend on:
```bash
rg -n "from .*libs/" src/auth/     # shared lib deps
rg -n "from .*config" src/auth/    # config deps
```

### 4 — Build the Map

Produce a compact map for Team Lead and downstream agents:

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

Validation checkpoint: every search hit lands in the map; all listed files open without errors (typecheck via the **codebase-tool** slot). Full template, depth levels, partition derivation, Team Lead integration: see [REFERENCE.md](./REFERENCE.md).

## Anti-Patterns

- Skipping for "obvious" tasks — shared libs cascade unexpectedly
- Guessing dependencies instead of searching for them
- Over-mapping a 2-file fix
- Using a stale map after plan changes
