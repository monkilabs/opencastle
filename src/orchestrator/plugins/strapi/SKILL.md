---
name: strapi-cms
description: "Builds Strapi content types, extends controllers and services, implements lifecycle hooks, and configures REST/GraphQL APIs. Use when creating content types, writing custom controllers, developing Strapi plugins, or querying the API."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Strapi CMS

Generic Strapi CMS development methodology. For project-specific configuration, content types, and deployment details, see [cms-config.md](../../.opencastle/stack/cms-config.md).

## Critical Development Rules

1. **Use Content-Type Builder** — define content types through the admin panel or `content-types` directory
2. **REST API by default** — Strapi exposes REST endpoints automatically; enable GraphQL plugin if needed
3. **Extend controllers** — implement `src/api/<type>/controllers/<type>.js` with wrapper logic that calls services
4. **Implement services** — place business logic in `src/api/<type>/services/` and keep controllers thin
5. **Use lifecycle hooks** — add `beforeCreate`/`afterUpdate` handlers in `src/api/<type>/lifecycles.js` for side effects
6. **Configure permissions per role** — set public/authenticated access in Users & Permissions; keep environment configs under `config/env/<env>/`

## API Patterns

### REST API (Strapi-specific)
- Use `populate` to include relations
- Use `filters` with operators (`$eq`, `$contains`, `$in`, etc.)
- Pagination via `pagination[page]` and `pagination[pageSize]`
- Use `fields` to select attributes

### Quick REST examples

GET with populate and filters (client-side fetch):

```js
// GET /api/articles?populate=author,categories&filters[status][$eq]=published&pagination[page]=1&pagination[pageSize]=10
const res = await fetch('https://cms.example.com/api/articles?populate=author,categories&filters[status][$eq]=published');
const json = await res.json();
console.log(json.data[0].attributes.title);
```

Custom controller extension (server):

```js
// src/api/article/controllers/article.js
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::article.article', ({ strapi }) => ({
	async find(ctx) {
		// call default then modify response
		const res = await super.find(ctx);
		// add extra field
		res.meta.custom = { processedAt: new Date().toISOString() };
		return res;
	},
}));
```

Lifecycle hook example:

```js
// src/api/article/content-types/article/lifecycles.js
module.exports = {
	async beforeCreate(event) {
		const { data } = event.params;
		if (data.title) data.slug = slugify(data.title);
	},
};
```


## Quick workflow: create content type + custom controller + service

1. Create content type using Content-Type Builder or `src/api/<type>/content-types/schema.json` → commit schema.
2. Scaffold controller and service files under `src/api/<type>/controllers/` and `src/api/<type>/services/` with thin controller calling service functions.
3. Add lifecycle hooks (optional) in `content-types/<type>/lifecycles.js` for side effects.
4. Run local Strapi (`yarn develop`) → check admin UI for new content type.
	- Validation: create a test entry in admin UI and confirm via `GET /api/<type>?pagination[page]=1` that fields exist.
	- If fail: check server logs, run `yarn build` to surface schema errors, verify `schema.json` validity.
5. Add permissions (Users & Permissions) for public/authenticated roles if API access required.
6. Add automated API test: `fetch('/api/<type>?populate=*')` in test suite to validate relations populate.

For more reference patterns and larger examples, see [REFERENCE.md](REFERENCE.md).
