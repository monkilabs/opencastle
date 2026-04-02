---
name: notion-knowledge-management
description: "Creates Notion pages and databases, applies templates for research docs, ADRs, and specs, and manages team knowledge bases. Use when creating Notion pages, structuring databases, documenting decisions, or capturing research findings."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Knowledge Management with Notion

MCP endpoint: `https://mcp.notion.com/mcp` (OAuth). Tools: `search`, `create_page`, `update_page`, `append_block_children`, `query_database`.

## Working with Pages and Databases

### Page Hierarchy

Use `search` first to check if a page already exists. Place new pages under the appropriate parent (e.g., Engineering/Specs).

### Create & verify page (end-to-end)

1. `search` for parent page (by title) to obtain `page_id`.

```json
// tool: notion/search
{ "query": "Engineering/Specs", "page_size": 5 }
// response.example: { results: [{ id: "abc123", title: "Engineering/Specs" }] }
```

2. `create_page` using the found `page_id` as `parent`.

```json
// tool: notion/create_page
{
  "parent": { "page_id": "abc123" },
  "properties": { "title": [{ "type": "text", "text": { "content": "[Spec] Price Range Filter" } }] }
}
```

3. Verify creation by searching for the exact title and confirming `parent` matches.

```json
// tool: notion/search
{ "query": "[Spec] Price Range Filter" }
```

Recovery: if search returns empty, retry after 30s (indexing delay) or confirm integration access.

## Capturing Research and Decisions

Use the templates in [TEMPLATES.md](TEMPLATES.md) for Research Notes, ADRs, Specs, and Meeting notes. Create pages using the end-to-end pattern above and append implementation links to close the loop between spec and code.

Meeting notes: use [TEMPLATES.md](TEMPLATES.md) and append action items to the tracker (Linear/GitHub) with links.

## Permission-Aware Workflows

`search` the target parent first to confirm integration visibility. If missing, request user share the parent page. Use `query_database` for databases; `append_block_children` for regular pages.

## Database Query Patterns

```json
// tool: notion/query_database
{ "database_id": "db_id", "filter": { "property": "Status", "select": { "equals": "In Progress" } }, "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }] }
```

