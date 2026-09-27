# Customizations

Project-specific configuration for the AI agent framework. Everything in this folder is **particular to this project** — the rest of the orchestrator directory (instructions, skills, agents, prompts, workflows) is designed to be project-agnostic and reusable across repositories.

## Why this exists

Skills and instructions contain generic methodology (how to write migrations, how to test in a browser, how to run a panel review). This folder holds the concrete values those skills operate on — project IDs, table schemas, team UUIDs, endpoint inventories, and similar configuration that changes per project.

Skills reference these files by root-relative path, like `.opencastle/stack/api-config.md`, so agents automatically load project context when they load a skill.

## Contents

| File | Purpose |
|------|---------|
| `project.instructions.md` | High-level project context — apps, libraries, tech stack, ports, URLs |
| `LESSONS-LEARNED.md` | Knowledge base of retries, workarounds, and gotchas — read before every session |
| `KNOWN-ISSUES.md` | Tracked issues, limitations, and accepted risks discovered during sessions |
| `AGENT-FAILURES.md` | Dead letter queue for failed agent delegations |
| `AGENT-PERFORMANCE.md` | Agent success tracking, log query recipes, performance metrics |
| `AGENT-EXPERTISE.md` | Structured tracking of agent strengths/weaknesses across sessions |
| `KNOWLEDGE-GRAPH.md` | Append-only relationship log for file dependencies, patterns, decisions |

### `agents/` — Agent framework config

| File | Purpose |
|------|---------|
| `agent-registry.md` | Specialist agents with model tier assignments and scope examples |
| `skill-matrix.json` | Maps capability slots to concrete skill names per agent role (machine-readable) |
| `skill-matrix.md` | Documentation companion explaining the skill matrix concept |

### `stack/` — Tech stack config

| File | Purpose |
|------|---------|
| _(created by `opencastle init` based on detected technologies)_ | |

### `project/` — Project management config

| File | Purpose |
|------|---------|
| `docs-structure.md` | Project documentation directory tree and practices |
| `roadmap.md` | Project roadmap with planned features and their status |
| `decisions.md` | Architecture Decision Records (ADRs) for the project |
| _(task tracker config created by `opencastle init`)_ | |

### `logs/` — Append-only NDJSON session logs

Structured machine-readable logs appended automatically by agents during sessions, delegations, and panel reviews.

| File | Purpose |
|------|---------|
| `README.md` | Schema documentation for the NDJSON log files |
| `events.ndjson` | All structured event log entries (sessions, delegations, reviews, panels, disputes) |

## When to update

Update these files when the project changes — new tables, new API routes, new apps, new tracker labels, etc. The skills themselves should rarely need editing; changing a project ID or adding a table column is a customization change, not a skill change.

## Bootstrap

Run `npx opencastle init` to auto-discover the project's structure and populate these files. It scans for frameworks, databases, CMS, deployment config, and task tracking, then generates the appropriate `stack/` and `project/` files.
