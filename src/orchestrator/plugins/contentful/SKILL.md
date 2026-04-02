---
name: contentful-cms
description: "Creates Contentful content types, queries entries via GraphQL/REST, runs CLI migrations, and manages assets and locales. Use when building or modifying Contentful content models, writing queries, or migrating content."
---

# Contentful CMS

For project-specific configuration, content types, and API keys, see [cms-config.md](../../.opencastle/stack/cms-config.md).

## Query Patterns

### GraphQL Content API
- Leverage `sys.publishedAt` for cache invalidation
- Use `include` parameter to control link resolution depth

```typescript
// Example: Typed GraphQL query
const BLOG_POSTS_QUERY = `
  query BlogPosts($limit: Int!, $locale: String!) {
    blogPostCollection(limit: $limit, locale: $locale) {
      items {
        sys { id publishedAt }
        title
        slug
        body { json }
        featuredImage { url width height }
      }
    }
  }
`;
```

## Content Modeling

```javascript
// Reference field with validation
blogPost.createField('author')
  .type('Link').linkType('Entry')
  .validations([{ linkContentType: ['person'] }]);
```

Prefer typed content types over JSON fields; add validation rules to all required fields.

## Migration Workflow

1. Create a sandbox environment using the Contentful web UI or API.
2. Write a migration script using the Contentful migration library (example below).
3. Run the migration against the sandbox:

```bash
contentful space migration --space-id <SPACE_ID> --environment-id sandbox migration.js
```

4. Validate changes:
  - Run a small validation script that queries a sample of affected entries and ensures required fields exist.
   - If validation fails: roll back by deleting the sandbox and recreate from `master` (safe rollback), or write a reverse migration and run it.
5. When sandbox validation passes, promote the environment or run the migration against `master` during a maintenance window.

```javascript
// Example: Migration script (migration.js)
module.exports = function (migration) {
  const blogPost = migration.createContentType('blogPost')
    .name('Blog Post')
    .displayField('title');
  blogPost.createField('title').type('Symbol').required(true);
  blogPost.createField('slug').type('Symbol').required(true).validations([{ unique: true }]);
  blogPost.createField('body').type('RichText');
};
```

Validation script example (node):

```js
// validate.js — exits non-zero on missing fields
const res = await fetch(`https://cdn.contentful.com/spaces/${SPACE}/environments/sandbox/entries?content_type=blogPost`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const { items } = await res.json();
for (const item of items) {
  if (!item.fields.slug) throw new Error(`Missing slug on ${item.sys.id}`);
}
console.log('OK —', items.length, 'entries validated');
```

For longer migration patterns and rollback options see [REFERENCE.md](REFERENCE.md).
