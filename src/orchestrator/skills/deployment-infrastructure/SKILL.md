---
name: deployment-infrastructure
description: "Deployment pipelines, environment variables, cron routes, caching headers, releases and rollback. Use when changing CI/CD or platform deploy config (Docker, Vercel, AWS, nginx), env vars or cache headers, or rolling back a release."
---

# Deployment Infrastructure

See `.opencastle/stack/deployment-config.md`, when the project has one, for full architecture, env vars, cron jobs, caching headers.

## Environment Variables

Precedence: `.env` (committed defaults) → `.env.local` (git-ignored) → `.env.production` / `.env.preview` → platform-injected (highest). Gitignore `.env.local`, `.env.*.local`.

Validate the whole environment with one Zod schema at startup, not at point of use. `SCREAMING_SNAKE_CASE`; `PUBLIC_*`/`NEXT_PUBLIC_*` is browser-exposed, `SECRET_*`/`*_SECRET` server-only.

## CI/CD Pipeline

`main` → production, every other branch (`feat/*`, `fix/*`, …) → preview, all automatic. Stages in order: install (always `--frozen-lockfile` in CI) → lint → test → production build → deploy.

Cron route handlers must return 401 unless the `authorization` header equals `Bearer ${process.env.CRON_SECRET}`.

## Caching Strategy

Set per-asset via framework `headers()` config or CDN rules — never a blanket `no-store`.

| Asset Type | `Cache-Control` |
|---|---|
| Hashed assets (JS, CSS), images, fonts | `public, max-age=31536000, immutable` |
| Favicon / manifest | `public, max-age=86400` |
| SSG HTML | `public, max-age=0, must-revalidate` |
| API responses | `private, no-cache` |
| ISR pages | `public, s-maxage=3600, stale-while-revalidate=86400` |

## Security Headers

Load **security-hardening** skill for full CSP inventory and header configuration.

## Release & Rollback

Gate a release on lint + test + build all exiting 0 and no draft PRs, then semver-tag with a changelog in the **technical-writing** format. Verify with `curl -sI https://example.com | grep -E 'HTTP|Strict'` — homepage 200, headers correct.

A failed release gets rolled back immediately, not patched forward: the platform's instant rollback (e.g. Vercel or Netlify, promote the last good deploy) first, then a revert PR (`git revert`, on a branch) so `main` matches what runs. Re-run the `curl -sI` check before calling it resolved.
