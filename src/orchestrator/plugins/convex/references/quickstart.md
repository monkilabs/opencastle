# Convex Quickstart

Set up a working Convex project as fast as possible.

## Scaffolding Templates

Use `npm create convex@latest` for new projects. Pass project name and template to avoid interactive prompts:

```bash
npm create convex@latest my-app -- -t react-vite-shadcn
cd my-app
npm install
```

| Template | Stack |
|----------|-------|
| `react-vite-shadcn` | React + Vite + Tailwind + shadcn/ui |
| `nextjs-shadcn` | Next.js App Router + Tailwind + shadcn/ui |
| `react-vite-clerk-shadcn` | React + Vite + Clerk auth + shadcn/ui |
| `nextjs-clerk` | Next.js + Clerk auth |
| `nextjs-convexauth-shadcn` | Next.js + Convex Auth + shadcn/ui |
| `bare` | Convex backend only, no frontend |

Default: `react-vite-shadcn` for simple apps, `nextjs-shadcn` for apps needing SSR or API routes.

You can use any GitHub repo as a template:

```bash
npm create convex@latest my-app -- -t owner/repo
npm create convex@latest my-app -- -t owner/repo#branch
```

## Adding Convex to an Existing App

```bash
npm install convex
```

Then ask the user to run `npx convex dev` in their terminal.

## ConvexProvider Wiring

Create the `ConvexReactClient` at module scope, not inside a component:

```tsx
// Bad: re-creates the client on every render
function App() {
  const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
  return <ConvexProvider client={convex}>...</ConvexProvider>;
}

// Good: created once at module scope
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
function App() {
  return <ConvexProvider client={convex}>...</ConvexProvider>;
}
```

#### React (Vite)

```tsx
// src/main.tsx
import { ConvexProvider, ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
```

#### Next.js (App Router)

```tsx
// app/ConvexClientProvider.tsx
"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
```

## Environment Variables

| Framework | Variable |
|-----------|----------|
| Vite | `VITE_CONVEX_URL` |
| Next.js | `NEXT_PUBLIC_CONVEX_URL` |
| Remix | `CONVEX_URL` |
| React Native | `EXPO_PUBLIC_CONVEX_URL` |

`npx convex dev` writes the correct variable to `.env.local` automatically.

## Agent Mode (Cloud/Headless)

Set `CONVEX_AGENT_MODE=anonymous` in `.env.local` to run a local anonymous backend without interactive browser login:

```bash
CONVEX_AGENT_MODE=anonymous npx convex dev
```

## The Dev Loop

`npx convex dev` is a long-running watcher — it's interactive on first run (browser-based OAuth). **Ask the user to run this themselves.** Once running it:
- Creates a Convex project and dev deployment
- Writes the deployment URL to `.env.local`
- Creates `convex/_generated/` with types
- Watches for changes and syncs continuously

Deploy to production separately:

```bash
npx convex deploy
```

## First Function: Verification Round-Trip

`convex/schema.ts`:

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tasks: defineTable({
    text: v.string(),
    completed: v.boolean(),
  }),
});
```

`convex/tasks.ts`:

```ts
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});

export const create = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("tasks", { text: args.text, completed: false });
    return null;
  },
});
```

## Other Frameworks

- [Vue](https://docs.convex.dev/quickstart/vue)
- [Svelte](https://docs.convex.dev/quickstart/svelte)
- [React Native](https://docs.convex.dev/quickstart/react-native)
- [TanStack Start](https://docs.convex.dev/quickstart/tanstack-start)
- [Remix](https://docs.convex.dev/quickstart/remix)
- [Node.js](https://docs.convex.dev/quickstart/nodejs)

## Next Steps

- Add authentication → `references/auth-setup.md`
- Schema migrations → `references/migrations.md`
- Performance optimization → `references/performance-audit.md`
- Component creation → `references/components.md`
