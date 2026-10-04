---
name: cloudflare-platform
description: "Cloudflare Workers, Pages, wrangler bindings, KV/D1/R2 storage and Durable Objects. Use when building or deploying a Worker or Pages site, editing wrangler.toml, or using KV, D1, R2 or Durable Objects."
---

# Cloudflare Platform

## Workers

- V8 isolates, not Node: `process`, `Buffer`, `fs` do not exist unless `compatibility_flags = ["nodejs_compat"]` is set. `compatibility_date` must be set or deploys fail.
- Worker size limit is 3 MB compressed on the Free plan, 10 MB on Paid. Keep dependencies minimal.
- `ctx.waitUntil(promise)` for side effects that must outlive the response (logging, analytics).
- Bindings are reachable only via the handler's `env` argument, and must exist in both `wrangler.toml` and the `Env` interface.
- Durable Objects need `[[durable_objects.bindings]]` **and** a `[[migrations]]` block with `new_classes = ["Counter"]` — the binding alone will not deploy.

## Storage selection

KV: config/sessions/cache, eventually consistent. D1: relational SQLite, strongly consistent. R2: files/blobs, S3-compatible, no egress cost. Durable Objects: coordination, counters, locks, realtime. Queues: async jobs.

Limits: KV value 25MB, key 512 bytes, metadata 1024 bytes, read lag up to 60s. R2 needs multipart upload above 100MB. D1 is SQLite — no MySQL/Postgres-only syntax; always `.bind()` params; `env.DB.batch([...])` collapses round trips.

## Wrangler

- `wrangler secret put NAME [--env staging]` — secrets never live in `wrangler.toml`; local dev uses `.dev.vars`.
- KV bindings need `preview_id` for `wrangler dev --remote`.
- D1 migrations: pass the target explicitly — `wrangler d1 migrations apply <db> --local` for dev, `--remote` for production.
- `wrangler tail` for live production logs; `wrangler deployments list` + `wrangler rollback <version-id>`; `wrangler whoami` to confirm the account.

## MCP

Code Mode exposes exactly two tools: `search` (Cloudflare API spec) and `execute` (JavaScript against the API). ~1k tokens per operation vs ~244k for native tool exposure.

Docs: https://developers.cloudflare.com/
