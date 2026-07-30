---
name: netlify-deployment
description: "Deploy sites, configure serverless and edge functions, and verify builds on Netlify. Use when the user mentions: 'deploy preview', 'configure netlify.toml', or 'debug a failed deploy'. Trigger terms: build error, Netlify Functions, deploy logs, deploy preview"
---

# Netlify Deployment

Project deployment architecture, env vars, and key files: [deployment-config.md](../../.opencastle/stack/deployment-config.md). Docs: https://docs.netlify.com

`main` → production (auto). `feature/*`, `fix/*` → deploy preview at a unique URL (auto).

## Hard limits

- Serverless functions (`netlify/functions/`): default timeout **10s**, extendable to **26s** on Pro. Anything longer must be a background function — up to **15 min**.
- Edge functions (`netlify/edge-functions/`) run on **Deno, not Node** — no Node built-ins, no npm-only packages. Use for personalization, A/B tests, geo-routing (`context.geo`).
- Functions use web-standard `Request`/`Response`. TypeScript works with no build step.

## Gotchas

- Exporting `config = { path: '/geo' }` from a function *replaces* the default `/.netlify/functions/<name>` route. Without it, the default path is the only one that works.
- Cron is a function-level `config: Config = { schedule: "0 0 * * *" }` — the schedule is **UTC**, and the request body carries `next_run`.
- Env vars are scoped and do not cascade: **Production** (`main` deploys), **Deploy previews** (all PR/branch builds), **Branch deploy** (one named branch), **Local** (`netlify dev`). A var set only on Production is undefined in previews.
- Most build failures are `NODE_VERSION` (set it under `[build.environment]` in `netlify.toml`), a stale lockfile, or a `publish` dir that does not match the actual build output.

## Commands

```bash
netlify build --debug   # reproduce the CI build locally, verbose — do this before pushing
netlify env:list        # confirm vars exist in the scope you expect
netlify status          # linked site + deploy state
```

Post-deploy, verify each critical route returns 200:

```bash
curl -fsS -o /dev/null -w '%{http_code}' https://<DEPLOY_URL>/
```

Any non-200 → read the deploy log in the Netlify UI, fix, redeploy.
