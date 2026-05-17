---
name: deployment-infrastructure
description: "Configures deployment pipelines, manages environment variables, schedules cron jobs, applies security headers, implements caching strategies. Use when working with Docker, Vercel, AWS, Dockerfile, nginx.conf, or platform deployment configs."
---

# Deployment Infrastructure

See [deployment-config.md](../../.opencastle/stack/deployment-config.md) for full architecture, env vars, cron jobs, caching headers.

## Environment Variables

### Layering & Precedence

`.env` (defaults, committed) → `.env.local` (git-ignored) → `.env.production` / `.env.preview` → Platform-injected (highest).

### Startup Validation

```typescript
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  API_SECRET: z.string().min(32),
  PUBLIC_SITE_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export const env = envSchema.parse(process.env);
```

### Naming

Prefix: `PUBLIC_*`/`NEXT_PUBLIC_*` (browser-safe), `SECRET_*`/`*_SECRET` (server-only). `SCREAMING_SNAKE_CASE`. Gitignore `.env.local`, `.env.*.local`.

## CI/CD Pipeline

**Branch deployment:** `main` → Production (auto) | `feature/*`, `fix/*` → Preview (auto)

**Stages (in order):** Install (`--frozen-lockfile`), Lint, Test (unit + integration + coverage), Build (production build), Deploy

**Cron auth:**

```typescript
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return new Response('Unauthorized', { status: 401 });
  return Response.json({ ok: true });
}
```

## Caching Strategy

| Asset Type | `Cache-Control` Header |
|---|---|
| Hashed static assets (JS, CSS) | `public, max-age=31536000, immutable` |
| Images / fonts | `public, max-age=31536000, immutable` |
| Favicon / manifest | `public, max-age=86400` |
| HTML pages (SSG) | `public, max-age=0, must-revalidate` |
| API responses | `private, no-cache` |
| Prerendered pages (ISR) | `public, s-maxage=3600, stale-while-revalidate=86400` |

Apply via framework `headers()` config or CDN rules.

## Security Headers

Load **security-hardening** skill for full CSP inventory, header configuration.

## Release Process

1. **Audit** — lint, test, build; `git diff` since last tag; verify no draft PRs
   - Gate: all commands exit 0
2. **Changelog** — generate from commits; categorize (Features, Fixes, Breaking); include migration notes
3. **Tag** — semver tag; update version references
4. **Verify** — `curl -sI https://example.com | grep -E 'HTTP|Strict'` — smoke-test production URLs; monitor error rates
   - Gate: homepage returns 200; headers correct
   - Fail → rollback immediately

## Rollback

Prefer platform rollback (promote last good deploy). Fallback: `git revert -m 1 HEAD Prefer platform rollback (promote last good deploy). Fallback: `git revert -m 1 HEAD && git push`.Prefer platform rollback (promote last good deploy). Fallback: `git revert -m 1 HEAD && git push`. git push`.

1. Roll back → 2. Smoke-test (`curl -sI`) → 3. Confirm 200 + correct behavior → 4. If still broken, escalate
5. Notify team; create post-mortem ticket

## Anti-Patterns

| Anti-Pattern | Fix |
|---|---|
| Hardcoding secrets | Env vars + Zod startup validation |
| Skipping preview deployments | Deploy every branch to preview |
| `Cache-Control: no-store` everywhere | Per-asset cache durations (see table) |
| Disabling security headers "temporarily" | Keep strict; document exceptions |
| Builds without `--frozen-lockfile` | Always use `--frozen-lockfile` in CI |
