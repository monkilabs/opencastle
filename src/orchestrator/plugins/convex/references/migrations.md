# Convex Schema & Data Migrations

Safe migration of Convex schemas and data when making breaking changes.

## Core Constraint

Convex will not let you deploy a schema that does not match the data at rest:
- Cannot add a required field if existing documents don't have it
- Cannot change a field's type if existing documents have the old type
- Cannot remove a field from the schema if existing documents still have it

## Safe Changes (No Migration Needed)

Adding an optional field or a new table requires no migration:

```typescript
// Adding optional field — safe
users: defineTable({
  name: v.string(),
  bio: v.optional(v.string()),  // new optional field
})

// Adding new table — safe
posts: defineTable({
  userId: v.id("users"),
  title: v.string(),
}).index("by_user", ["userId"])
```

## Widen-Migrate-Narrow Workflow

Every breaking migration follows this multi-deploy pattern:

**Deploy 1 — Widen:**
1. Update schema to allow both old and new formats (e.g., add optional new field)
2. Update code to handle both formats when reading
3. Update code to write the new format for new documents
4. Deploy

**Between deploys — Migrate data:**
5. Run migration to backfill existing documents
6. Verify all documents are migrated

**Deploy 2 — Narrow:**
7. Update schema to require the new format only
8. Remove code that handles the old format
9. Deploy

## Common Patterns

### Adding a Required Field

```typescript
// Deploy 1: make optional
users: defineTable({
  name: v.string(),
  role: v.optional(v.union(v.literal("user"), v.literal("admin"))),
})

// Migration: backfill
export const addDefaultRole = migrations.define({
  table: "users",
  migrateOne: async (ctx, user) => {
    if (user.role === undefined) {
      await ctx.db.patch(user._id, { role: "user" });
    }
  },
});

// Deploy 2: make required
users: defineTable({
  name: v.string(),
  role: v.union(v.literal("user"), v.literal("admin")),
})
```

### Deleting a Field

```typescript
// Deploy 1: Make optional
// isPro: v.boolean()  →  isPro: v.optional(v.boolean())

// Migration: clear the field
export const removeIsPro = migrations.define({
  table: "teams",
  migrateOne: async (ctx, team) => {
    if (team.isPro !== undefined) {
      await ctx.db.patch(team._id, { isPro: undefined });
    }
  },
});

// Deploy 2: Remove isPro from schema entirely
```

### Changing a Field Type

Create a new field rather than modifying the existing one:

```typescript
// Deploy 1: Add new field, keep old field optional
// isPro: v.boolean()  →  isPro: v.optional(v.boolean()), plan: v.optional(...)

// Migration: convert old to new
export const convertToEnum = migrations.define({
  table: "teams",
  migrateOne: async (ctx, team) => {
    if (team.plan === undefined) {
      await ctx.db.patch(team._id, {
        plan: team.isPro ? "pro" : "basic",
        isPro: undefined,
      });
    }
  },
});

// Deploy 2: Remove isPro, make plan required
```

### Splitting Nested Data Into a Separate Table

```typescript
export const extractPreferences = migrations.define({
  table: "users",
  migrateOne: async (ctx, user) => {
    if (user.preferences === undefined) return;
    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    if (!existing) {
      await ctx.db.insert("userPreferences", {
        userId: user._id,
        ...user.preferences,
      });
    }
    await ctx.db.patch(user._id, { preferences: undefined });
  },
});
```

## @convex-dev/migrations Component

For any non-trivial migration, use this component — it handles batching, cursor-based pagination, state tracking, resume from failure, dry runs, and progress monitoring.

See `references/migrations-component.md` for installation, setup, and full API.

```bash
npm install @convex-dev/migrations
```

```typescript
// convex/convex.config.ts
import migrations from "@convex-dev/migrations/convex.config.js";
const app = defineApp();
app.use(migrations);

// convex/migrations.ts
import { Migrations } from "@convex-dev/migrations";
export const migrations = new Migrations<DataModel>(components.migrations);
export const run = migrations.runner();
```

Run from CLI:

```bash
npx convex run migrations:run '{"fn": "migrations:addDefaultRole"}'
# Dry run first:
npx convex run migrations:runIt '{"dryRun": true}'
# Check status:
npx convex run --component migrations lib:getStatus --watch
```

### Small Table Shortcut

For tables with only a few thousand documents, use a single `internalMutation` without the component:

```typescript
export const backfillSmallTable = internalMutation({
  handler: async (ctx) => {
    const docs = await ctx.db.query("smallConfig").collect();
    for (const doc of docs) {
      if (doc.newField === undefined) {
        await ctx.db.patch(doc._id, { newField: "default" });
      }
    }
  },
});
```

## Zero-Downtime Strategies

### Dual Write (Preferred)

Write to both old and new structures. Read from old until migration is complete. Safe to roll back at any point.

```typescript
// Good: writing both formats during migration
export const createTeam = mutation({
  handler: async (ctx, args) => {
    const plan = args.isPro ? "pro" : "basic";
    await ctx.db.insert("teams", {
      name: args.name,
      isPro: args.isPro,  // old format
      plan,               // new format
    });
  },
});
```

### Dual Read

Read both formats (preferring new), write only the new format:

```typescript
function getTeamPlan(team: Doc<"teams">): "basic" | "pro" {
  if (team.plan !== undefined) return team.plan;
  return team.isPro ? "pro" : "basic";
}
```

## Verification

Query to check remaining unmigrated documents:

```typescript
export const verifyMigration = query({
  handler: async (ctx) => {
    const remaining = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("role"), undefined))
      .take(10);
    return { complete: remaining.length === 0 };
  },
});
```

## Common Pitfalls

1. **Making a field required before migrating data** — deploy rejects because documents lack the field
2. **Using `.collect()` on large tables** — hits transaction limits; use the migrations component
3. **Not writing the new format before migrating** — creates missed documents during migration window
4. **Skipping the dry run** — use `dryRun: true` to validate before touching production data
5. **Deleting fields prematurely** — prefer `v.optional` with a deprecation comment

## Migration Checklist

- [ ] Identified the breaking change and planned the multi-deploy workflow
- [ ] Widened schema to allow both old and new formats
- [ ] Updated code to handle both formats when reading
- [ ] Updated code to write the new format for new documents
- [ ] Deployed widened schema
- [ ] Defined migration using `@convex-dev/migrations`
- [ ] Tested with `dryRun: true`
- [ ] Ran migration and monitored status
- [ ] Verified all documents are migrated
- [ ] Narrowed schema to require new format only
- [ ] Cleaned up code handling old format
- [ ] Deployed final schema
