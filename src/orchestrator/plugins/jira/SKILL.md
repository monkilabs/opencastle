---
name: jira-management
description: "Create and update Jira issues, epics, and sprints; manage backlog and sprint transitions. Use when you say: 'create a ticket', 'open a story', 'link an epic', 'start a sprint', or 'search the backlog'."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Task Management with Jira

Project keys, workflow state IDs, and board config: [tracker-config.md](../../.opencastle/project/tracker-config.md). Docs: https://developer.atlassian.com/cloud/jira/platform/

## Gotchas

- Transitions are constrained by the project's workflow — a jump the board does not allow fails even with a valid status name. Read the workflow state IDs from `tracker-config.md` before transitioning; retry once, then stop.
- Status names in JQL must be quoted when they contain spaces: `status = "In Progress"`.
- A `create` call is only successful if it returns an issue key. Verify before treating the issue as tracked.
- PR-driven status updates only happen when the GitHub/Jira integration is configured; link by putting the key (`PROJ-123`) in the branch or PR title.

## Conventions

Summary format `[Area] Short description` — e.g. `[Schema] Add priceRange field`, `[DB] Add price_range column`, `[UI] Build PriceRangeFilter`, `[Test] E2E price range filtering`.

Every description must carry: **Objective** (one sentence), **Files (partition)** (paths this agent may modify), **Acceptance Criteria** (verifiable checklist), **Dependencies** (issue keys). Group under an Epic; use components or labels for domain grouping.

Flow `Backlog → To Do → In Progress → In Review → Done`. Agent moves `To Do → In Progress` on start, `In Progress → Done` only after verification.

Untracked bug found mid-task: search Jira first; if absent create a `[Bug]` in Backlog with symptoms, repro steps, and affected files.

## JQL

```jql
project = PROJ AND status = "In Progress" ORDER BY priority DESC
project = PROJ AND type = Bug AND status != Done ORDER BY priority DESC
project = PROJ AND sprint in openSprints() ORDER BY priority DESC
project = PROJ AND priority = Highest AND status != Done
```

Session: query in-progress work first → decompose into issues → link dependencies → transition before/after each → on completion verify all Epic issues Done, run build/lint/test, close the Epic.
