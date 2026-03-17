---
name: deployment-infrastructure
description: "Deployment architecture, environment variables, cron jobs, security headers, and caching patterns. Use when configuring deployments, managing environment variables, setting up cron jobs, or troubleshooting build/deployment issues."
---

# Deployment Infrastructure

All deployment configuration is project-specific. See [deployment-config.md](../../.opencastle/stack/deployment-config.md) for the full architecture, environment variables, cron jobs, caching headers, and key files.

## Generic Deployment Principles

- Use platform-native Git integration for CI/CD (push to `main` = production, push to branch = preview)
- Store all secrets as environment variables — never in code, commits, or logs
- Use `Bearer` token auth for cron job endpoints
- Apply security headers via framework config (HSTS, CSP, X-Frame-Options, Permissions-Policy)
- Cache static assets with `max-age=31536000, immutable`; use `max-age=86400` for favicon/manifest
- Load the **security-hardening** skill for full header inventory and CSP configuration

## Environment Variables

### Layering & Precedence

1. `.env` — shared defaults; committed, no secrets
2. `.env.local` — developer overrides; git-ignored
3. `.env.production` / `.env.preview` — environment-specific values
4. Platform-injected — set in hosting dashboard (highest priority)

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

- Prefix: `PUBLIC_*`/`NEXT_PUBLIC_*` (browser-safe), `SECRET_*`/`*_SECRET` (server-only), `CRON_SECRET` (cron)
- `SCREAMING_SNAKE_CASE`; gitignore `.env.local`, `.env.*.local`, `.env.production`

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

| Asset Type | `Cache-Control` Header | Rationale |
|---|---|---|
| Hashed static assets (JS, CSS) | `public, max-age=31536000, immutable` | Content-addressed; safe to cache forever |
| Images / fonts | `public, max-age=31536000, immutable` | Typically fingerprinted |
| Favicon / manifest | `public, max-age=86400` | Refreshes within a day |
| HTML pages (SSG) | `public, max-age=0, must-revalidate` | Serve stale while revalidating |
| API responses | `private, no-cache` | User-specific or frequently changing |
| Prerendered pages (ISR) | `public, s-maxage=3600, stale-while-revalidate=86400` | CDN: 1h cache, 1d stale |

Apply via framework `headers()` config or CDN rules.

## Security Headers

Apply globally via framework config or middleware. See **security-hardening** skill for full CSP configuration.

```javascript
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline';" },
];
```

- HSTS `max-age` ≥ 31536000 for preload eligibility
- `X-Frame-Options: DENY` prevents clickjacking; use `SAMEORIGIN` only for self-embeds
- Keep CSP as restrictive as possible; document each exception
- Disable unused browser features via `Permissions-Policy`

## Release Process

1. **Pre-Release Audit** — lint, test, build all affected projects; check `git diff` since last tag; verify no draft PRs
2. **Regression Check** — spot-check adjacent features; run full test suites; verify critical user flows
3. **Changelog** — generate from commits/PR titles; categorize (Features, Bug Fixes, Performance, Breaking Changes); include migration notes
4. **Version** — semver (MAJOR/MINOR/PATCH); tag in git; update version references
5. **Verify** — smoke-test production URLs; monitor error rates; document rollback steps

## Rollback Procedures

1. **Platform rollback** — promote last known-good deployment from hosting dashboard
2. **Git revert** — `git revert -m 1 HEAD && git push origin main`

- [ ] Confirm issue is deployment-related (not data or third-party)
- [ ] Roll back via platform or git revert — never force-push `main`
- [ ] Smoke-test the rollback deployment
- [ ] Notify team; create post-mortem ticket

## Anti-Patterns

| Anti-Pattern | Why | Fix |
|---|---|---|
| Hardcoding secrets | Leak via git, logs, bundles | Env vars + Zod startup validation |
| Skipping preview deployments | Bugs reach production unreviewed | Deploy every branch to preview |
| `Cache-Control: no-store` everywhere | Every request hits origin | Per-asset cache durations (see table) |
| Force-push `main` to fix a deploy | Destroys history; breaks teammates | `git revert` to undo cleanly |
| Disabling security headers "temporarily" | Temporary becomes permanent | Keep strict; document exceptions |
| Builds without `--frozen-lockfile` | Non-deterministic installs | Always use `--frozen-lockfile` in CI |
| `.env.local` in repository | Developer secrets leak | Gitignore; share via secure vault |
| No startup env validation | Cryptic late-failure errors | Validate all vars at boot (fail fast) |
