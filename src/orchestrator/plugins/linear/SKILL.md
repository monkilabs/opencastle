---
name: linear-task-management
description: "Creates and names Linear issues, assigns labels and priorities, manages status transitions, and links issues to PRs. Use when decomposing features into tasks or resuming interrupted sessions. Trigger terms: tickets, backlog, task breakdown, project board, sprint planning"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Task Management with Linear

For project-specific team ID, workflow state UUIDs, and label UUIDs, see [tracker-config.md](../../.opencastle/project/tracker-config.md).

## MCP Tool Examples

```json
// Create issue
{ "teamId": "TEAM_UUID", "title": "[UI] Build PriceRangeFilter", "description": "Objective: ...\nFiles: ...\nAC: ...", "labelIds": ["LABEL_UUID"], "priority": 2 }
// → { "id": "TAS-42", "url": "https://linear.app/team/TAS-42" }

// Update issue status
{ "issueId": "TAS-42", "stateId": "IN_PROGRESS_UUID" }

// Search issues
{ "query": "is:open assignee:me", "teamId": "TEAM_UUID" }
```

## Discovered Issues

- Search Linear for existing tickets; if found, link and add evidence.
- If not found, create: Title `[Bug] <symptom>`, Labels `bug` + domain, Priority P1–P4 with rationale, Acceptance steps.

## Issue Naming

Name issues using a verb-first, actionable format that maps to operator intent:

```
Add priceRange field to place type  -> Action: `Add schema: priceRange to place`
Run DB migration to add price_range column -> Action: `Migrate DB: add price_range`
Update GROQ query to include priceRange filter -> Action: `Update query: include priceRange`
Build PriceRangeFilter component -> Action: `Implement UI: PriceRangeFilter`
```

## Priority

| Level | When to use |
|-------|-------------|
| P1 (Urgent) | Blocks other tasks, critical path |
| P2 (High) | Core feature work, on critical path |
| P3 (Medium) | Supporting tasks, can be parallelized |
| P4 (Low) | Docs, cleanup, polish |

## Status Workflow

```
Backlog -> Todo -> In Progress -> In Review -> Done -> Cancelled
```

### Transition Rules

- Agent (via MCP): `Todo → In Progress` on start; `In Progress → Done` on verified completion; `Any → Cancelled` to drop.
- GitHub integration: auto-updates status on PR events (push → In Progress, review → In Review, merge → Done). Configure in Linear *Settings → Team → Pull request automation*.
- Link via issue ID in branch/PR title (e.g., `TAS-123`).

## Issue Descriptions

Every issue must include: **Objective** (one sentence), **Files (partition)** (paths this agent may modify), **Acceptance Criteria** (verifiable checklist), **Dependencies** (`#TAS-XX`).

Group related issues under a Linear project; issues track individual subtasks.

## Session Workflow

1. Check board for existing in-progress work.
2. Decompose feature into issues; create all on Linear — verify each returns a valid issue ID.
3. Delegate: move to **In Progress** before starting; **Done** after verified.
4. If blocked, update the issue description (Linear MCP has no comment API).
5. On resume: filter by In Progress/Todo, read descriptions, continue.
6. On completion: verify all issues Done/Cancelled, run build/lint/test.

If creation fails: check team ID and state UUIDs in [tracker-config.md](../../.opencastle/project/tracker-config.md); retry once. If board state is inconsistent on resume: re-read all issue statuses before proceeding.
