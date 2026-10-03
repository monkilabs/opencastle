# .opencastle/

This directory is yours. It holds the project context the shipped skills read,
the team's own instructions, skills, agents, prompts and workflows, and the team
config. `opencastle sync` compiles it, together with OpenCastle's own content and
any baseline the team extends, into the config every assistant reads.

To change what the assistants are told, edit here — not the generated files.
`opencastle sync --check` fails when someone edits a generated file in place or
adds one by hand to a generated directory.

## Why this exists

Skills and instructions contain generic methodology (how to write migrations,
how to test in a browser, how to run a panel review). This directory holds the
concrete values those skills operate on — project IDs, table schemas, team
UUIDs, endpoint inventories, and similar configuration that changes per project.

Skills reference these files by root-relative path, like
`.opencastle/stack/api-config.md`, so agents load project context when they load
a skill.

## Contents

| File | Purpose |
|------|---------|
| `README.md` | This file |
| `config.json` | Team config, when you add one: `extends` (baselines), `exclude`, `mcpServers`, `policy`. Schema: <https://www.opencastle.dev/schema/config.json> |
| `project.instructions.md` | High-level project context — apps, libraries, tech stack, ports, URLs |
| `LESSONS-LEARNED.md` | Index of the lessons in `lessons/` — read before every session. Rewritten by `opencastle sync`; never edited by hand |
| `lessons/` | One file per lesson: retries, workarounds and gotchas, written by `opencastle lesson` |
| `KNOWN-ISSUES.md` | Tracked issues, limitations, and accepted risks discovered during sessions |
| `DISPUTES.md` | Disagreements automated review could not settle, packaged for a person to decide |
| `AGENT-FAILURES.md` | Dead letter queue for failed agent delegations |
| `AGENT-PERFORMANCE.md` | Agent success tracking, log query recipes, performance metrics |
| `AGENT-EXPERTISE.md` | Structured tracking of agent strengths/weaknesses across sessions |
| `KNOWLEDGE-GRAPH.md` | Append-only relationship log for file dependencies, patterns, decisions |
| `lock.json` | What every assistant is given. Written by every `sync`; commit it |
| `manifest.json` | What is installed, and for which assistants. Written by `init` and `sync` |

`sync` rewrites `LESSONS-LEARNED.md`, `lock.json` and `manifest.json`. It keeps
your edits to everything else here.

### The team's own sources

`opencastle sync` compiles these into every assistant, in each one's own
format. One with the same name as an item OpenCastle or a baseline ships
replaces it; `exclude` in `config.json` drops one.

| Path | Becomes |
|------|---------|
| `instructions/*.md` | Instructions every assistant always loads |
| `skills/<name>/SKILL.md` | A skill, in the Agent Skills format |
| `agents/*.agent.md` | An agent to delegate to |
| `prompts/*.md` | A prompt — `/oc:<name>` in Claude Code and Copilot Chat |
| `workflows/*.md` | A workflow template |

### `agents/` — Agent framework config

Beside any agents of your own:

| File | Purpose |
|------|---------|
| `agent-registry.md` | Specialist agents with model tier assignments and scope examples |
| `skill-matrix.json` | Maps capability slots to concrete skill names per agent role (machine-readable) |
| `skill-matrix.md` | Documentation companion explaining the skill matrix concept |

### `stack/` — Tech stack config

Notes on the stack that the skills read. `opencastle init` writes the ones for
what it detected, such as `testing-config.md`, or `supabase-config.md` when the
project uses Supabase.

### `project/` — Project management config

| File | Purpose |
|------|---------|
| `docs-structure.md` | Project documentation directory tree and practices |
| `roadmap.md` | Project roadmap with planned features and their status |
| `decisions.md` | Architecture Decision Records (ADRs) for the project |
| `tracker-config.md` | Task tracker settings, when a tracker is set up |

### `logs/` — Append-only NDJSON session logs

Structured logs agents append with `opencastle log` during sessions,
delegations, reviews, panels and disputes. Gitignored, like the other run
artefacts here.

| File | Purpose |
|------|---------|
| `README.md` | The record schema |
| `events.ndjson` | Every record, one JSON object per line |

## When to update

Update these files when the project changes — new tables, new API routes, new
apps, new tracker labels, etc. The skills themselves should rarely need editing;
changing a project ID or adding a table column is a customization change, not a
skill change.

## Bootstrap

`opencastle init` fills in what it can detect: frameworks, databases, CMS,
deployment config and task tracking. On an existing codebase, run the
`bootstrap-customizations` prompt next (`/oc:bootstrap-customizations` in
Claude Code or Copilot Chat; in other assistants, ask for it by name) to fill
in the rest from the code.
