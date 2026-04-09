---
name: convex-database
description: "Convex reactive database patterns, schema design, real-time queries, mutations, actions, authentication, migrations, performance optimization, and component creation. Use when designing Convex schemas, writing queries/mutations, managing the Convex backend, setting up auth, migrating data, optimizing performance, or building Convex components."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Convex Database

For project-specific schema, functions, and deployment details, see [database-config.md](../../.opencastle/stack/database-config.md).

## Topic Routing

Read the matching reference file before writing code for any of these topics:

| Topic | Reference |
|-------|-----------|
| Project setup & scaffolding | `references/quickstart.md` |
| Schema & data migrations | `references/migrations.md` |
| Performance optimization | `references/performance-audit.md` |
| Authentication & access control | `references/auth-setup.md` |
| Component creation & isolation | `references/components.md` |

## Critical Development Rules

**Function Registration**
- Public: `query`/`mutation`/`action`; Private: `internalQuery`/`internalMutation`/`internalAction` (import from `./_generated/server`)
- Always include `returns` validator; use `returns: v.null()` when the function returns nothing (JS implicitly returns `null`)

**Function References**
- Use `api.filename.functionName` for public and `internal.filename.functionName` for internal functions (from `./_generated/api`)
- Never pass functions directly to `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` — always use function references

**Queries**
- Do NOT use `.filter()` — define an index in the schema and use `.withIndex()` instead
- Convex `.filter()` is equivalent to JS filtering — neither pushes the filter to storage; only `.withIndex()` actually reduces documents scanned
- Use `.unique()` for single document queries
- No `.delete()` on queries — collect results, then call `ctx.db.delete(row._id)` on each

**Mutations**
- Schema changes must not break existing documents — use widen-migrate-narrow when adding required fields; see `references/migrations.md`
- Skip no-op writes: check if values changed before calling `ctx.db.patch()` — no-op writes still trigger invalidation and replication

**Actions**
- Add `"use node";` at the top of files containing actions that use Node.js built-in modules
- Never use `ctx.db` inside actions — actions don't have database access; use `ctx.runQuery`/`ctx.runMutation` instead

**Schema**
- Index name must include all fields: `["field1", "field2"]` → `"by_field1_and_field2"`
- Index fields must be queried in definition order
- Do NOT define `_id` or `_creationTime` — they are automatic system fields
- Prefer compound indexes over redundant single-field indexes (e.g. `by_team_and_user` covers both `by_team` queries and `by_team_and_user` queries)

**Components**
- Authentication and environment variables must stay in the app — components cannot access `ctx.auth` or `process.env`
- Pass parent app IDs across the component boundary as `v.string()`, not `v.id("parentTable")`
- Import `query`/`mutation`/`action` from the component's own `./_generated/server`, not the app's generated files

**General**
- Schema-first design: define in `convex/schema.ts` using `defineSchema`/`defineTable`
- Mutations are ACID transactional; use actions for external API calls or side effects
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

### Protecting Functions with Auth

```typescript
import { query } from "./_generated/server";

export const getMyProfile = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    return await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier)
      )
      .unique();
  },
});
```

## Quick Workflow: Implement a schema change and deploy

1. Read `references/migrations.md` if the change is breaking (adding required fields, changing types, deleting fields)
2. Add or modify schema in `convex/schema.ts` and run `npx convex dev` locally; confirm the dev server starts and responds. Run a small validation script or sample queries to verify schema changes.
3. Write queries/mutations with `returns` validators and unit test against the dev server.
4. Run `npx convex deploy` to push the change to production.
5. Verify real-time queries in the app and run a quick smoke check:

```bash
curl -fsS https://<APP_URL>/health || (echo "health check failed" && exit 1)
```

If an issue occurs: roll back via `npx convex import` of the last good export, fix locally, and re-deploy.

## Validation Checkpoints

| Step | Checkpoint |
|------|-----------|
| Schema change | `npx convex dev` starts without errors |
| Migration needed | `references/migrations.md` checklist completed |
| Auth function | `ctx.auth.getUserIdentity()` returns non-null in test |
| Deploy | Smoke check passes; no `convex insights` regressions |
| Component | `npx convex codegen` succeeds; sibling functions inspected |
