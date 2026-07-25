````markdown
# Agent Registry

Project-specific agent tiers and scope examples referenced by the `team-lead-reference` skill.

<!-- Populated by `opencastle init` based on project structure. -->

## Specialist Agent Registry

Tiers describe what kind of model the work wants. Your assistant picks the actual
model — it knows which ones your account can reach and what they cost today.

| Agent | Tier | Best For |
|-------|------|----------|
| **Developer** | Standard | Full-stack feature implementation, pages, components, routing, API routes |
| **Testing Expert** | Standard | E2E tests, browser validation, terminal-heavy test loops |
| **Content Engineer** | Standard | CMS schema, content queries, MCP tool coordination |
| **Database Engineer** | Standard | Migrations, RLS policies, SQL optimization |
| **UI/UX Expert** | Standard | Components, styling, accessibility, frontend design |
| **Performance Expert** | Standard | Bundle size, Core Web Vitals, profiling |
| **Security Expert** | Premium | Auth, RLS audits, headers, precision analysis |
| **Data Expert** | Standard | ETL pipelines, scrapers, terminal-heavy data import |
| **DevOps Expert** | Standard | Deployments, cron jobs, terminal-heavy infrastructure |
| **Documentation Writer** | Economy | Docs, roadmaps, ADRs |
| **Architect** | Premium | Architecture decisions, critical review, expert reasoning |
| **Reviewer** | Economy | Mandatory fast review after every delegation, code correctness checks |
| **Researcher** | Standard | Codebase exploration, pattern discovery, full-repo context analysis |
| **Copywriter** | Economy | UI microcopy, marketing text, email templates |
| **SEO Specialist** | Economy | Meta tags, structured data, sitemaps |
| **API Designer** | Standard | API route architecture, endpoint conventions |
| **Release Manager** | Standard | Pre-release verification, changelog generation |

## Deepen-Plan Scope Examples

<!-- Customize these paths to match your project structure.
     When running the Deepen-Plan protocol, split research by domain: -->

```
Researcher A: "Research database/backend aspects of [feature]"
  Scope: <database-migrations-dir>/, <server-libs>/

Researcher B: "Research frontend/UI aspects of [feature]"
  Scope: <ui-libs>/, <app-dir>/

Researcher C: "Research CMS/content aspects of [feature]"
  Scope: <cms-dir>/, <queries-lib>/
```

````
