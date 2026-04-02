---
name: convex-database
description: "Convex reactive database patterns, schema design, real-time queries, mutations, actions, and deployment best practices. Use when designing Convex schemas, writing queries/mutations, or managing the Convex backend."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Convex Database

For project-specific schema, functions, and deployment details, see [database-config.md](../../.opencastle/stack/database-config.md).

## Critical Development Rules

**Function Registration**
- Public: `query`/`mutation`/`action`; Private: `internalQuery`/`internalMutation`/`internalAction` (import from `./_generated/server`)
- Always include `returns` validator; use `returns: v.null()` when the function returns nothing (JS implicitly returns `null`)

**Function References**
- Use `api.filename.functionName` for public and `internal.filename.functionName` for internal functions (from `./_generated/api`)
- Never pass functions directly to `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` — always use function references

**Queries**
- Do NOT use `.filter()` — define an index in the schema and use `.withIndex()` instead
- Use `.unique()` for single document queries
- No `.delete()` on queries — collect results, then call `ctx.db.delete(row._id)` on each

**Actions**
- Add `"use node";` at the top of files containing actions that use Node.js built-in modules
- Never use `ctx.db` inside actions — actions don't have database access; use `ctx.runQuery`/`ctx.runMutation` instead

**Schema**
- Index name must include all fields: `["field1", "field2"]` → `"by_field1_and_field2"`
- Index fields must be queried in definition order
- Do NOT define `_id` or `_creationTime` — they are automatic system fields

**General**
- Schema-first design: define in `convex/schema.ts` using `defineSchema`/`defineTable`
- Mutations are ACID transactional; use actions for external API calls or side effects
- Never await queries in mutations — they run in separate contexts
- Use `.paginate()` for large result sets
- Use `Id<'tableName'>` for document ID types (from `./_generated/dataModel`)
- Use `v.null()` not `v.undefined()` — `undefined` is not a valid Convex value
- Environment variables: set via Convex dashboard; access with `process.env` in actions only

## Schema Patterns

### Defining Tables
```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("user")),
  })
    .index("by_email", ["email"])
    .index("by_role", ["role"]),
});
```

### Query Functions
```typescript
import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { role: v.optional(v.string()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    if (args.role) {
      return await ctx.db.query("users")
        .withIndex("by_role", q => q.eq("role", args.role!))
        .collect();
    }
    return await ctx.db.query("users").collect();
  },
});
```

### Mutations
```typescript
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: { name: v.string(), email: v.string() },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { ...args, role: "user" });
  },
});
```

## Real-Time Patterns

- Use `useQuery` hook for automatic real-time subscriptions
- Queries re-run when any referenced table data changes
- Use `useMutation` for optimistic updates
- Paginated queries support real-time updates with `.paginate()`

## Deployment

- Deploy with `npx convex deploy`
- Use `npx convex dev` for local development with hot reload
- Schema changes are automatically migrated
- Use `npx convex import` / `npx convex export` for data management

## Quick Workflow: Implement a schema change and deploy
1. Add or modify schema in `convex/schema.ts` and run `npx convex dev` locally; confirm the dev server starts and responds (checkpoint: `http://localhost:8888` or the configured port). Run a small validation script or sample queries to verify schema changes (validation checkpoint).
2. Write queries/mutations with `returns` validators and unit test against the dev server.
3. Run `npx convex deploy` to push the change to production.
4. Verify real-time queries in the app, run a small data migration if required (`convex import/export`), and run a quick smoke check against your app (example):

```bash
curl -fsS https://<APP_URL>/health || (echo "health check failed" && exit 1)
```

If an issue occurs: roll back via `npx convex import` of the last good export, fix locally, and re-deploy. After a rollback, re-run the same smoke check to confirm services are restored.
