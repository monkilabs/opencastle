---
name: convex-database
description: "Convex reactive database patterns, schema design, real-time queries, mutations, actions, authentication, migrations, performance optimization, and component creation. Use when designing Convex schemas, writing queries/mutations, managing the Convex backend, setting up auth, migrating data, optimizing performance, or building Convex components."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Convex Database

Project-specific schema, functions, and deployment details: [database-config.md](../../.opencastle/stack/database-config.md).
Official docs: https://docs.convex.dev/

## Hard limits per transaction

Exceeding one of these fails the transaction, so design against them rather than
discovering them:

| Limit | Value |
|-------|-------|
| Query/mutation execution time | 1 second (your code only, excludes DB operations) |
| Action execution time | 10 minutes |
| Data read / written | 16 MiB each |
| Documents scanned | 32,000 — includes documents `.filter()` discards |
| Index ranges read | 4,096 (each `db.get` and `db.query` counts) |
| Documents written | 16,000 |
| Function return value | 16 MiB |

Batch anything larger into a cursor-based self-scheduling `internalMutation`:
`paginate({ cursor, numItems })`, then `ctx.scheduler.runAfter(0, internal.x.batch,
{ cursor: result.continueCursor })` while `!result.isDone` — or use the migrations
component.

## Rules That Are Easy To Get Wrong

**Functions**
- Public: `query`/`mutation`/`action`. Internal: `internalQuery`/`internalMutation`/`internalAction`. All from `./_generated/server`.
- Always set a `returns` validator; use `returns: v.null()` when the function returns nothing (JS implicitly returns `null`).
- Pass function *references* (`api.file.fn`, `internal.file.fn` from `./_generated/api`) to `ctx.runQuery`/`runMutation`/`runAction` — never the function itself.

**Queries**
- Do not use `.filter()`. Convex's `.filter()` performs the same as filtering in JS — neither pushes the predicate to storage. Only `.withIndex()`/`.withSearchIndex()` reduce documents scanned.
- Queries have no `.delete()`: collect results, then `ctx.db.delete(row._id)` per row.
- `.unique()` for single-document reads.

**Mutations**
- Skip no-op writes: compare before `ctx.db.patch()` — an unchanged write still costs invalidation, replication, and trigger execution.
- Mutations are ACID transactional; use actions for external API calls and side effects.
- Breaking schema changes need widen-migrate-narrow across two deploys (widen, migrate, then narrow).

**Actions**
- `ctx.db` does not exist in actions — use `ctx.runQuery`/`ctx.runMutation`.
- Files containing actions that use Node.js built-in modules need `"use node";` at the top.

**Schema**
- Index names must list every field: `["team", "user"]` → `by_team_and_user`. Index fields must be queried in definition order.
- Never define `_id` or `_creationTime` — they are automatic system fields.
- Prefer one compound index over redundant single-field indexes (`by_team_and_user` also serves `by_team` queries).
- Use `v.null()`, never `v.undefined()` — `undefined` is not a valid Convex value.

**Components**
- Components cannot access `ctx.auth` or `process.env`. Resolve both in the app and pass values across.
- Parent-app IDs cross the boundary as `v.string()`, not `v.id("parentTable")`.
- Import `query`/`mutation`/`action` from the component's own `./_generated/server`.

**Environment**
- Set Convex env vars in the dashboard or with `npx convex env set`; read them with `process.env` in actions only.

## Deploy Loop

`npx convex dev` (long-running watcher, interactive on first run — ask the user to run it) → verify → `npx convex deploy`. If a deploy goes wrong, roll back by `npx convex import` of the last good export, fix locally, re-deploy.

| Step | Checkpoint |
|------|-----------|
| Schema change | `npx convex dev` starts without errors |
| Breaking change | checklist completed |
| Auth function | `ctx.auth.getUserIdentity()` non-null in test |
| Deploy | Smoke check passes; no `npx convex insights` regressions |
| Component | `npx convex codegen` succeeds |
