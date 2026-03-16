---
name: astro-framework
description: "Astro framework best practices for content-driven sites, islands architecture, routing, integrations, and project structure. Use when creating or modifying Astro pages, layouts, components, or content collections."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Astro Framework

## Project Structure

Top-level: `src/`, `public/`, `astro.config.mjs`. Inside `src/`: `pages/`, `layouts/`, `components/`, `content/`, `styles/`, `assets/`. `public/` serves static assets as-is; `src/assets/` goes through Astro's build pipeline.

```
src/
├── pages/       # file-based routing (.astro, .md, .mdx)
├── layouts/     # BaseLayout.astro, etc.
├── components/  # .astro + framework components (React islands)
├── content/     # Content collections (blog/, docs/, etc.)
├── styles/      # global.css
└── assets/      # processed images
```

## Component Model

**Default: Zero JS** — `.astro` components render to HTML with no client-side JavaScript.

**Islands Architecture** — Interactive components use `client:*` directives to hydrate only where needed.

### Astro Component Example

```astro
---
interface Props { title: string; description?: string; }
const { title, description = 'Default description' } = Astro.props;
const data = await fetch('https://api.example.com/data').then(r => r.json());
---
<section>
  <h2>{title}</h2>
  {data.items.map((item: { name: string }) => <li>{item.name}</li>)}
</section>
<style>
  section { max-width: 800px; margin: 0 auto; }
</style>
```

### Client Directives (Islands)

| Directive | When It Hydrates | Use Case |
|-----------|-----------------|----------|
| `client:load` | Immediately on page load | Critical interactive UI |
| `client:idle` | After page is idle | Non-critical UI (analytics widgets) |
| `client:visible` | When element enters viewport | Below-the-fold components |
| `client:media="(max-width: 768px)"` | When media query matches | Mobile-only interactivity |
| `client:only="react"` | Client-only, no SSR | Components that can't server-render |

## Content Collections

Define in `src/content.config.ts` (Astro v5+) using the Content Layer API:

```ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    draft: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
  }),
});
export const collections = { blog };
```

Query collections:

```astro
---
import { getCollection } from 'astro:content';
const posts = (await getCollection('blog', ({ data }) => !data.draft))
  .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
---
```

## Routing

Every `.astro` or `.md` file in `src/pages/` becomes a route. For dynamic routes:

```astro
---
// src/pages/blog/[slug].astro
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
  const posts = await getCollection('blog');
  return posts.map(post => ({ params: { slug: post.id }, props: { post } }));
}
const { post } = Astro.props;
const { Content } = await post.render();
---
<Content />
```

**SSR**: Set `output: 'server'` (or `'hybrid'`) and add an adapter (`node`, `vercel`, `netlify`, `cloudflare`) in `astro.config.mjs`.

## Layouts

Define in `src/layouts/BaseLayout.astro` — a full HTML shell with `<slot />` for page content. Pass `title` and `description` as props.

## Integrations

Use `astro add` for react, tailwind, mdx, sitemap, node, vercel, netlify, cloudflare.

## API Routes & Actions

- **API routes**: Export `GET`/`POST` handlers from `src/pages/api/*.ts` returning `new Response(...)`.
- **Actions**: Use `defineAction` in `src/actions/index.ts` for type-safe server mutations with Zod validation.

## Anti-Patterns

| Anti-Pattern | Why It's Wrong | Do This Instead |
|-------------|---------------|-----------------|
| `client:load` on every component | Defeats zero-JS benefit, bloats bundle | Use `client:idle` or `client:visible` for non-critical UI |
| Importing large JS libraries in `.astro` | Runs at build but bundles nothing useful | Import in framework components with `client:*` |
| Skipping content collections for blog/docs | Manual file handling is error-prone | Use content collections with typed schemas |
| Hardcoding data in pages | Not maintainable, no type safety | Use content collections or fetch from APIs |
| Using `client:only` when SSR works | Loses SEO benefits and fast first paint | Use `client:load` or `client:visible` instead |
| Giant monolithic pages | Hard to maintain and test | Split into layouts + reusable components |
| Ignoring `astro add` for integrations | Manual config is error-prone | Use `astro add` for official integrations |
| Missing `alt` on images | Accessibility violation | Always provide descriptive `alt` text |
| Not using `astro:assets` for images | Missing optimization | Use `<Image>` from `astro:assets` |
