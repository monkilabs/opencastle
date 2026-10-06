````markdown
# Agent Registry

Which agent is for what, and on which tier. The Team Lead routes each task by it.

<!-- Populated by `opencastle init` based on project structure. -->

## Specialist Agent Registry

Tiers describe what kind of model the work wants. Your assistant picks the actual
model — it knows which ones your account can reach and what they cost today.

| Agent | Tier | Best For |
|-------|------|----------|
| **Team Lead** | Premium | Decomposing work, delegating, verifying results |
| **Architect** | Premium | Architecture decisions, ADRs, critical review |
| **Security Expert** | Premium | Auth, access policies, headers, input validation |
| **Developer** | Standard | Features, pages, components, routing, API routes and contracts |
| **UI/UX Expert** | Standard | Components, styling, accessibility, frontend design |
| **Data Engineer** | Standard | Migrations, access policies, query performance, ETL pipelines, imports |
| **Content Engineer** | Standard | CMS schema, content types, content queries |
| **Testing Expert** | Standard | E2E and integration tests, browser validation |
| **Performance Expert** | Standard | Bundle size, Core Web Vitals, profiling |
| **DevOps & Release** | Standard | Deployments, CI/CD, cron jobs, pre-release verification, changelogs |
| **Researcher** | Standard | Codebase exploration, pattern discovery, git archaeology |
| **Writer** | Economy | UI copy, error messages, docs, roadmaps, meta tags, structured data |
| **Reviewer** | Economy | Fast review after every delegation |

## Research Scopes

<!-- Customize these paths to match your project structure.
     For a large plan, the Team Lead first sends one Researcher per area: -->

```
Researcher A: "Research database/backend aspects of [feature]"
  Scope: <database-migrations-dir>/, <server-libs>/

Researcher B: "Research frontend/UI aspects of [feature]"
  Scope: <ui-libs>/, <app-dir>/

Researcher C: "Research CMS/content aspects of [feature]"
  Scope: <cms-dir>/, <queries-lib>/
```

````
