---
name: linear-task-management
description: "Linear issue conventions: naming, labels, priorities, status transitions and PR links. Use when creating or updating Linear issues, breaking a feature into Linear tasks, or resuming work tracked in Linear."
---

# Task Management with Linear

Team, workflow states and labels: `.opencastle/project/linear-config.md`. Docs: https://linear.app/docs/mcp

## The MCP server

Linear's own remote server (`https://mcp.linear.app/mcp`), signed in with OAuth — each teammate as themselves, so issue history shows who did what. It finds, creates and updates issues, projects and comments, and lists teams, cycles, statuses and labels. Tool names change between server versions: read the tool list the server offers instead of assuming a name.

## Gotchas

- **Look up, don't guess.** Read the team's statuses and labels from the server before setting them, and record the ones the team uses in `linear-config.md`.
- **Blockers go in a comment** on the issue, not in the description — the description is the spec.
- Treat a create as successful only if it returns an issue ID (`TAS-42`) — verify before delegating.
- GitHub integration auto-transitions on PR events (push → In Progress, review → In Review, merge → Done), configured in *Settings → Team → Pull request automation*. Link by putting `TAS-123` in the branch or PR title.
- On resume, re-read every issue status before acting; a stale local view causes double work.

## Conventions

Verb-first titles mapping to intent: `Add schema: priceRange to place`, `Migrate DB: add price_range`, `Update query: include priceRange`, `Implement UI: PriceRangeFilter`.

Priority: P1 blocks other tasks / critical path, P2 core feature on critical path, P3 parallelizable support work, P4 docs and polish.

Flow `Backlog → Todo → In Progress → In Review → Done → Cancelled`. Every description carries **Objective**, **Files (partition)**, **Acceptance Criteria**, **Dependencies** (`#TAS-XX`). Group related issues under a Linear project.

Untracked bug: search first; if absent create `[Bug] <symptom>` with `bug` + domain labels, P1–P4 plus rationale, and acceptance steps.
