---
name: linear-task-management
description: "Creates and names Linear issues, assigns labels and priorities, manages status transitions, and links issues to PRs. Use when decomposing features into tasks or resuming interrupted sessions. Trigger terms: tickets, backlog, task breakdown, project board, sprint planning"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Task Management with Linear

Team ID, workflow state UUIDs, and label UUIDs: [tracker-config.md](../../.opencastle/project/tracker-config.md). Docs: https://linear.app/docs

## The `stateId` UUID trap

`update_issue` requires a workflow state **UUID**. Passing a display name like `"In Progress"` always fails with `stateId must be a UUID`. The names returned by `list_issues` / `get_issue` are display-only and are *not* valid `stateId` values.

```json
// works — UUID read from tracker-config.md
{ "issueId": "TAS-42", "stateId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
// fails — name, not UUID
{ "issueId": "TAS-42", "status": "In Progress" }
```

If `tracker-config.md` has no state UUIDs: skip status updates and log a warning. To populate them, ask the user for Linear *Settings → Teams → Workflow* (the UUID is in the browser URL per state) or the GraphQL `workflowStates { nodes { id name } }` query. Labels and teams are UUIDs too (`teamId`, `labelIds`).

## Other gotchas

- **Linear MCP has no comment API.** To record a blocker, edit the issue description.
- Treat a create as successful only if it returns an issue ID (`TAS-42`) — verify before delegating.
- GitHub integration auto-transitions on PR events (push → In Progress, review → In Review, merge → Done), configured in *Settings → Team → Pull request automation*. Link by putting `TAS-123` in the branch or PR title.
- On resume, re-read every issue status before acting; a stale local view causes double work.

## Conventions

Verb-first titles mapping to intent: `Add schema: priceRange to place`, `Migrate DB: add price_range`, `Update query: include priceRange`, `Implement UI: PriceRangeFilter`.

Priority: P1 blocks other tasks / critical path, P2 core feature on critical path, P3 parallelizable support work, P4 docs and polish.

Flow `Backlog → Todo → In Progress → In Review → Done → Cancelled`. Every description carries **Objective**, **Files (partition)**, **Acceptance Criteria**, **Dependencies** (`#TAS-XX`). Group related issues under a Linear project.

Untracked bug: search first; if absent create `[Bug] <symptom>` with `bug` + domain labels, P1–P4 plus rationale, and acceptance steps.
