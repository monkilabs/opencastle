---
name: strapi-cms
description: "Builds Strapi content types, extends controllers and services, implements lifecycle hooks, and configures REST/GraphQL APIs. Use when creating content types, writing custom controllers, developing Strapi plugins, or querying the API."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Strapi CMS

Project config, content types, and deployment details: [cms-config.md](../../.opencastle/stack/cms-config.md). Docs: https://docs.strapi.io/

## File placement is load-bearing

Strapi discovers code by path — a correct file in the wrong place is simply ignored.

- `src/api/<type>/content-types/<type>/schema.json` — content type (or use Content-Type Builder, then commit the generated schema)
- `src/api/<type>/controllers/<type>.js` — thin wrapper, wraps `createCoreController('api::<type>.<type>', ({ strapi }) => ({ ... }))`; call `super.find(ctx)` then modify the response
- `src/api/<type>/services/` — all business logic
- `src/api/<type>/content-types/<type>/lifecycles.js` — `beforeCreate`/`afterUpdate` side effects, mutating `event.params.data`
- `src/api/<type>/graphql/` — custom resolvers
- `config/env/<env>/` — per-environment config; `config/plugins.ts` registers plugins

## Query gotchas

- **Relations are not returned unless requested.** `?populate=author,categories`, or `?populate=deep` for everything.
- Filters need an operator: `?filters[status][$eq]=published&filters[views][$gte]=100`. Operators include `$eq`, `$contains`, `$in`, `$gte`.
- Field selection is indexed: `?fields[0]=title&fields[1]=slug`.
- Pagination: `?pagination[page]=1&pagination[pageSize]=10`.
- **New endpoints return 403 until permissions are granted** per role in Users & Permissions — this is the most common "my API is broken" cause.
- GraphQL is opt-in via `@strapi/plugin-graphql`; it auto-generates types and resolvers from content types with `filters`/`pagination`/`sort` args.
- Plugins: `strapi generate plugin <name>` → `admin/`, `server/`, `content-types/`. Keep server logic in `server/` so admin code is not bundled into the server build.

## Verify

the `develop` script, confirm the type appears in admin, create a test entry, then assert `GET /api/<type>?pagination[page]=1` returns 200 with a `data` array and `GET /api/<type>?populate=*` returns the expected relations. Schema errors surface under the `build` script.
