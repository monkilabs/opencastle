> Parent: [SKILL.md](./SKILL.md)

Next.js REFERENCE: deep-dive topics for revalidation, middleware, and advanced caching.

Place detailed config snippets and long tables here; the `SKILL.md` keeps only the quick workflow and validation commands.
Last Updated: 2026-03-31

Reference: deeper Next.js topics

- Routing edge cases: middleware vs route-level server checks
- Revalidation patterns: `revalidatePath`, `tags`, on-demand revalidation examples
- App Router auth patterns and middleware examples
- Performance tuning: RSC payload sizing and bundle splitting

See `next.config.ts`, `app/` examples in the repo for applied patterns.

## Caching Details

| Mechanism | Scope | How to Use |
|-----------|-------|------------|
| **Request Memoization** | Per-request | Automatic deduplication of identical `fetch` calls |
| **Data Cache** | Cross-request | Cached by default; opt out with `cache: 'no-store'` |
| **Full Route Cache** | Build time | Static routes cached as HTML + RSC payload |
| **Router Cache** | Client-side | Prefetched and visited routes cached in browser |

On-demand revalidation: `revalidatePath('/blog')` or `revalidateTag('posts')`. Tag a fetch: `fetch(url, { next: { tags: ['posts'] } })`.

## Routing — File Conventions & Dynamic Routes

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

Dynamic route patterns:
- `app/blog/[slug]/page.tsx` → `/blog/:slug`
- `app/shop/[...slug]/page.tsx` → `/shop/:slug+` (catch-all)
- `app/shop/[[...slug]]/page.tsx` → `/shop` or `/shop/:slug+` (optional)

### Middleware examples

```ts
import { NextResponse, type NextRequest } from 'next/server';
export function middleware(req: NextRequest) {
	if (!req.cookies.get('session') && req.nextUrl.pathname.startsWith('/dashboard'))
		return NextResponse.redirect(new URL('/login', req.url));
	return NextResponse.next();
}
export const config = { matcher: ['/dashboard/:path*'] };
```

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

Last Updated: 2026-03-31
