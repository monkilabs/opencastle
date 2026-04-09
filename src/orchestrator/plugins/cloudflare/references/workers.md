# Cloudflare Workers

## Worker Structure

```typescript
// src/index.ts
export interface Env {
  // Declare all bindings here — must match wrangler.toml
  MY_KV: KVNamespace;
  MY_DB: D1Database;
  MY_BUCKET: R2Bucket;
  MY_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle HTTP requests
    return new Response('Hello World');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Handle Cron Triggers
    ctx.waitUntil(doScheduledWork(env));
  },
} satisfies ExportedHandler<Env>;
```

## Bindings in wrangler.toml

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "MY_KV"
id = "abc123"

[[d1_databases]]
binding = "MY_DB"
database_name = "my-db"
database_id = "xyz789"

[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "my-bucket"

[vars]
ENVIRONMENT = "production"

# Secrets are NOT stored in wrangler.toml — use: wrangler secret put SECRET_NAME
```

## ctx.waitUntil

Use `ctx.waitUntil()` for async work that must not block the response:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handleRequest(request, env);

    // Logs, analytics, cache warming — run after response is sent
    ctx.waitUntil(logToAnalytics(request, response, env));

    return response;
  },
};
```

## Routing

```typescript
import { Router } from 'itty-router'; // popular lightweight router

const router = Router();

router
  .get('/api/users', (request, env) => handleGetUsers(env))
  .post('/api/users', (request, env) => handleCreateUser(request, env))
  .all('*', () => new Response('Not found', { status: 404 }));

export default { fetch: router.fetch } satisfies ExportedHandler<Env>;
```

## Durable Objects (basics)

```typescript
// src/counter.ts
export class Counter implements DurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const count = (await this.state.storage.get<number>('count')) ?? 0;
    const newCount = count + 1;
    await this.state.storage.put('count', newCount);
    return Response.json({ count: newCount });
  }
}
```

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_classes = ["Counter"]
```

## Cron Triggers

```toml
# wrangler.toml
[triggers]
crons = ["0 * * * *"]  # every hour
```

## Wrangler Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development server (hot reload) |
| `npx wrangler deploy` | Deploy to production |
| `npx wrangler tail` | Live log streaming from production |
| `wrangler secret put NAME` | Store a secret securely |
| `wrangler kv:key put --binding=KV key value` | Write a KV value |
| `wrangler d1 execute DB --command="SELECT 1"` | Run a D1 SQL command |
| `wrangler whoami` | Verify authenticated account |
