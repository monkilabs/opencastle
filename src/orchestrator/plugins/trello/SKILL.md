---
name: trello-task-management
description: "Trello board conventions for tracking feature work — board/list/card workflow, checklist-driven task breakdown, due dates, and when to use comments vs checklist items. Use when decomposing features into cards or resuming interrupted sessions."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Task Management with Trello

Conventions for tracking feature work on Trello boards via MCP tools. For project-specific board IDs and list IDs, see [tracker-config.md](../../.opencastle/project/tracker-config.md).

## MCP Server

| Field | Value |
|-------|-------|
| **Package** | [`@delorenj/mcp-server-trello`](https://www.npmjs.com/package/@delorenj/mcp-server-trello) |
| **Type** | stdio (spawned via `npx -y @delorenj/mcp-server-trello`) |
| **Auth** | API key + token via `TRELLO_API_KEY` and `TRELLO_TOKEN` env vars |

### Authentication

1. Get your API key at [trello.com/app-key](https://trello.com/app-key) → **API Key**
2. On the same page, click **"Generate a Token"** to get your token
3. Add both to your `.env` file:

```
TRELLO_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TRELLO_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_boards` | List all boards accessible to the authenticated user |
| `get_lists` | Get all lists on a board (by board ID) |
| `get_cards_by_list_id` | Get all cards in a specific list |
| `get_card_details` | Get full details of a single card |
| `create_card` | Create a new card in a list |
| `update_card` | Update card fields (name, description, due date, list) |
| `add_checklist_to_card` | Add a checklist with items to a card |
| `add_comment_to_card` | Post a comment on a card |

## Discovered Issues (Bug Tickets)

When an agent encounters a pre-existing bug or issue unrelated to the current task, it must be tracked:

1. **Check** existing cards on the board to see if it is already tracked
2. **If tracked** — skip it, continue with current work
3. **If NOT tracked:**
   - **Unfixable limitation** — add to known issues with severity, evidence, and root cause
   - **Fixable bug** — create a Trello card:
     - **Name:** `[Bug] Short description of the symptom`
     - **List:** `Backlog` (or the equivalent list in your project)
     - **Description:** Include symptoms, reproduction steps, affected files, and any error messages
     - **Due date:** Set only if it is blocking current work

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

**Area prefixes:** `[Schema]`, `[DB]`, `[Query]`, `[UI]`, `[Page]`, `[API]`, `[Auth]`, `[Test]`, `[Docs]`, `[Deploy]`, `[Data]`, `[Perf]`, `[Security]`, `[Bug]`

## Board and List Workflow

### Typical List Structure

```
Backlog  →  To Do  →  In Progress  →  In Review  →  Done
```

- **Backlog** — Captured but not yet planned
- **To Do** — Planned and ready to start
- **In Progress** — Actively being worked on
- **In Review** — PR open, awaiting review or merge
- **Done** — Completed and verified

### Agent-Driven Card Transitions (via MCP)

| From | To | When |
|------|----|------|
| Backlog / To Do | In Progress | Agent starts working on the card |
| In Progress | Done | Non-PR task is verified (docs, config) |
| Any | Backlog | Task is deferred |

## Checklist-Driven Task Breakdown

Use checklists for **subtask decomposition within a single card**. This keeps related work together without cluttering the board with micro-cards.

### When to Use a Checklist vs a Separate Card

| Use a **checklist item** when… | Use a **separate card** when… |
|-------------------------------|------------------------------|
| Steps are sequential and tightly coupled | Work can be assigned independently |
| Total effort fits in one session | Each step spans multiple sessions |
| Steps share the same assignee | Steps need different labels/due dates |
| Internal implementation details | Distinct deliverables that need review |

### Checklist Pattern for Feature Decomposition

```
Card: [Feature] Add price range filter
Checklist: Implementation Steps
  ☐ Add priceRange field to schema
  ☐ Create DB migration
  ☐ Update GROQ/API query
  ☐ Build UI component
  ☐ Wire into page
  ☐ Write unit tests
  ☐ Update documentation
```

## Due and Start Dates

Trello cards support both a **start date** and a **due date**.

- **Due date** — The deadline for the card to move to Done. Set for tasks on the critical path.
- **Start date** — When work is expected to begin. Useful for pipeline planning.
- **Due time** — Be explicit with time only for time-sensitive deliverables (e.g., scheduled releases).
- **Format:** Trello API uses ISO 8601: `2026-03-20T14:00:00.000Z`

## Comments vs Checklist Items

| Use **comments** for… | Use **checklist items** for… |
|-----------------------|------------------------------|
| Progress updates visible to the team | Actionable steps with completion state |
| Blocking issues or decisions | Pre-defined subtask decomposition |
| Links to PRs, builds, external docs | Typed acceptance criteria |
| Questions or async approvals | Implementation sub-steps |
| Post-implementation notes | QA verification steps |

**Rule of thumb:** If it needs to be *checked off*, it's a checklist item. If it needs to be *read*, it's a comment.

## Session Continuity

At the start of each work session:

1. `get_boards` — confirm the right board is active
2. `get_lists` — identify current list structure
3. `get_cards_by_list_id` for **In Progress** — find cards already in flight
4. Resume work on the relevant card, updating the checklist as steps complete
5. Move the card to the next list when the current phase is done
