---
name: security-hardening
description: "Security architecture: authentication, authorization, RLS policies, CSP, input validation, API security. Use when implementing auth flows, writing RLS policies, configuring CSP/headers, validating inputs, or auditing security. Trigger terms: RLS, CSP, Server Actions, Zod, auth flow"
---

# Security Hardening

## Authentication

Resolve the auth library via the **database** capability slot in the skill matrix.

- Every sign in/up/out goes through a Server Action (POST-only → automatic CSRF protection).
- Session refresh in middleware `updateSession()` with HTTP-only cookies; protected routes checked in middleware.
- User roles live in `profiles.roles TEXT[]`.

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

Zod schema validation on every Server Action and route handler before any DB operation; React Hook Form client-side.

Cross-reference: [api-patterns/SKILL.md](../api-patterns/SKILL.md#architecture) for Server Action patterns; [session-checkpoints/SKILL.md](../session-checkpoints/SKILL.md) for checkpointing security-sensitive work.
