# .opencastle/

This directory is yours. It holds what the assistants need to know about this
project, the team's own instructions, skills, agents, prompts and workflows, and
the team config. `opencastle sync` compiles it, with OpenCastle's own content and
any baseline the team extends, into the config every assistant reads.

To change what the assistants are told, edit here — not the generated files.
`opencastle sync --check` fails when someone edits a generated file in place.

## What is here

| Path | What it is |
|------|------------|
| `project.instructions.md` | The project: stack, structure, commands, routes, environment, and which skill covers which part. `init` wrote it from the code; correct it and add what the code cannot say |
| `stack/*.md` | Details the stack's skills read: the API's endpoints, the database's models and migrations, how tests and browser checks run, how it deploys |
| `KNOWN-ISSUES.md` | Problems and accepted risks found while working, checked before starting a task |
| `LESSONS-LEARNED.md` | Index of `lessons/`, one file per lesson, written by `opencastle lesson`. Rewritten by `sync`; never edit it by hand |
| `agents/agent-registry.md` | Which agent is for what, and on which tier |
| `agents/skill-matrix.json` | Which skills each agent loads, per capability slot |
| `config.json` | Team config, when you add one: `extends`, `exclude`, `mcpServers`, `policy`. Schema: <https://www.opencastle.dev/schema/config.json> |
| `lock.json`, `manifest.json` | What is installed and what every assistant is given. Written by `sync`; commit both |

Created when there is something to put in them: `AGENT-FAILURES.md` and
`DISPUTES.md` (a delegation that failed for good, and a disagreement for a
person to decide), `project/decisions.md` and `project/roadmap.md`, and the
agent-memory files. `logs/`, the convoy database and worktrees are local and
gitignored.

## The team's own sources

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

## Keeping it current

Update these files when the project changes — a new table, route, app or
environment. A file's "Still to describe" list is what `init` could not read
from the code; `/oc:bootstrap-customizations` (in Claude Code or Copilot Chat;
elsewhere, ask for the bootstrap-customizations prompt by name) has an agent fill
it in.
