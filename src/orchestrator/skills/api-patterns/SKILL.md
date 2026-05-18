---
name: api-patterns
description: "Creates API route handlers, implements Server Actions with Zod schema validation, integrates external REST APIs with error handling. Use when adding endpoints, building request handlers, or wiring external services (endpoint, REST API, request handling, fetch, .ts route files)."
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

### Fetching external APIs — example with retry and error handling

```ts
import fetch from 'node-fetch';
async function fetchWithRetry(url:string, opts={}, retries=2){
  for(let i=0;i<=retries;i++){
    try{ const res = await fetch(url, opts); if(!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); }
    catch(e){ if(i===retries) throw e; await new Promise(r=>setTimeout(r, 500*(i+1))); }
  }
}

// usage
const data = await fetchWithRetry('https://api.example.com/data');
```
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

## Quick Workflow
1. Create route file: `app/api/<name>/route.ts` or `app/<segment>/route.ts`
2. Add Zod schema; validate input at top of handler
3. Implement handler logic with explicit error/response shapes
4. Add unit/integration tests for validation, happy/error paths
5. Verification: run a quick smoke test (example):

```bash
curl -fsS "http://localhost:3000/api/<name>?query=test" || (echo "route failed" && exit 1)
```

## Design Rules

- Server Actions for mutations; Route Handlers for external/public endpoints
- Validate all input with Zod on server
- RESTful nouns: `/api/v1/places/:slug`; HTTP methods: `GET` read, `POST` create, `PATCH` update, `DELETE` remove
- Response envelope: `{ "data": ..., "meta": { "total": 42, "page": 1 } }`
- Error shape: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`
- Status codes: 400, 401, 403, 404, 422, 429, 500 — never leak stack traces
- Pagination: cursor-based preferred; params: `limit`, `cursor`, `sort`, `order`
- Versioning: `/api/v1/...`; add fields only, never remove/rename; deprecation headers before removal
- Rate-limit public endpoints; set `Cache-Control`, `ETag`/`If-None-Match` headers
