---
name: notion-knowledge-management
description: "Notion workspace patterns for knowledge capture, research documentation, architectural decisions, and spec management. Use when capturing research findings, writing specs, documenting decisions, or managing a team knowledge base."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Knowledge Management with Notion

Conventions for working with the team's Notion workspace via the official Notion MCP server. Covers page and database operations, research capture, decision documentation, and permission-aware workflows.

## MCP Server

| Field | Value |
|-------|-------|
| **Endpoint** | `https://mcp.notion.com/mcp` (HTTP, remote) |
| **Auth** | OAuth — users authenticate via Notion account when the MCP connection is established |
| **Type** | HTTP MCP (no local process to spawn) |

### Authentication

The Notion MCP server uses OAuth. When the MCP connection is first opened in your IDE, you will be prompted to authorise access to your Notion workspace. No API key or token is required in `.env`.

> **Scope:** The integration is granted access only to pages and databases explicitly shared with it. Before using MCP tools, ensure the relevant pages/databases are shared with the OpenCastle integration in Notion.

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Search pages and databases across the workspace by keyword |
| `create_page` | Create a new page (standalone or inside a parent page/database) |
| `update_page` | Update page properties or archive a page |
| `append_block_children` | Append content blocks (paragraphs, headings, bullets, code) to a page |
| `query_database` | Query a Notion database with filters and sorts |

## Working with Pages and Databases

### Page Hierarchy Hygiene

Keep the workspace navigable by placing new pages in the right location:

```
Workspace root
├── Engineering/
│   ├── Architecture Decisions/   ← ADRs go here
│   ├── Specs/                    ← Feature specs go here
│   └── Research/                 ← Research notes go here
├── Team/
│   ├── Meeting Notes/            ← Meeting intelligence
│   └── Decisions Log/            ← Key team decisions
└── Project: <name>/              ← Per-project space
    ├── Roadmap
    ├── Known Issues
    └── Release Notes/
```

- Always use `search` first to check if a page already exists before creating a new one.
- Create pages as children of the appropriate parent — never at the workspace root unless explicitly requested.
- Use databases (not flat pages) for collections that need filtering, sorting, or status tracking (e.g., ADRs, specs).

### Page Creation Pattern

When creating a page:

1. `search` for an existing page with a similar title to avoid duplicates
2. `create_page` with `parent` set to the correct parent page or database
3. `append_block_children` to add structured content

```json
// Example: Create a spec page
{
  "parent": { "page_id": "<Engineering/Specs parent ID>" },
  "properties": {
    "title": [{ "type": "text", "text": { "content": "[Spec] Price Range Filter" } }]
  }
}
```

## Capturing Research and Decisions

### Research Note Structure

Use this outline when capturing research findings:

```
# [Research] <Topic>

## Summary
One-paragraph overview of findings.

## Sources
- <URL or reference> — <why it is relevant>

## Key Findings
- Finding 1
- Finding 2

## Implications
How these findings affect the current task or architecture.

## Open Questions
- Question 1
```

### Architectural Decision Record (ADR) Structure

```
# ADR-NNN: <Short title>

**Status:** Proposed | Accepted | Deprecated | Superseded
**Date:** YYYY-MM-DD

## Context
What is the problem or decision to be made?

## Decision
What was decided?

## Consequences
What tradeoffs or follow-on work does this create?

## Alternatives Considered
- Option A — why rejected
- Option B — why rejected
```

### Spec-to-Implementation Link

When a spec page drives implementation, add an **Implementation** section at the bottom:

```
## Implementation
- **Branch:** `feat/price-range-filter`
- **PR:** <link>
- **Tracker:** <Linear/Jira/Trello card link>
- **Status:** In Progress / Done
```

This closes the loop between the knowledge base and the task tracker.

## Meeting Intelligence

When capturing meeting notes, use the following structure:

```
# Meeting: <Title> — YYYY-MM-DD

**Attendees:** Name1, Name2
**Type:** Planning / Review / Retrospective / Decision

## Summary

## Decisions Made
- Decision 1 (owner: Name)

## Action Items
- [ ] Action item (owner: Name, due: YYYY-MM-DD)

## Context / Discussion Notes
```

After the meeting, add action items to the task tracker.

## Permission-Aware Workflows

Notion access is page-scoped. Follow these rules to avoid permission errors:

1. **Before writing** — run `search` to verify you can see the target page. If it does not appear, the integration has not been granted access.
2. **Sharing** — ask the user to share the relevant page or database with the OpenCastle integration before running MCP tools against it.
3. **Databases vs pages** — use `query_database` only on pages that are databases. Use `append_block_children` to add content to regular pages.
4. **Archived pages** — `search` does not return archived pages. If a page is missing, it may have been archived. Ask the user to restore it.

## Database Query Patterns

### Filter by Status

```json
{
  "filter": {
    "property": "Status",
    "select": { "equals": "In Progress" }
  }
}
```

### Sort by Last Edited

```json
{
  "sorts": [
    { "timestamp": "last_edited_time", "direction": "descending" }
  ]
}
```

## Agent Usage Guidelines

| Agent | Primary Use |
|-------|-------------|
| **Team Lead** | Create spec pages, capture decisions, link tracker issues to specs |
| **Researcher** | Capture research notes, query databases for prior art, document findings |
| **Documentation Writer** | Write and update documentation pages, maintain page hierarchy |
| **Architect** | Write ADRs, create technical specs, link specs to implementation PRs |

**Never** delete pages via MCP — use `update_page` with `archived: true` if a page needs to be removed, and confirm with the user first.
