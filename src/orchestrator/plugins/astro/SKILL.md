---
name: astro-framework
description: "Creates pages/layouts, defines content collections, configures hydration directives, and wires integrations. Use when adding or modifying Astro pages, layouts, components, or content collections. Trigger terms: Astro, content collection, client:load, client:visible, astro:content"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Astro Framework

Docs: https://docs.astro.build

## Gotchas

- `public/` serves assets as-is; `src/assets/` goes through the build pipeline. Wrong folder = no optimization, or a broken import.
- Astro v5+ defines collections in `src/content.config.ts` (not `src/content/config.ts`) and requires an explicit `loader`, e.g. `glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' })`.
- Default is zero client JS. Ship JS only via a `client:*` directive, and pick the cheapest one that still works: `client:load` (critical), `client:idle` (deferred), `client:visible` (lazy), `client:media` (breakpoint-gated), `client:only` (last resort — skips SSR entirely, so no server-rendered HTML).
- `getStaticPaths()` is required for dynamic routes in static output; it does not run in `output: 'server'`.
- SSR needs both `output: 'server'` (or `'hybrid'`) *and* an adapter (`node`, `vercel`, `netlify`, `cloudflare`) in `astro.config.mjs`.
- Collection schemas are Zod — use `z.coerce.date()` for frontmatter dates, since raw frontmatter is a string.

## Layout

`src/pages/` (file-based routes), `layouts/`, `components/`, `content/`, `styles/`, `assets/`. API routes: export `GET`/`POST` from `src/pages/api/*.ts` returning `new Response(...)`. Type-safe mutations: `defineAction` in `src/actions/index.ts`.

## Add a collection

1. Declare it in `src/content.config.ts` via `defineCollection` + Zod schema; export from `collections`.
2. Add `src/content/<name>/` with one sample file.
3. Query with `getCollection('<name>', filterFn)`.
4. `pnpm build` must exit zero — collection types are generated at build time, so type errors only surface after a build.

Integrations: `astro add react tailwind mdx sitemap` etc. — never hand-edit the integrations array.
