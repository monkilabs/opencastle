---
name: api-patterns
description: "Conventions for HTTP endpoints, server actions and calls to external APIs: the contract, input validation, error shapes, status codes, versioning, pagination, retries and caching. Use when adding or changing an endpoint or server action, or wiring an external API."
---

# API Patterns

The project's endpoints and where they live: `.opencastle/stack/api-config.md` when it has one, and the skill bound to the **framework** slot. Match what the existing endpoints do; where they disagree, follow the majority and say so, rather than add a third way.

## Contract first

Decide the request, the response, the status codes and the error cases before you write the handler. Writing the handler first is how inconsistent APIs happen.

- **Validate** every input with a schema at the top of the handler (Zod, Pydantic, the framework's validator): 400 or 422 on failure, naming the field.
- **One error shape**, such as `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`, with no stack trace or query in it. The status says what happened: 400, 401, 403, 404, 409, 422, 429, 500.
- **Lists are paginated**, with a cursor when the data changes under the reader, and `limit` capped on the server.
- **Changes are additive.** Add fields; never remove or rename one a client may use without a new version and a deprecation period.

## Writes and side effects

- A mutation a client may retry is idempotent: an idempotency key, or an upsert on a natural key.
- Authorization is checked on the server for every call (**security-hardening**).

## External APIs

- A timeout on every call. Retry only what is safe to repeat, at most twice, with backoff.
- Map their errors to your error shape, and log the upstream detail on the server.

## Limits and caching

Rate-limit public endpoints. Set `Cache-Control`, and an `ETag` on responses clients poll.

Smoke-test a new endpoint against the dev server with `curl -fsS` before you call it done.
