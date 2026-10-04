---
name: nextjs-framework
description: "Next.js App Router conventions, server and client components, data fetching, caching and route protection, by Next version. Use when building or debugging a Next.js app, its caching, middleware/proxy or hydration errors."
---

# Next.js Framework

Check the `next` version in `package.json` first: caching and the request-interception file changed in 15 and 16.

The integration configures `next-devtools-mcp` (MCP server `next-devtools`). With the dev server running it reports build and runtime errors, logs, and route and page metadata — read those before guessing at a failure.

### Critical rule

**Never use `next/dynamic` with `{ ssr: false }` inside a Server Component** — it crashes at build/runtime. Extract it into a `'use client'` wrapper and import that from the server normally.

```tsx
// components/MapClient.tsx
'use client';
import dynamic from 'next/dynamic';
const Map = dynamic(() => import('./Map'), { ssr: false });
export function MapClient(props: MapProps) { return <Map {...props} />; }
```

### Gotchas

- `error.tsx` must be a Client Component, and needs to exist per segment — otherwise an unhandled error takes down the page. `template.tsx` re-mounts on navigation where `layout.tsx` persists. `default.tsx` is the parallel-route fallback.
- Independent fetches awaited in sequence become a waterfall — use `Promise.all()`. Fetching in `useEffect` where a Server Component could fetch costs an extra roundtrip plus a loading flash.
- `getServerSideProps` / `getStaticProps` are Pages Router only; App Router uses async Server Components.
- 15+: `params`, `searchParams`, `cookies()` and `headers()` are async — await them.
- Auth: check the session at the top of an async Server Component and `redirect('/login')` before returning any UI. Request interception with `matcher: ['/dashboard/:path*']` covers whole subtrees: `middleware.ts` up to 15, `proxy.ts` (exporting `proxy`) from 16.
- Dynamic segments: `[slug]`, catch-all `[...slug]`, optional catch-all `[[...slug]]`.
- Put providers in a `Providers` Client Component rather than growing `layout.tsx`; `'use client'` on everything defeats RSC.

### Caching, by version

- **14 and earlier:** `fetch` is cached by default (opt out with `cache: 'no-store'`), GET Route Handlers are static by default.
- **15:** nothing is cached unless you ask. `fetch`, GET Route Handlers and client navigations are uncached by default; opt in with `cache: 'force-cache'`, `export const dynamic = 'force-static'`, or `staleTimes`.
- **16:** the 15 defaults, plus Cache Components (`cacheComponents: true`): opt in with `"use cache"` on a function or component, `cacheLife()` for lifetime and `cacheTag()` for tags. `revalidateTag(tag, profile)` takes a `cacheLife` profile (e.g. `'max'`) and serves stale while it refreshes; `updateTag(tag)`, Server Actions only, expires the tag so the user reads their own write.

Tag with `fetch(url, { next: { tags: ['posts'] } })` (or `cacheTag`), invalidate from a Server Action with `revalidateTag` / `revalidatePath('/posts')`.

Docs: https://nextjs.org/docs
