---
name: cloudflare-platform
description: "Creates and deploys Cloudflare Workers, configures wrangler.toml bindings, sets up KV/D1/R2 storage and Durable Objects, manages Pages deployments, and implements edge function patterns. Use when building or deploying Cloudflare Workers, setting up Pages, working with KV/D1/R2 storage, configuring wrangler.toml, or deploying edge applications."
---

# Cloudflare Platform

## Topic Routing

Read the matching reference before writing code for any of these topics:

| Topic | Reference |
|-------|-----------|
| Workers & edge functions | `references/workers.md` |
| Storage (KV, D1, R2) | `references/storage.md` |
| Pages & deployment | `references/deployment.md` |

## Critical Rules

**Workers**
- Use Web standard Fetch API, not Node.js globals (`process`, `Buffer`, `fs`) — Workers run in V8 isolates
- Define all bindings (KV, D1, R2, secrets) in `wrangler.toml` and access them via the `env` parameter
- Workers have 0ms cold starts — keep dependencies minimal; free tier has a 1MB bundle limit
- Use `ctx.waitUntil(promise)` for non-blocking side effects (logging, analytics) that outlast the response

**Storage Selection**
- **KV** — key-value store for config, sessions, cache (eventually consistent reads)
- **D1** — SQLite at the edge for relational SQL; strongly consistent
- **R2** — object/file storage (S3-compatible); no egress costs
- **Durable Objects** — stateful coordination; use for real-time collaboration, rate limiters, and counters
- **Queues** — async message processing; use for background tasks

**D1**
- Use `env.DB.prepare(sql).bind(...params).run()` for all DML; always use parameterized queries
- Use `env.DB.batch([...stmts])` for multiple queries in a single round trip
- D1 is SQLite — avoid MySQL/Postgres-only SQL syntax

**MCP Code Mode**
- The Cloudflare MCP uses Code Mode: only 2 tools are available — `search` and `execute`
- `search` searches the Cloudflare API spec; `execute` runs JavaScript against the Cloudflare API
- This approach uses ~1k tokens per operation vs ~244k for native tool exposure

**Wrangler**
- Use `wrangler.toml` (or `wrangler.jsonc`) for all config — `npx wrangler dev` for local dev
- `npx wrangler deploy` for production; `wrangler tail` for live log streaming
- Store secrets with `wrangler secret put VAR_NAME` — never hardcode in `wrangler.toml`

**Security**
- Access secrets via `env.VAR_NAME` — never hardcode credentials in Worker code
- Use Cloudflare Turnstile for CAPTCHA; configure WAF rules for API protection
- Validate all inputs at the Worker boundary — Workers are publicly accessible

## Basic Worker with KV

```typescript
// src/index.ts
export interface Env {
  SESSIONS: KVNamespace; // bound in wrangler.toml
  API_SECRET: string;    // secret bound in wrangler.toml
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/session') {
      const sessionId = request.headers.get('x-session-id');
      if (!sessionId) return new Response('Missing session', { status: 400 });

      const data = await env.SESSIONS.get(sessionId, { type: 'json' });
      if (!data) return new Response('Not found', { status: 404 });

      // Non-blocking analytics — does not delay the response
      ctx.waitUntil(logAnalytics(sessionId));

      return Response.json(data);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

## Storage Decision Guide

```
I need to store data → What type?
├── Key-value pairs (cache, sessions, feature flags) → KV
├── Relational/SQL data → D1
├── Files, images, blobs → R2
├── Stateful coordination (counters, locks, chat) → Durable Objects
└── Async job queue → Queues
```

## Reference Files

- `references/workers.md` — Worker structure, bindings, env, waitUntil, Durable Objects, Cron Triggers, Wrangler commands
- `references/storage.md` — KV, D1, R2 APIs; decision guide for choosing between storage types
- `references/deployment.md` — Pages setup, wrangler.toml, secrets, custom domains, CI/CD integration

## Quick Workflow: Deploy a Cloudflare Worker
1. Create project: `npm create cloudflare@latest` and select "Hello World" Worker template
2. Define bindings (KV, D1, secrets) in `wrangler.toml` under `[[kv_namespaces]]` / `[[d1_databases]]`
3. Verify resources exist: `npx wrangler kv:namespace list` / `npx wrangler d1 list` — create any missing resources before continuing
   - **If resource missing:** `npx wrangler kv:namespace create <NAME>` or `npx wrangler d1 create <DB>` → copy the ID into `wrangler.toml`
4. Implement the `fetch` handler in `src/index.ts` — type the `Env` interface to match your bindings
5. Test locally: `npx wrangler dev` — verify the worker responds correctly at `http://localhost:8787`
   - **If dev fails:** check `wrangler.toml` syntax → verify binding IDs match → run `npx wrangler whoami` to confirm account auth
6. Deploy: `npx wrangler deploy` — confirm the deployment URL is returned
   - **If deploy fails:** check `wrangler.toml` bindings match created resources → verify `compatibility_date` is set → check account permissions
7. Monitor with `wrangler tail` for live logs from production
