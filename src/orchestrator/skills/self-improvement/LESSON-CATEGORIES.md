> Parent: [SKILL.md](./SKILL.md)

# Lesson Categories & Severity

Use these tables when tagging lessons in `LESSONS-LEARNED.md`.

## Categories

| Category | When to use |
|----------|------------|
| `bug` | Runtime errors, incorrect behavior, regressions |
| `pattern` | Reusable code or workflow pattern discovered |
| `architecture` | Structural decisions, module boundaries, data flow |
| `tooling` | Build tools, CLI, IDE, MCP, CI/CD issues |
| `testing` | Test strategy, flaky tests, coverage gaps |
| `security` | Auth, RLS, headers, secrets, input validation |
| `performance` | Rendering, bundle size, query optimization |
| `deployment` | Hosting, env vars, caching, rollback |
| `process` | Workflow, delegation, review, orchestration |
| `documentation` | Docs structure, templates, stale content |

## Severity

| Severity | Criteria |
|----------|---------|
| `critical` | Blocks all work or causes data loss |
| `high` | Blocks a task or causes significant rework |
| `medium` | Causes friction or minor rework |
| `low` | Nice-to-know; minor efficiency improvement |

## Tagging Format

```
### LES-XXX: <title>
**Category:** <category> | **Severity:** <severity> | **Date:** YYYY-MM-DD
```
