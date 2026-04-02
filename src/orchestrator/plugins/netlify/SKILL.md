---
name: netlify-deployment
description: "Deploy sites, configure serverless and edge functions, and verify builds on Netlify. Use when the user mentions: 'deploy preview', 'configure netlify.toml', or 'debug a failed deploy'. Trigger terms: build error, Netlify Functions, deploy logs, deploy preview"
---

# Netlify Deployment

Netlify-specific deployment patterns and conventions. For project-specific deployment architecture, environment variables, and key files, see [deployment-config.md](../../.opencastle/stack/deployment-config.md).

## Deployment Model

| Branch | Environment |
|--------|-------------|
| `main` | Production (auto) |
| `feature/*`, `fix/*` | Deploy preview (auto, unique URL) |

## Deployment Workflow

1. Configure `netlify.toml` (build command, publish dir, env vars).
2. Build locally: `netlify build --debug` — fix any errors before pushing.
3. Push branch — Netlify auto-deploys a preview.
4. Verify preview: `curl -fsS -o /dev/null -w '%{http_code}' https://<DEPLOY_URL>/` — expect 200.
5. Merge to `main` — production auto-deploys.

## Build Configuration (netlify.toml)

```toml
[build]
  command = "npm run build"
  publish = "dist"              # or ".next", "out", "build"

[build.environment]
  NODE_VERSION = "20"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
  conditions = {Role = ["admin"]}
```

For security headers config, see [REFERENCE.md](REFERENCE.md).

## Serverless Functions

Place functions in `netlify/functions/`. For full examples and CI-ready function patterns see [REFERENCE.md](REFERENCE.md).

- Functions use web standard Request/Response. The `Config` export defines routing (path) instead of the default `/.netlify/functions/<name>` path.
- Supports TypeScript out of the box; default timeout: 10s (extendable to 26s on Pro).
- Use background functions for long-running tasks (up to 15 min).

## Edge Functions

Place edge functions in `netlify/edge-functions/`:

```typescript
// netlify/edge-functions/geolocation.ts
import type { Context } from '@netlify/edge-functions';

export default async (request: Request, context: Context) => {
  const { country } = context.geo;
  return new Response(`You're visiting from ${country}`);
};

export const config = { path: '/geo' };
```

- Use for personalization, A/B testing, geo-routing
- Deno runtime (not Node.js)

## Environment Variables

See [REFERENCE.md](REFERENCE.md) for environment variable scoping and security header examples.

## Scheduled Functions (Cron)

```typescript
// netlify/functions/daily-task.ts
import type { Config } from "@netlify/functions";

export default async (req: Request) => {
  const { next_run } = await req.json();
  console.log("Next invocation at:", next_run);
};

export const config: Config = {
  schedule: "0 0 * * *", // Daily at midnight UTC
};
```

## Build Troubleshooting

```bash
netlify build --debug          # reproduce locally with verbose output
netlify env:list               # verify env vars are set
netlify status                 # check linked site and deploy state
```

Common fixes: set `NODE_VERSION` in `netlify.toml`, sync lockfile, verify `publish` directory matches build output.

## Post-Deploy Verification

```bash
curl -fsS -o /dev/null -w '%{http_code}' https://<DEPLOY_URL>/          # expect 200
curl -fsS -o /dev/null -w '%{http_code}' https://<DEPLOY_URL>/api/health # expect 200
```

If any route fails: inspect deploy logs in Netlify UI, fix, and re-deploy. See [REFERENCE.md](REFERENCE.md) for extended verification scripts.
