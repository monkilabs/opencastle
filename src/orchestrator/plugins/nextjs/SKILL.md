---
name: nextjs-framework
description: "Explains how to configure App Router, implement server/client components, optimize data fetching, and secure routes. Use when the user mentions: 'add an authenticated route', 'migrate to App Router', 'optimize fetch caching', or 'fix RSC hydration'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Next.js Framework

### Critical Rule

**Never use `next/dynamic` with `{ ssr: false }` inside a Server Component.** Extract the dynamic piece to a dedicated `'use client'` component and import it from server components normally.

```tsx
// ✅ Correct: wrap dynamic import in a 'use client' component
// components/MapClient.tsx
'use client';
import dynamic from 'next/dynamic';
const Map = dynamic(() => import('./Map'), { ssr: false });
export function MapClient(props: MapProps) { return <Map {...props} />; }

// Then import from a Server Component as normal:
// app/page.tsx
import { MapClient } from '@/components/MapClient';
export default function Page() { return <MapClient center={[0, 0]} />; }
```

### Authenticated Routes

```tsx
// app/dashboard/page.tsx
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  // ... render dashboard
}
```

For middleware-based protection see `REFERENCE.md § Middleware examples`.

### Server Actions

```ts
// app/actions.ts
'use server';
import { revalidatePath } from 'next/cache';
export async function updatePost(id: string, data: FormData) {
  await db.posts.update(id, Object.fromEntries(data));
  revalidatePath('/posts');
}
```

### Data Fetching & Caching

```ts
// Server Component — cached by default; opt out with cache: 'no-store'
async function getPosts() {
  const res = await fetch('/api/posts', { next: { tags: ['posts'] } });
  return res.json() as Promise<Post[]>;
}
// On-demand revalidation: revalidateTag('posts') or revalidatePath('/posts')
```

Caching tiers (request memo → data cache → full route cache → router cache) and revalidation patterns are in `REFERENCE.md § Caching Details`.

### Adding an Authenticated Route — Checklist

1. Create `app/<route>/page.tsx` as an async Server Component.
  - Validate: file exists and exports a default async component.
2. Call `getSession()` at the top and `redirect('/login')` when missing.
  - Validate: confirm there is no render path when session is falsy (no UI returned before redirect).
3. Add `app/<route>/error.tsx` for error boundaries.
  - Validate: `tsc --noEmit` recognizes the file and there are no missing imports.
4. Run `tsc --noEmit` and fix type errors.
  - Validate: `tsc --noEmit` exits with code 0.
5. Test: access the route without an auth cookie and confirm redirect to `/login`.
  - Validate: an unauthenticated HTTP request receives a 302/307 redirect to `/login`.

Project-specific conventions and deeper tables (routing, caching, component guidance) live in [REFERENCE.md](./REFERENCE.md).
