---
name: notion-knowledge-management
description: "Notion pages, databases and team knowledge bases through the hosted Notion MCP, with templates for research docs, ADRs, specs and meeting notes. Use when reading, creating or updating Notion pages or querying a Notion database."
---

# Knowledge Management with Notion

Hosted Notion MCP at `https://mcp.notion.com/mcp` (OAuth, acting as the signed-in user). Tools: `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page`, `notion-query-data-sources`, `notion-create-comment`. Full list: https://developers.notion.com/docs/mcp-supported-tools

## Gotchas

- Results are limited to what the connected account can open. An empty `notion-search` usually means missing access, not a missing page — ask the user to share the parent rather than creating a duplicate.
- `notion-create-pages` needs a `parent` (page or database), so find it with `notion-search` first, then `notion-fetch` the new page to confirm it landed under that parent.
- Content is Notion-flavored Markdown, not block JSON. `notion-fetch` a page before `notion-update-page` so an edit keeps mentions, links and inline dates.
- A database holds one or more **data sources** (`collection://…` URLs). `notion-fetch` the database to get the data source and its schema, then read rows with `notion-query-data-sources`.
- `notion-search` and `notion-query-data-sources` share a rate limit of about 20 calls per 10 seconds; batch reads instead of looping.

## Document conventions

Place pages under the right parent (e.g. Engineering/Specs) and close the loop by adding implementation links back to the spec. Required sections per type:

- **Research** — Summary, Sources (URL + why relevant), Key Findings, Implications, Open Questions.
- **ADR** — `ADR-NNN: <title>`, Status (Proposed | Accepted | Deprecated | Superseded), Date, Context, Decision, Consequences, Alternatives Considered (with why rejected).
- **Spec** — Objective (one sentence), Background, Acceptance Criteria (checkboxes), Implementation (branch, PR link, tracker link).
- **Meeting** — Attendees, Type, Summary, Decisions Made (with owner), Action Items (owner + due date), Discussion Notes. Mirror action items into the tracker with links.
