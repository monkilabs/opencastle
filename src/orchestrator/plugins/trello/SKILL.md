---
name: trello-task-management
description: "Create and manage Trello cards, checklists, and boards for kanban workflows. Use when the user says: 'create a kanban board', 'add a task card', 'move card to sprint', or 'track project board'."
---

# Task Management with Trello

For project-specific board IDs and list IDs, see [tracker-config.md](../../.opencastle/project/tracker-config.md).

## MCP Server

| Field | Value |
|-------|-------|
| **Package** | [`@delorenj/mcp-server-trello`](https://www.npmjs.com/package/@delorenj/mcp-server-trello) |
| **Type** | stdio (spawned via `npx -y @delorenj/mcp-server-trello`) |
| **Auth** | API key + token via `TRELLO_API_KEY` and `TRELLO_TOKEN` env vars |

## Available MCP Tools (quick)

- `get_boards`, `get_lists`, `get_cards_by_list_id`, `get_card_details` — read-only board/list/card tools
- `create_card`, `update_card`, `add_checklist_to_card`, `add_comment_to_card` — create/update tools (ensure proper auth)

### Example Invocations

```json
// trello/create_card
{ "listId": "abc123", "name": "[Feature] Add search", "desc": "Acceptance: returns results within 200ms", "labels": ["feature"] }
// → { "id": "card456", "url": "https://trello.com/c/card456", "name": "[Feature] Add search" }

// trello/update_card  — move card to In Progress
{ "cardId": "card456", "listId": "inprogress789" }
// → { "id": "card456", "idList": "inprogress789" }

// trello/add_comment_to_card
{ "cardId": "card456", "text": "Blocked: waiting for API schema approval" }
// → { "id": "comment999", "data": { "text": "Blocked: ..." } }
```

## Discovered Issues (Bug Tickets)

- Check existing cards for the issue.
- If tracked, skip and continue.
- If not tracked:
  - For unfixable limitations: add to known issues with severity, evidence, and root cause.
  - For fixable bugs: create a Trello card with Name (`[Bug] Short description`), List (`Backlog`), Description (symptoms, repro steps, affected files), and optional Due date if blocking.

## Card Naming

Use `[Area] Short description` format:

```
[Schema] Add priceRange field to place type
[DB] Add price_range column and migration
[UI] Build PriceRangeFilter component
[API] Add price filter endpoint
[Test] Unit tests for price filter
[Docs] Update data model documentation
```


## Board and List Workflow

### Agent-Driven Card Transitions (via MCP)

| From | To | When |
|------|----|------|
| Backlog / To Do | In Progress | Agent starts working on the card |
| In Progress | Done | Non-PR task is verified (docs, config) |
| Any | Backlog | Task is deferred |

After each create/update, verify the returned card ID and URL before proceeding.

## Session Continuity

At the start of each work session:

1. `get_boards` — confirm the right board is active
2. `get_lists` — identify current list structure
3. `get_cards_by_list_id` for **In Progress** — resume work on relevant cards, updating checklists and moving to next list when done
