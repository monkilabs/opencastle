---
name: astro-framework
description: "Creates pages/layouts, defines content collections, configures hydration directives, and wires integrations. Use when adding or modifying Astro pages, layouts, components, or content collections. Trigger terms: Astro, content collection, client:load, client:visible, astro:content"
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

## Implement Components

**Default: Zero JS** — author `.astro` components that render HTML with no client-side JavaScript where possible.

**Islands Architecture** — hydrate interactivity only where needed using `client:*` directives.

### Component Example (concise)

```astro
---
interface Props { title: string; description?: string; }
const { title, description = 'Default description' } = Astro.props;
---
<section>
  <h2>{title}</h2>
  <p>{description}</p>
</section>
<style>
  section { max-width: 800px; margin: 0 auto; }
</style>
```

### Client Directives (Islands)

Use only the hydration directive required by the interaction to minimize shipped JS. Typical mappings:

- `client:load` — immediate hydration for critical interactive widgets
- `client:idle` — non-critical behavior after page idle
- `client:visible` — hydrate when visible (lazy)
- `client:media` — hydrate on media match
- `client:only` — last resort for non-SSR-able components

## Content Collections — Quick Workflow: add a new collection
1. Add collection schema in `src/content.config.ts` using `defineCollection` and Zod validators.
2. Create the folder under `src/content/<collection>` and add one sample `.md` or `.mdx` content file with frontmatter.
3. Run `pnpm build` and `pnpm dev` → run `node scripts/validate-content.js` (or your project's validation script) to verify typed collection imports.
4. Add a smoke query in a page that imports the collection (e.g., `const posts = await getCollection('blog')`) and confirm build-time typing.
5. Validation: ensure `pnpm build` exits zero and TypeScript reports no errors for collection types.

Define collections in `src/content.config.ts` (Astro v5+) using `astro:content` and export typed collections.
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

## Anti-Patterns (moved to REFERENCE.md)

Extracted anti-patterns and SSR configuration details are available in `REFERENCE.md` in this directory to keep this skill focused and concise.
