---
name: backbone-scaffolding
description: "Scaffolds production-ready monorepo projects using the backbone CLI: configures workspace packages, wires build tooling, sets up CI pipelines, and initializes framework/backend/CMS integrations. Use when creating, bootstrapping, or initializing a new application, project, starter template, or monorepo from scratch. Trigger terms: scaffold, bootstrap, init, new repo, new app, boilerplate, starter, greenfield."
---

# backbone-scaffolding Skill

## Requirements

- Node.js **>= 22.5.0** must be available in the environment
- Run backbone with `npx @monkilabs/backbone <project-name>`

## How to Use the CLI

Backbone is **interactive** — uses `@clack/prompts` to ask series of questions. Agents must run command, respond to each prompt in sequence.

### Prompt Sequence

1. **Monorepo tool** — `nx` or `turborepo`
2. **Framework** — `nextjs` or `astro`
3. **Backend** — `convex`, `supabase`, `prisma`, or `drizzle`
4. **CMS** — `sanity`, `contentful`, `strapi`, or `none`
5. **E2E Testing** — `playwright` or `cypress`
6. **Deployment** — `vercel`, `netlify`, `cloudflare`, `coolify`, or `none`
7. **Mobile** — `ionic`, `expo`, or `none` *(only shown for non-Astro frameworks)*
8. **Packages** — multi-select: `uiLib`, `emailLib`, `llmLib`
9. **Payments** — `stripe` or `none`
10. **Observability** — `sentry` or `none`

## CLI Options & Constraints

| Category      | Choices                                          | Notes                                    |
|---------------|--------------------------------------------------|------------------------------------------|
| Monorepo      | `nx`, `turborepo`                                | Required                                 |
| Framework     | `nextjs`, `astro`                                | Required                                 |
| Backend       | `convex`, `supabase`, `prisma`, `drizzle`        | ⛔ `convex` incompatible with `astro`    |
| CMS           | `sanity`, `contentful`, `strapi`, `none`         | Optional                                 |
| E2E Testing   | `playwright`, `cypress`                          | Required                                 |
| Deployment    | `vercel`, `netlify`, `cloudflare`, `coolify`, `none` | Optional                             |
| Mobile        | `ionic`, `expo`, `none`                          | ⛔ `ionic` and `expo` incompatible with `astro` |
| Packages      | `uiLib`, `emailLib`, `llmLib`                    | Multi-select; ⛔ `uiLib` incompatible with `astro` |
| Payments      | `stripe`, `none`                                 | Optional                                 |
| Observability | `sentry`, `none`                                 | Optional                                 |

**Astro constraint:** `astro` requires React-free options — never combine with `convex`, `ionic`, `expo`, or `uiLib`.

## OpenCastle TechTool → Backbone Mapping

Most TechTool names map 1:1 to backbone prompt choices (e.g. `nextjs` → select Next.js, `supabase` → select Supabase). Exceptions:

| TechTool | Backbone mapping | Notes |
|----------|-----------------|-------|
| `resend` | Select `emailLib` in Packages prompt | Only non-obvious mapping |
| `drizzle` | Select `drizzle` in Backend prompt | Direct 1:1 mapping |
| `cloudflare` | Select `cloudflare` in Deployment prompt | Direct 1:1 mapping |
| `coolify` | Select `coolify` in Deployment prompt | Direct 1:1 mapping |
| `expo` | Select `expo` in Mobile prompt | Direct 1:1 mapping; incompatible with `astro` |
| `stripe` | Select `stripe` in Payments prompt | Direct 1:1 mapping |
| `sentry` | Select `sentry` in Observability prompt | Direct 1:1 mapping |
| `vitest` | — | Always included automatically |
| `figma`, `chrome-devtools` | — | Not handled by backbone; configure separately |

## Generated Project Structure

After backbone runs, the output directory contains:

```
<project-name>/
  apps/
    web/          # Next.js or Astro application
    mobile/       # (if ionic or expo selected)
  packages/
    ui/           # (if uiLib selected) shared React component library
    email/        # (if emailLib selected) Resend/React Email package
    llm/          # (if llmLib selected) LLM integration package
    stripe/       # (if stripe selected) Stripe client + webhook handler
  backend/
    convex/       # (if convex selected)
    supabase/     # (if supabase selected)
    prisma/       # (if prisma selected)
    drizzle/      # (if drizzle selected) schema, config, migrations
  e2e/            # Playwright or Cypress tests
  .github/
    workflows/    # GitHub Actions CI pipelines (always included)
  vitest.config.ts          # Always included
  tsconfig.base.json        # Always included
  package.json              # Monorepo root package.json
  turbo.json / nx.json      # Monorepo tool config
  wrangler.toml             # (if cloudflare selected)
  Dockerfile                # (if coolify selected)
  sentry.*.config.ts        # (if sentry selected) in apps/web/
```

**Always included regardless of options:** Vitest configuration, GitHub Actions CI workflows, root `tsconfig.base.json`, ESLint, Prettier.

Agents working on post-scaffolding tasks must **not recreate** these files — they already exist. Build on top of generated structure.

## Post-Scaffolding Steps

After `npx @monkilabs/backbone <project-name>` completes:

1. `cd <project-name>` into generated directory
2. Run `npm install` for all dependencies
3. Verify project builds: run monorepo build command (e.g. `npx turbo build` or `npx nx build`)
4. All subsequent agent tasks should **import and extend** generated boilerplate — never overwrite

**If something fails:**
- `npm install` errors → verify Node.js >= 22.5.0 (`node -v`)
- Build errors → check no incompatible options selected (see Astro constraint above); re-run backbone with corrected choices if needed
- Wrong option selected → delete generated directory; re-run `npx @monkilabs/backbone` with correct selections

## Example Convoy Task

See [EXAMPLES.md](EXAMPLES.md) for a complete scaffolding task JSON.

