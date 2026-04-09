# Convex Component Creation

Create reusable Convex components with clear boundaries and a small app-facing API.

## Core Concepts

Components are isolated units of backend logic with their own tables and functions. They must be justified — prefer normal app code if the feature doesn't need isolated tables or reusable persistent state.

**Golden Rule — Top-Down Execution:** Data and context always flow from app to component, never from component to app. The component cannot access `ctx.auth`, cannot read `process.env`, and cannot call app functions.

## Architecture Choice

| Goal | Shape | Reference |
|------|-------|-----------|
| Component for this app only | Local | Default |
| Publish or share across apps | Packaged | `references/components-advanced.md` |
| Not sure | Default to local | — |

Default: put under `convex/components/<componentName>/`

## Component Skeleton

```ts
// convex/components/notifications/convex.config.ts
import { defineComponent } from "convex/server";
export default defineComponent("notifications");
```

```ts
// convex/components/notifications/schema.ts
export default defineSchema({
  notifications: defineTable({
    userId: v.string(),
    message: v.string(),
    read: v.boolean(),
  }).index("by_user", ["userId"]),
});
```

```ts
// convex/components/notifications/lib.ts
import { mutation, query } from "./_generated/server.js";

export const send = mutation({
  args: { userId: v.string(), message: v.string() },
  returns: v.id("notifications"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.userId,
      message: args.message,
      read: false,
    });
  },
});
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import notifications from "./components/notifications/convex.config.js";

const app = defineApp();
app.use(notifications);
export default app;
```

```ts
// convex/notifications.ts — app-side wrapper
export const sendNotification = mutation({
  args: { message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await ctx.runMutation(components.notifications.lib.send, {
      userId,
      message: args.message,
    });
    return null;
  },
});
```

Note: a function in `convex/components/notifications/lib.ts` is called as `components.notifications.lib.send`.

## Critical Rules

- **Auth stays in the app** — `ctx.auth` is not available inside components. Resolve auth in the app and pass the userId.
- **Env access stays in the app** — component functions cannot read `process.env`.
- **Parent IDs cross the boundary as strings** — use `v.string()`, not `v.id("parentTable")` for app-owned tables inside component args.
- **Import from component's own generated files** — use `./_generated/server` not the app's generated files.
- **Never expose component functions directly to clients** — create app wrappers when client access is needed.
- **HTTP routes stay in the app** — if the component defines HTTP handlers, mount them in `convex/http.ts`.
- **Use `paginator` from `convex-helpers`** for pagination across component boundaries — built-in `.paginate()` doesn't work across the boundary.
- **Add `args` and `returns` validators to all public component functions** — the boundary requires explicit type contracts.

## Key Patterns

### Auth and Env Access

```ts
// Good: app resolves auth and env, passes explicit values
const userId = await getAuthUserId(ctx);
if (!userId) throw new Error("Not authenticated");

await ctx.runAction(components.translator.translate, {
  userId,
  apiKey: process.env.OPENAI_API_KEY,
  text: args.text,
});
```

### IDs Across the Boundary

```ts
// Bad: parent app table IDs are not valid component validators
args: { userId: v.id("users") }

// Good: treat parent-owned IDs as strings at the boundary
args: { userId: v.string() }
```

### Client-Facing API

```ts
// Bad: component function directly callable by clients
export const send = components.notifications.send;

// Good: re-export through an app mutation
export const sendNotification = mutation({
  args: { message: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await ctx.runMutation(components.notifications.lib.send, { userId, message: args.message });
    return null;
  },
});
```

## Step-by-Step Workflow

1. Plan what tables the component owns, what public functions it exposes, what data must be passed from the app, and what stays in the app as wrappers
2. Create `convex.config.ts`, `schema.ts`, and function files under `convex/components/<name>/`
3. Import `query`, `mutation`, `action` from the component's own `./_generated/server`
4. Wire into the app with `app.use(...)` in `convex/convex.config.ts`
5. Call the component from the app through `components.<name>` using `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction`
6. Create app wrapper functions for any client access needed
7. Run `npx convex dev` and fix codegen/type issues

## Validation

Try validation in this order:
1. `npx convex codegen --component-dir convex/components/<name>`
2. `npx convex codegen`
3. `npx convex dev`

## Advanced Patterns

For function handles (callbacks), deriving validators from schema, globals tables, and class-based client wrappers, see `references/components-advanced.md`.

## Checklist

- [ ] Confirmed a component is the right abstraction
- [ ] Planned tables, public API, boundaries, and app wrappers
- [ ] Component lives under `convex/components/<name>/`
- [ ] Component imports from its own `./_generated/server`
- [ ] Auth, env access, and HTTP routes stay in the app
- [ ] Parent app IDs cross the boundary as `v.string()`
- [ ] Public functions have `args` and `returns` validators
- [ ] Ran `npx convex dev` and fixed codegen or type issues
