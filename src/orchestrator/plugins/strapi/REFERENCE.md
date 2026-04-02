> Parent: [SKILL.md](./SKILL.md)

## Strapi Reference: GraphQL & Plugin Development

### GraphQL Plugin

- Enable via `@strapi/plugin-graphql`.
- Auto-generates types and resolvers from content types; use `filters`, `pagination`, and `sort` arguments.
- Custom resolvers live under `src/api/<type>/graphql/` — keep GraphQL-specific transformations isolated.

### Plugin Development

- Scaffold with `strapi generate plugin <name>`.
- Plugin structure: `admin/`, `server/`, `content-types/` — register in `config/plugins.ts`.
- Use the Plugin SDK for admin panel extensions and keep server logic under `server/` to avoid bundling admin code.
# Strapi Reference (REFERENCE.md)

Last Updated: 2026-03-31

## Populate & filters quick reference

- Populate relations: `?populate=author,categories` or deep `?populate=deep` for all relations.
- Filters example: `?filters[status][$eq]=published&filters[views][$gte]=100`
- Fields selection: `?fields[0]=title&fields[1]=slug`

## Common API patterns

- Paginated list with relations: `/api/articles?populate=author,categories&pagination[page]=1&pagination[pageSize]=10`
- Single entry by slug: `/api/articles?filters[slug][$eq]=my-post&populate=author`

## Recommended tests

1. Endpoint smoke test: GET `/api/<type>?pagination[page]=1` returns 200 and `data` array.
2. Relation test: GET with `populate` returns `relationships` with expected keys.
3. Permission test: verify `public` role returns 200/403 as configured.