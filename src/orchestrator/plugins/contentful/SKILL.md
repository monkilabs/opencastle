---
name: contentful-cms
description: "Creates Contentful content types, queries entries via GraphQL/REST, runs CLI migrations, and manages assets and locales. Use when building or modifying Contentful content models, writing queries, or migrating content."
---

# Contentful CMS

Project config, content types, and API keys: [cms-config.md](../../.opencastle/stack/cms-config.md). Docs: https://www.contentful.com/developers/docs/

## Gotchas

- Never migrate `master` directly. Create a sandbox environment, migrate there, validate, then promote or re-run against `master` in a maintenance window.
- Rollback is *recreate*, not undo: delete the sandbox, re-clone from `master`, re-run a corrected migration. Reverse migrations only work for additive schema changes.
- Links are not resolved by default — REST needs `include` (link resolution depth); GraphQL resolves nested selections but each level costs query complexity.
- Use `sys.publishedAt` as the cache-invalidation key.
- Prefer typed content types over JSON fields, and attach `validations` to every required field — Contentful will not enforce shape otherwise. Uniqueness must be declared explicitly: `.validations([{ unique: true }])`.
- Reference fields need an explicit `linkContentType` validation or any entry type can be linked:
  `blogPost.createField('author').type('Link').linkType('Entry').validations([{ linkContentType: ['person'] }])`

## Migration command

```bash
contentful space migration --space-id <SPACE_ID> --environment-id sandbox migration.js
```

Migration scripts export `function (migration) { ... }` and use `createContentType` / `createField` / `displayField`.

## Post-migration validation

1. Query a representative sample of affected entries; assert required fields and unique constraints hold (exit non-zero on a miss).
2. Build the site against sandbox content to catch render-time failures.
3. Run integration tests covering the modified content types.
