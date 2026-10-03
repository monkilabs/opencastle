````markdown
# Lessons Learned

Structured log of tool/command pitfalls, workarounds, and correct approaches discovered through agent execution. **Every agent** must read this file before starting work and must add entries when they discover a new pitfall through trial-and-error.

> **This file is the collective memory of the agent team.** It prevents repeating the same mistakes across sessions.

---

## How to Use This File

### Before starting work

1. Read the **entire file** (or at minimum, the sections relevant to your task)
2. Apply any relevant lessons to your approach **before** attempting commands or tool calls

### When to add a new entry

Add a lesson when **any** of these occur:
- A command, tool call, or API call fails and you had to retry with a different approach
- You discover a parameter, syntax, or configuration quirk not documented elsewhere
- A workaround is needed for a third-party tool, MCP server, or platform limitation
- An approach that seems obvious turns out to be wrong

### Entry format

```markdown
### LES-XXX: Short descriptive title

| Field | Value |
|-------|-------|
| **Category** | `task-management` / `mcp-tools` / `codebase-tool` / `terminal` / `framework` / `cms` / `database` / `git` / `deployment` / `browser-testing` / `general` |
| **Added** | YYYY-MM-DD |
| **Severity** | `high` (blocks work) / `medium` (wastes 5+ min) / `low` (minor annoyance) |

**Problem:** What went wrong and what error or unexpected behavior was observed.

**Wrong approach:** The obvious/intuitive approach that fails.

**Correct approach:** The working solution.

**Why:** Root cause explanation (if known).
```

---

## Lessons

<!-- Lessons are appended here by agents during sessions.
     Start numbering from LES-001. -->

---

## Index by Category

| Category | Lessons |
|----------|---------|
| `task-management` | — |
| `mcp-tools` | — |
| `codebase-tool` | — |
| `terminal` | — |
| `framework` | — |
| `cms` | — |
| `database` | — |
| `git` | — |
| `deployment` | — |
| `browser-testing` | — |
| `general` | — |

````
