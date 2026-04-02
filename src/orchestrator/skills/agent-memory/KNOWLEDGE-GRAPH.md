> Parent: [SKILL.md](./SKILL.md)

# Knowledge Graph Reference

File dependency graph and cross-agent relationships stored in `.opencastle/KNOWLEDGE-GRAPH.md`.

## Entity Types

| Entity | Format | Example |
|--------|--------|---------|
| **File** | `[file:path/to/file.ts]` | `[file:src/components/Button.tsx]` |
| **Agent** | `[agent:Name]` | `[agent:Developer]` |
| **Task** | `[task:TAS-XX]` | `[task:TAS-42]` |

## Relationship Types

| Relationship | Meaning |
|-------------|---------|
| `imports` | File A imports from File B |
| `renders` | Component A renders Component B |
| `queries` | File reads from data source |
| `mutates` | File writes to data source |
| `tested-by` | Source file tested by test file |
| `owned-by` | File primarily maintained by agent |

## Entry Template

```markdown
## [file:src/components/PriceFilter.tsx]
- imports: [file:src/hooks/useFilters.ts], [file:src/lib/api.ts]
- renders: [file:src/components/ui/Slider.tsx]
- tested-by: [file:src/components/PriceFilter.test.tsx]
- owned-by: [agent:Developer] (TAS-42, 2026-03-30)
```

## Triggers

| Event | Action |
|-------|--------|
| New file created | Add node + import edges |
| File deleted | Remove node + all edges |
| Agent completes task | Update `owned-by` with task ID and date |
| Delegation | Query graph for related files to include in prompt |

## Queries

- **What depends on X?** — Find all files with `imports: [file:X]`
- **Who last touched X?** — Check `owned-by` for the most recent task
- **What's the blast radius?** — Traverse `imports`/`renders` edges transitively
