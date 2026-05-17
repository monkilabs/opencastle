---
name: security-hardening
description: "Security architecture: authentication, authorization, RLS policies, CSP, input validation, API security. Use when implementing auth flows, writing RLS policies, configuring CSP/headers, validating inputs, or auditing security. Trigger terms: RLS, CSP, Server Actions, Zod, auth flow"
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

Least privilege. External domains are project-specific (see deployment customization).

- `default-src 'self'` — deny by default
- `object-src 'none'` — block plugins
- `frame-ancestors 'self'` — prevent clickjacking
- `upgrade-insecure-requests` — enforce HTTPS
- Whitelist only required external domains per directive

**Note:** `'unsafe-inline'`/`'unsafe-eval'` may be required in dev mode — use nonces/hashes in production.

**Examples** — Next.js `next.config.js` headers + middleware:

```js
// next.config.js
module.exports = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            // minimal example; restrict further per app needs
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.example.com;",
          },
        ],
      },
    ];
  },
};
```

```js
// middleware.js (Next.js Edge middleware example)
import { NextResponse } from 'next/server';

export function middleware(request) {
  const res = NextResponse.next();
  res.headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:;");
  return res;
}
```

## RLS

> **SQL examples and role system:** See the **database** skill (authoritative source for RLS).

- `ALTER TABLE x ENABLE ROW LEVEL SECURITY;` on all tables
- Use `auth.uid()` for auth checks; EXISTS subqueries for role checks
- Never rely solely on client-side authorization; never disable RLS in production

**RLS verification & test pattern**

1. Confirm RLS is enabled for a table (Postgres):

```sql
-- run in psql
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = 'your_table_name';
```

`relrowsecurity = true` indicates RLS enabled.

2. Test pattern: verify user without privileges cannot read rows.

```sql
-- As owner (create test row)
INSERT INTO your_table_name (id, owner_id, data) VALUES (1, 'owner-uid', 'secret');

-- As another_role (should return zero rows if RLS correct)
SET ROLE other_role;
SELECT * FROM your_table_name WHERE id = 1;
-- expected: 0 rows
```

Automate this check in CI: run the enabling query + positive/negative test as part of the security gate.

## Server Action Zod example

```ts
'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';

const schema = z.object({ name: z.string().min(1), price: z.number().positive() });

export async function createItem(formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: 'Validation failed', details: parsed.error.format() };
  // insert into DB ...
  revalidatePath('/items');
  return { success: true };
}
```

## API Security

```typescript
// Cron authorization pattern
const authHeader = request.headers.get('authorization');
if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

Generate secret: `openssl rand -hex 32`. Rotate quarterly.

Input: Zod schemas in all Server Actions, route handlers; React Hook Form client-side.

## Critical Rules

1. Never commit secrets — use env vars.
2. Server Actions for all auth operations.
3. RLS on all tables — default-deny, explicit-allow.
4. Validate all inputs with Zod before DB operations.
5. Sanitize user content (escape HTML).
6. Parameterized queries (DB client handles automatically).
7. Rotate secrets quarterly.

## Implementation checklist
1. Enable RLS on tables, add automated enablement check in CI (example: `SELECT relrowsecurity FROM pg_class WHERE relname = 'your_table'`).
2. Configure authentication + session middleware; verify via integration smoke test against protected endpoint (e.g., `/api/me`).
3. Add CSP + security headers in `next.config.js` or middleware; validate with `curl -I` against preview URL.
4. Add Zod validation to all Server Actions, route handlers (see Zod example above).
5. Run security audit (RLS positive/negative tests, header validation, input fuzzing); block merges on failing gates.

Cross-reference: [api-patterns/SKILL.md](../api-patterns/SKILL.md#architecture) for Server Action patterns; [session-checkpoints/SKILL.md](../session-checkpoints/SKILL.md) for checkpointing security-sensitive work.
