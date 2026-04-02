---
name: sanity-cms
description: "Manages Sanity CMS schemas, GROQ queries, dataset exports/imports, and Studio configuration. Use when updating Sanity schemas, running GROQ or Vision queries, exporting datasets, modifying content models, or configuring a headless CMS with Sanity.io."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Sanity CMS

Generic Sanity CMS development methodology. For project-specific configuration, schemas, plugins, document types, and GROQ examples, see [sanity-config.md](../../.opencastle/stack/sanity-config.md).

## Critical Development Rules

1. **Always check the schema before querying** — use `get_schema` to understand document types and field structures before writing GROQ queries
2. **Array vs single reference** — always verify whether a field is an array of references or a single reference; using the wrong query operator causes silent failures
3. **Local schema files are source of truth** — never edit deployed schemas directly; always change local files and redeploy
4. **Follow `defineType` and `defineField` patterns** — always use Sanity helpers for type safety and consistency
5. **Test GROQ queries in Vision** — validate queries against real data in the Vision plugin before deploying
6. **Handle draft/publish workflow** — always account for the `drafts.` prefix when querying or mutating documents
7. **Keep queries in the shared library** — queries belong in a shared queries library, never inline in components

## Quick GROQ examples

Fetch published articles with authors populated:

```groq
*[_type == "article" && defined(publishedAt)] | order(publishedAt desc) {
	_id,
	title,
	"author": author-> { name, _id },
	body
}
```

Filter by tag and return first 10:

```groq
*[_type == "article" && "tech" in tags[]] | order(_createdAt desc)[0..9] { title, slug }
```

## Example schema (executable)

```js
// schemas/article.js
import { defineType, defineField } from 'sanity'

export default defineType({
	name: 'article',
	title: 'Article',
	type: 'document',
	fields: [
		defineField({ name: 'title', type: 'string', title: 'Title' }),
		defineField({ name: 'slug', type: 'slug', options: { source: 'title' } }),
		defineField({ name: 'author', type: 'reference', to: [{ type: 'author' }] }),
		defineField({ name: 'body', type: 'array', of: [{ type: 'block' }] }),
	],
})
```

## Workflow: change schema → validate → deploy

1. Update local schema files and run `sanity start` to surface schema errors locally.
2. Run Vision queries to validate GROQ results against local data: execute representative queries (see examples above).
3. Create a migration or dataset export if needed and test changes in a staging project/dataset.
	 - Validation checkpoint: run `sanity dataset export` and `sanity dataset import` into a temporary dataset and run queries.
4. Deploy the schema to Studio and run end-to-end site builds to confirm runtime behavior.
5. If validation fails at any step, revert schema changes locally, fix, and repeat from step 1.
