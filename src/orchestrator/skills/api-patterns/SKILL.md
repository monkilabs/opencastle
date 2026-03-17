---
name: api-patterns
description: "API design patterns for route handlers, Server Actions, Zod validation, and external API integration. Use when creating API routes, Server Actions, or integrating external services."
---

# API Patterns

Project-specific config: [api-config.md](../../.opencastle/stack/api-config.md).

## Architecture

| Layer | Use for |
|-------|---------|
| **Server Actions** (preferred) | mutations, form submissions, data writes, auth |
| **Route Handlers** (`route.ts`) | analytics, autocomplete, external integrations |
| **Proxy layer** | IP rate limiting, fingerprinting, bot detection |

## Code Patterns

### Route Handler

```typescript
// app/api/example/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
const schema = z.object({ query: z.string().min(1).max(200) });

export async function GET(request: NextRequest) {
  const result = schema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!result.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  return NextResponse.json(data);
}
```

### Server Action

```typescript
'use server';
import { createServerClient } from '@libs/auth';
import { revalidatePath } from 'next/cache';

export async function submitAction(formData: FormData) {
  const { data: { user } } = await (await createServerClient()).auth.getUser();
  if (!user) return { error: 'Unauthorized' };
  revalidatePath('/places');
  return { success: true };
}
```

## Design Rules

- Server Actions for mutations; Route Handlers for external/public endpoints
- Validate all input with Zod on the server
- RESTful nouns: `/api/v1/places/:slug`; HTTP methods: `GET` read, `POST` create, `PATCH` update, `DELETE` remove
- Response envelope: `{ "data": ..., "meta": { "total": 42, "page": 1 } }`
- Error shape: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`
- Status codes: 400, 401, 403, 404, 422, 429, 500 — never leak stack traces
- Pagination: cursor-based preferred; params: `limit`, `cursor`, `sort`, `order`
- Versioning: `/api/v1/...`; add fields only, never remove/rename; deprecation headers before removal
- Rate-limit public endpoints; set `Cache-Control` and `ETag`/`If-None-Match` headers
