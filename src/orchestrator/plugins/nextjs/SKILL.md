---
name: nextjs-framework
description: "Next.js framework best practices covering App Router, server/client components, data fetching, caching, rendering strategies, middleware, configuration, and deployment. Use when creating or modifying Next.js pages, layouts, route handlers, Server Actions, or project configuration."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Next.js Framework

## Project Structure

```
├── app/                     # App Router (file-based routing)
│   ├── layout.tsx           # Root layout (required)
│   ├── page.tsx             # Home route → /
│   ├── loading.tsx          # Loading UI (Suspense boundary)
│   ├── error.tsx            # Error boundary (Client Component)
│   ├── not-found.tsx        # 404 page
│   ├── (marketing)/         # Route group (no URL segment)
│   │   └── about/page.tsx   # → /about
│   ├── dashboard/
│   │   ├── layout.tsx       # Nested layout
│   │   └── [id]/page.tsx    # → /dashboard/:id
│   └── api/
│       └── users/route.ts   # API route handler
├── components/              # Shared React components
├── lib/                     # Utilities, helpers, server logic
├── public/                  # Static assets
├── next.config.ts           # Next.js configuration
├── middleware.ts            # Edge middleware
└── .env.local               # Environment variables (not committed)
```

Route Groups `(name)` organize routes without affecting the URL. Private Folders `_internal` opt out of routing. Parallel Routes `@modal` render multiple pages in the same layout.

## Rendering Strategies

| Strategy | When | How |
|----------|------|-----|
| **Static (SSG)** | Build time | Default for pages with no dynamic data |
| **ISR** | Build + revalidation | `fetch` with `next: { revalidate: N }` or route segment config |
| **SSR** | Every request | `export const dynamic = 'force-dynamic'` or dynamic functions |
| **CSR** | Browser | `'use client'` components with `useEffect`/SWR |
| **Streaming** | Progressive | `<Suspense>` boundaries + `loading.tsx` |
| **PPR** | Build + streaming | Static shell with dynamic holes via `<Suspense>` |

Route segment config: `export const dynamic = 'force-dynamic'`, `export const revalidate = 60`, `export const runtime = 'edge'`.

## Server and Client Components

**Default: Server Components** — data fetching, heavy logic, non-interactive UI.  
**Client Components** — add `'use client'` at top. Use for interactivity, state, browser APIs.

| Need | Component Type |
|------|---------------|
| Fetch data / read cookies/headers | Server |
| Interactive UI (clicks, inputs) | Client |
| `useState` / `useEffect` / browser APIs | Client |
| Static/non-interactive content | Server |
| Async children with loading state | Server + `<Suspense>` |

### Critical Rule

**Never use `next/dynamic` with `{ ssr: false }` inside a Server Component.** Extract to a dedicated `'use client'` component and import it normally.

## Data Fetching

### Server-Side

```tsx
export default async function ProjectsPage() {
  const data = await fetch('/api/projects', { next: { revalidate: 60 } }).then((r) => r.json());
  return <ul>{data.map((p: { id: string; name: string }) => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

### Server Actions

```tsx
'use server';
import { revalidatePath } from 'next/cache';
export async function createItem(formData: FormData) {
  await db.items.create({ data: { name: formData.get('name') as string } });
  revalidatePath('/items');
}
```

Use from a Client Component: `<form action={createItem}>...</form>`

### Parallel Fetching

```tsx
const [metrics, activity] = await Promise.all([getMetrics(), getRecentActivity()]);
```

## Caching

| Mechanism | Scope | How to Use |
|-----------|-------|------------|
| **Request Memoization** | Per-request | Automatic deduplication of identical `fetch` calls |
| **Data Cache** | Cross-request | Cached by default; opt out with `cache: 'no-store'` |
| **Full Route Cache** | Build time | Static routes cached as HTML + RSC payload |
| **Router Cache** | Client-side | Prefetched and visited routes cached in browser |

On-demand revalidation: `revalidatePath('/blog')` or `revalidateTag('posts')`. Tag a fetch: `fetch(url, { next: { tags: ['posts'] } })`.

## Routing

### File Conventions

| File | Purpose |
|------|---------|
| `page.tsx` | Route UI |
| `layout.tsx` | Shared layout (persists across navigation) |
| `template.tsx` | Like layout but re-mounts on navigation |
| `loading.tsx` | Loading UI (automatic Suspense boundary) |
| `error.tsx` | Error UI (Client Component) |
| `not-found.tsx` | 404 UI |
| `route.ts` | API endpoint |
| `default.tsx` | Fallback for parallel routes |

### Dynamic Routes

- `app/blog/[slug]/page.tsx` → `/blog/:slug`
- `app/shop/[...slug]/page.tsx` → `/shop/:slug+` (catch-all)
- `app/shop/[[...slug]]/page.tsx` → `/shop` or `/shop/:slug+` (optional)

## Middleware

Runs at the Edge before every matched request. Use for auth, redirects, rewrites.

```ts
import { NextResponse, type NextRequest } from 'next/server';
export function middleware(req: NextRequest) {
  if (!req.cookies.get('session') && req.nextUrl.pathname.startsWith('/dashboard'))
    return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}
export const config = { matcher: ['/dashboard/:path*'] };
```

## Environment Variables

| Prefix | Available in | Use Case |
|--------|-------------|----------|
| `NEXT_PUBLIC_` | Server + Client | Public values (API base URLs, feature flags) |
| No prefix | Server only | Secrets (DB URLs, API keys, tokens) |

Files (priority order): `.env.local`, `.env.development` / `.env.production`, `.env`.

## Image, Font, and Metadata

- **Images**: Use `<Image>` from `next/image` — auto lazy loading, responsive sizing, format conversion. Configure `images.remotePatterns` in `next.config.ts` for remote URLs.
- **Fonts**: Use `next/font/google` — zero layout shift, self-hosted, no external network request.
- **Metadata**: Export `metadata` (static) or `generateMetadata` (dynamic) per page/layout for SEO and social previews.

## Anti-Patterns

| Anti-Pattern | Why It's Wrong | Do This Instead |
|-------------|---------------|-----------------|
| `'use client'` on every component | Bloats JS bundle, defeats RSC benefits | Default to Server Components |
| Sequential `await` for independent data | Waterfall, slows page load | Use `Promise.all()` |
| `next/dynamic` with `ssr: false` in Server Components | Build/runtime crash | Extract to Client Component |
| Fetching in `useEffect` when server fetch works | Extra roundtrip, loading flash | Fetch in Server Component or Server Actions |
| Giant `layout.tsx` with all providers | Hard to test, couples concerns | Split into a `Providers` Client Component |
| No `error.tsx` per segment | Unhandled errors crash the page | Add `error.tsx` per route segment |
| Hardcoding secrets in source | Security risk, version control leak | Use `.env.local` and `process.env` |
| Skipping `loading.tsx` / `<Suspense>` | Blank screen while data loads | Add `loading.tsx` or wrap in `<Suspense>` |
| `getServerSideProps` / `getStaticProps` | Legacy Pages Router | Use App Router with async Server Components |
| Missing `metadata` exports | Poor SEO, no social previews | Export `metadata` or `generateMetadata` per page |
