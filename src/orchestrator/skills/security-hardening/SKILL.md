---
name: security-hardening
description: "Security architecture including authentication, authorization, RLS policies, security headers, CSP, input validation, API security, and OAuth patterns. Use when implementing auth flows, writing RLS policies, configuring security headers, validating inputs, or auditing security."
---

# Security Hardening

## Architecture

| Layer | Tool | Protection |
|-------|------|------------|
| Edge | WAF / CDN | DDoS, bot detection |
| Headers | Framework config | HSTS, CSP, X-Frame-Options |
| Middleware | Proxy layer | Session refresh, protected routes |
| Server Actions | Auth provider | Authentication, CSRF |
| Database | RLS Policies | Row-level authorization |
| API Routes | `CRON_SECRET` | Cron job authorization |
| Input | Zod | Schema validation |
| Rate Limiting | Proxy layer | IP-based throttling |

## Authentication

Auth provider with Server Actions pattern. Resolve library via **database** capability slot in skill matrix.

| Concern | Approach |
|---------|----------|
| Sign in/up/out | Server Actions (POST-only → automatic CSRF protection) |
| Session refresh | Middleware `updateSession()`, HTTP-only cookies |
| Protected routes | Middleware check |
| OAuth | Configured in auth provider dashboard |
| User roles | `profiles.roles TEXT[]` |
| Cron auth | `CRON_SECRET` env var, `Bearer` token in `authorization` header |

## CSP

Principle of least privilege. External domains are project-specific (see deployment customization).

- `default-src 'self'` — deny by default
- `object-src 'none'` — block plugins
- `frame-ancestors 'self'` — prevent clickjacking
- `upgrade-insecure-requests` — enforce HTTPS
- Whitelist only required external domains per directive

**Note:** `'unsafe-inline'`/`'unsafe-eval'` may be required in dev mode — use nonces/hashes in production.

## RLS

> **SQL examples and role system:** See the **database** skill (authoritative source for RLS).

- `ALTER TABLE x ENABLE ROW LEVEL SECURITY;` on all tables
- Use `auth.uid()` for auth checks; EXISTS subqueries for role checks
- Never rely solely on client-side authorization; never disable RLS in production

## API Security

```typescript
// Cron authorization pattern
const authHeader = request.headers.get('authorization');
if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

Generate secret: `openssl rand -hex 32`. Rotate quarterly.

Input: Zod schemas in all Server Actions and route handlers; React Hook Form client-side.

## Critical Rules

1. Never commit secrets — use env vars.
2. Server Actions for all auth operations.
3. RLS on all tables — default-deny, explicit-allow.
4. Validate all inputs with Zod before DB operations.
5. Sanitize user content (escape HTML).
6. Parameterized queries (DB client handles automatically).
7. Rotate secrets quarterly.
