````markdown
# Agent Registry

Project-specific agent-to-model assignments and scope examples referenced by the `team-lead-reference` skill.

<!-- Populated by `opencastle init` based on project structure. -->

## Specialist Agent Registry

| Agent | Model | Tier | Best For |
|-------|-------|------|----------|
| **Developer** | Claude Sonnet 4.6 | Quality | Full-stack feature implementation, pages, components, routing, API routes |
| **Testing Expert** | GPT-5.5-Codex | Fast | E2E tests, browser validation, terminal-heavy test loops |
| **Content Engineer** | Gemini 3.1 Pro | Standard | CMS schema, content queries, MCP tool coordination |
| **Database Engineer** | Gemini 3.1 Pro | Standard | Migrations, RLS policies, SQL optimization |
| **UI/UX Expert** | Claude Sonnet 4.6 | Quality | Components, styling, accessibility, frontend design |
| **Performance Expert** | Gemini 3.1 Pro | Standard | Bundle size, Core Web Vitals, profiling |
| **Security Expert** | Claude Sonnet 4.6 | Quality | Auth, RLS audits, headers, precision analysis |
| **Data Expert** | GPT-5.5-Codex | Fast | ETL pipelines, scrapers, terminal-heavy data import |
| **DevOps Expert** | GPT-5.5-Codex | Fast | Deployments, cron jobs, terminal-heavy infrastructure |
| **Documentation Writer** | GPT-5.4 mini | Economy | Docs, roadmaps, ADRs (cost-effective) |
| **Architect** | Claude Sonnet 4.6 | Quality | Architecture decisions, critical review, expert reasoning |
| **Reviewer** | GPT-5.4 mini | Economy | Mandatory fast review after every delegation, code correctness checks |
| **Researcher** | Gemini 3.1 Pro | Standard | Codebase exploration, pattern discovery, full-repo context analysis |
| **Copywriter** | GPT-5.4 mini | Economy | UI microcopy, marketing text, email templates |
| **SEO Specialist** | GPT-5.4 mini | Economy | Meta tags, structured data, sitemaps |
| **API Designer** | Gemini 3.1 Pro | Standard | API route architecture, endpoint conventions |
| **Release Manager** | GPT-5.5-Codex | Fast | Pre-release verification, changelog generation |

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
