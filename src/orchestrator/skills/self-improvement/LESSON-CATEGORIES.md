# Lesson Categories & Severity

The values `npx opencastle lesson` accepts. Anything else is refused.

## Categories

| `--category` | When to use |
|--------------|-------------|
| `task-management` | Issue trackers, task status, boards |
| `jira` | Jira specifically: fields, transitions, JQL |
| `mcp-tools` | An MCP server's tools, parameters or quirks |
| `codebase-tool` | Search, refactoring and code-intelligence tools |
| `terminal` | Shell, quoting, CLI flags, environment |
| `framework` | The app framework and its build |
| `cms` | Content models, queries, publishing |
| `database` | Migrations, policies, queries |
| `git` | Branches, history, merges, hooks |
| `deployment` | Hosting, environment variables, caching, rollback |
| `browser-testing` | Browser automation, screenshots, breakpoints |
| `general` | Workflow, delegation, review — anything above does not cover |

## Severity

| `--severity` | Criteria |
|--------------|----------|
| `high` | Blocks a task, loses data, or causes significant rework |
| `medium` | Wastes five minutes or more |
| `low` | Nice to know; minor efficiency improvement |

## What a lesson file looks like

`npx opencastle lesson` writes `.opencastle/lessons/<id>.md`:

```markdown
---
id: "2026-10-02-always-quote-shell-variables"
title: "Always quote shell variables"
category: "terminal"
severity: "medium"
added: "2026-10-02"
citations:
  - "scripts/clean.sh:12"
verified: "2026-10-02"
fingerprints:
  scripts/clean.sh: "3f2a9c1b7d4e"
---

**Problem:** Unquoted variables break on paths with spaces.

**Wrong approach:** `rm -rf $DIR/old`

**Correct approach:** `rm -rf "$DIR/old"`
```

Lessons recorded before this format keep their `LES-NNN` ids.
