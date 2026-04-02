---
name: jira-management
description: "Create and update Jira issues, epics, and sprints; manage backlog and sprint transitions. Use when you say: 'create a ticket', 'open a story', 'link an epic', 'start a sprint', or 'search the backlog'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Task Management with Jira

For project-specific project keys, workflow state IDs, and board configuration, see [tracker-config.md](../../.opencastle/project/tracker-config.md).

## MCP Tool Examples

```json
// Search issues
{ "jql": "project = PROJ AND status = 'In Progress' ORDER BY priority DESC" }

// Create issue
{ "project": "PROJ", "summary": "[UI] Build PriceRangeFilter", "type": "Task", "description": "Objective: ...\nFiles: ...\nAC: ..." }

// Transition issue
{ "issueKey": "PROJ-42", "status": "In Progress" }
```

## Discovered Issues

Check Jira first; if untracked, create a `[Bug]` issue in Backlog with symptoms, repro steps, and affected files.

## Issue Naming

Use `[Area] Short description` format in the Summary field:

```
[Schema] Add priceRange field to place type
[DB] Add price_range column and migration
[Query] Update query with priceRange filter
[UI] Build PriceRangeFilter component
[Page] Integrate price filter into /places
[Test] E2E test price range filtering
[Docs] Update data model documentation
```


## Status Workflow

```
Backlog → To Do → In Progress → In Review → Done
```

### Transition Rules

- Agent (via MCP): `To Do → In Progress` on start; `In Progress → Done` on verified completion.
- Automation: PR events auto-update status when GitHub/Jira integration is configured.
- Link via Jira key in branch/PR title (e.g., `PROJ-123`).

## Issue Descriptions

Every issue must include: **Objective** (one sentence), **Files (partition)** (paths this agent may modify), **Acceptance Criteria** (verifiable checklist), **Dependencies** (issue keys).

Group related issues under a Jira Epic; use components or labels for domain grouping.

## Session Workflow

1. Search the board (JQL) for existing in-progress work.
2. Decompose the feature into issues; create all in Jira — verify each returns a valid issue key.
3. Link dependencies between issues.
4. Delegate: move issue to **In Progress** before starting; move to **Done** after verified.
5. If creation/transition fails: retry once; check project key and workflow state IDs in [tracker-config.md](../../.opencastle/project/tracker-config.md).
6. On resume: search by status (In Progress, To Do), read descriptions, continue.
7. On completion: verify all Epic issues are Done, run build/lint/test, close the Epic.

## JQL Quick Reference

Common queries for agent workflows:

```jql
project = PROJ AND status = "In Progress" ORDER BY priority DESC
project = PROJ AND status = "To Do" ORDER BY priority DESC
project = PROJ AND type = Bug AND status != Done ORDER BY priority DESC
project = PROJ AND sprint in openSprints() ORDER BY priority DESC
project = PROJ AND priority = Highest AND status != Done
```
