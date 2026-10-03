---
name: nextjs-framework
description: "Explains how to configure App Router, implement server/client components, optimize data fetching, and secure routes. Use when the user mentions: 'add an authenticated route', 'migrate to App Router', 'optimize fetch caching', or 'fix RSC hydration'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Next.js Framework

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
- Auth: check the session at the top of an async Server Component and `redirect('/login')` before returning any UI. Middleware with `matcher: ['/dashboard/:path*']` covers whole subtrees.
- Dynamic segments: `[slug]`, catch-all `[...slug]`, optional catch-all `[[...slug]]`.
- Put providers in a `Providers` Client Component rather than growing `layout.tsx`; `'use client'` on everything defeats RSC.

### Caching layers

Four tiers: per-request `fetch` memoization (automatic) → Data Cache (cross-request, cached by default, opt out with `cache: 'no-store'`) → Full Route Cache (static HTML + RSC payload at build) → client Router Cache (prefetched and visited routes). Tag with `fetch(url, { next: { tags: ['posts'] } })`, then invalidate from a Server Action via `revalidateTag('posts')` or `revalidatePath('/posts')`.

Docs: https://nextjs.org/docs
