---
name: security-hardening
description: "Security rules for authentication, authorization, RLS policies, CSP and headers, input validation and API routes. Use when building an auth flow, writing RLS policies, setting CSP or security headers, validating input, or auditing security."
---

# Security Hardening

## Authentication

Resolve the auth library via the **database** capability slot in the skill matrix.

- Every sign in/up/out goes through a server-side POST handler with CSRF protection. Server Actions have it built in (POST-only, Origin checked).
- Refresh the session in request middleware (`proxy.ts` on Next 16) with HTTP-only cookies, and check protected routes there too.
- Store roles server-side, where the client cannot write them (for example a `profiles.roles` column behind RLS).

## CSP

Least privilege; whitelist only required external domains per directive (project-specific, see deployment customization). `'unsafe-inline'`/`'unsafe-eval'` may be needed in dev — use nonces/hashes in production. Validate shipped headers with `curl -I` against the preview URL.

## RLS

> SQL examples and role system: see the **database** skill (authoritative source for RLS).

- `ALTER TABLE x ENABLE ROW LEVEL SECURITY;` on every table — default-deny, explicit-allow.
- `auth.uid()` for auth checks, EXISTS subqueries for role checks.
- Never disable RLS in production; never rely on client-side authorization alone.
- CI gate: assert `SELECT relrowsecurity FROM pg_class WHERE relname = 'your_table'` is true, plus a positive/negative row-visibility test (other role must read 0 rows). Block merges on failure.

## API Security

Cron routes: require `authorization: Bearer ${process.env.CRON_SECRET}`, else return 401. Generate with `openssl rand -hex 32`; rotate quarterly.

Validate every Server Action and route handler input with a schema (e.g. Zod) before any DB operation. Client-side validation (e.g. React Hook Form) is for feedback only.

Cross-reference: the **api-patterns** skill for Server Action patterns; the **session-checkpoints** skill for checkpointing security-sensitive work.
