---
name: sanity-cms
description: "Sanity schemas, GROQ queries, Studio configuration and dataset imports and exports. Use when changing a Sanity content model, writing GROQ, or moving Sanity datasets."
---

# Sanity CMS

Project config, schemas, plugins, document types, and GROQ examples: `.opencastle/stack/sanity-config.md`. Docs: https://www.sanity.io/docs

## Rules that prevent silent failures

1. **Call `get_schema` before writing any GROQ.** Field names and shapes are not guessable from the frontend code.
2. **Check array vs single reference.** `author->` on an array field (or `author[]->` on a single one) returns null with **no error** — the query just yields empty data.
3. **Account for the `drafts.` prefix.** Unpublished documents live at `drafts.<id>`; queries and mutations that ignore it silently miss or clobber content.
4. **Local schema files are the source of truth** — never edit a deployed schema in Studio; change local files and redeploy.
5. **Use `defineType` / `defineField`** for every schema — plain object literals lose type safety.
6. **Validate GROQ in Vision against real data** before shipping it.
7. **Queries live in the shared queries library**, never inline in components.

## Change → validate → deploy

1. Edit local schema files; `sanity start` surfaces schema errors immediately.
2. Run representative queries in Vision against local data.
3. For risky changes, `sanity dataset export` then `sanity dataset import` into a temporary dataset and re-run queries there.
4. Deploy the schema, then run a full site build to catch runtime breakage.
5. Any failure: revert locally, fix, restart from step 1.
