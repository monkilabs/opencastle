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

Route files live at `app/api/<name>/route.ts` or `app/<segment>/route.ts`.

## Rules

- Validate every input with Zod on the server at the top of the handler; 400 on parse failure.
- Response envelope: `{ "data": ..., "meta": { "total": 42, "page": 1 } }`
- Error shape: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }` — never leak stack traces. Status codes: 400, 401, 403, 404, 422, 429, 500.
- RESTful nouns, versioned: `/api/v1/places/:slug`. Add fields only — never remove or rename; deprecation headers before removal.
- Pagination: cursor-based preferred; params `limit`, `cursor`, `sort`, `order`.
- Retry external API calls twice with linear backoff (500 ms × attempt).
- Rate-limit public endpoints; set `Cache-Control` and `ETag`/`If-None-Match`.

Smoke-test a new route with `curl -fsS "http://localhost:3000/api/<name>?query=test"`.
