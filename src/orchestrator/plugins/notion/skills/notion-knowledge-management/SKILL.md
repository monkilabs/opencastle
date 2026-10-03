---
name: notion-knowledge-management
description: "Creates Notion pages and databases, applies templates for research docs, ADRs, and specs, and manages team knowledge bases. Use when creating Notion pages, structuring databases, documenting decisions, or capturing research findings."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Knowledge Management with Notion

MCP endpoint `https://mcp.notion.com/mcp` (OAuth). Tools: `search`, `create_page`, `update_page`, `append_block_children`, `query_database`. Docs: https://developers.notion.com/docs/mcp

## Gotchas

- **`search` only returns pages explicitly shared with the integration.** An empty result usually means missing access, not a missing page — ask the user to share the parent page rather than creating a duplicate.
- Notion's index lags writes. A page you just created can be absent from `search` for ~30s; retry before concluding the create failed.
- `create_page` needs a real `parent` (`{ "page_id": "..." }`) obtained from `search` first — always search for the parent before creating, then verify the new page by searching its exact title and confirming `parent` matches.
- Page titles are a rich-text array, not a string:
  `"properties": { "title": [{ "type": "text", "text": { "content": "[Spec] Price Range Filter" } }] }`
- Databases take `query_database` (with `filter` / `sorts`); ordinary pages take `append_block_children`. Using the wrong one fails.

```json
// query_database
{ "database_id": "db_id", "filter": { "property": "Status", "select": { "equals": "In Progress" } }, "sorts": [{ "timestamp": "last_edited_time", "direction": "descending" }] }
```

## Document conventions

Place pages under the right parent (e.g. Engineering/Specs) and close the loop by appending implementation links back to the spec. Required sections per type:

- **Research** — Summary, Sources (URL + why relevant), Key Findings, Implications, Open Questions.
- **ADR** — `ADR-NNN: <title>`, Status (Proposed | Accepted | Deprecated | Superseded), Date, Context, Decision, Consequences, Alternatives Considered (with why rejected).
- **Spec** — Objective (one sentence), Background, Acceptance Criteria (checkboxes), Implementation (branch, PR link, tracker link).
- **Meeting** — Attendees, Type, Summary, Decisions Made (with owner), Action Items (owner + due date), Discussion Notes. Mirror action items into the tracker with links.
