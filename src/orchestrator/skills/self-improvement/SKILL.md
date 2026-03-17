---
name: self-improvement
description: "Protocol for reading and updating the lessons-learned knowledge base. MUST be followed by ALL agents — read lessons before work, write lessons after retries. This makes the agent team self-improving across sessions."
---

# Self-Improvement Protocol

## Core Rule

**Retry with a different approach and it works → document the lesson immediately.** File: `.opencastle/LESSONS-LEARNED.md`

## Writing a Lesson

> **⛔ HARD GATE — Use the CLI. Do NOT edit LESSONS-LEARNED.md directly.**

```sh
opencastle lesson --title "Short descriptive title" --category general --severity high \
  --problem "What was observed" --wrong "Failing approach" --correct "Working solution" \
  --why "Root cause"
```

Required: `--title`, `--category`, `--severity`, `--problem` · Optional: `--wrong`, `--correct`, `--why`

After writing: if the lesson reveals a gap in a skill/instruction file, update that file too (prevents the pitfall at source).

## Categories

| Category | Covers |
|----------|--------|
| `task-management` | Task tracker tools, issue management, workflow states |
| `jira` | Jira MCP tools (Atlassian Rovo) |
| `mcp-tools` | MCP server tool quirks (deferred loading, parameters) |
| `codebase-tool` | Task runner CLI commands, caching, build tools |
| `terminal` | Shell commands, port/process management |
| `framework` | App framework, build, dev server, SSR |
| `cms` | CMS content queries, schema deployment |
| `database` | Database auth, migrations, RLS, SQL |
| `git` | Git operations, branching, merge conflicts |
| `deployment` | Deployment, environment variables, edge config |
| `browser-testing` | E2E testing, screenshots, browser automation |
| `general` | Anything else |

## Severity

| Level | Impact |
|-------|--------|
| `high` | Blocks work — agent cannot proceed without the workaround |
| `medium` | Wastes 5+ minutes |
| `low` | Minor friction |

## Quality Rules

- Include exact error messages, commands, and tool parameters
- Show wrong **and** correct approaches — the contrast is actionable
- Explain why (root cause)
- One lesson per entry; code blocks mandatory for commands

## Anti-Patterns

Never skip reading lessons · Never fix without documenting · Never write vague entries · Never duplicate · Never defer to end of session

## Agent Memory

For expertise tracking and cross-session knowledge graphs, load the **agent-memory** skill.
