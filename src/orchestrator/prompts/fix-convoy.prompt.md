---
description: 'Fix the problems found in a convoy task plan with targeted JSON patches. Goal is the plan as JSON, context is the list of problems.'
agent: 'Team Lead (OpenCastle)'
output: json
pipeline: true
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Fix Task Plan

You are the Team Lead. The task plan at the end of this prompt has problems. Fix every one with targeted JSON patches.

## What Happens to Your Answer

When `opencastle convoy` runs this step, your patches are applied to the plan, any glob in `files` is cut back to its directory, and the code checks the plan again:

- **Problems from the code's checks** come back to you if they remain — at most twice in all. After that, if two tasks still claim the same file, the later one is made to wait for the earlier; any other problem stops the plan from running.
- **Problems from a reviewer** get one round, and your patches are kept only if the plan still passes the code's checks.

This session is read-only; answer in text.

## Instructions

1. Read every problem before writing patches.
2. Fix ALL of them; do not fix some.
3. Keep the plan's intent, agents and task scope. Change only what is broken.
4. Each patch replaces ONE field of ONE task. You can change existing tasks, not add or remove them.

## Patch Format

One `json` fenced block holding an array of patches:

```json
[
  {
    "task_id": "the-task-id",
    "field": "prompt",
    "value": "Complete corrected prompt text..."
  },
  {
    "task_id": "another-task",
    "field": "depends_on",
    "value": ["project-scaffold", "shared-ui-components"]
  },
  {
    "task_id": "a-third-task",
    "field": "files",
    "value": ["components/Hero.tsx"]
  }
]
```

### Patch Fields

- `task_id`: The id of the task to change, or `"_plan"` to rename the plan (`field: "name"`).
- `field`: `prompt`, `files`, `depends_on`, `agent`, `description`, `complexity` or `timeout`.
- `value`: The complete new value. It replaces the old one entirely.

### Common Fixes

- **Two tasks claim the same file** → give each the specific files it changes (patch `files`), or patch `depends_on` so one runs after the other.
- **A pattern in `files`** → patch `files` with the actual files or their directory.
- **Unknown dependency** → patch `depends_on` with the right id, or without it.
- **Dependency cycle** → patch `depends_on` to drop the edge that points backwards.
- **Missing dependency** → patch `depends_on` to add it.
- **Missing work** → fold it into the closest task's `prompt` and `files`.
- **Truncated or vague prompt** → patch `prompt` with a complete, file-specific prompt that includes acceptance criteria.
- **Wrong agent** → patch `agent` with the right role.

## Output

Your whole answer is one `json` fenced block holding the patch array. Nothing before or after it.

---

## Task Plan

```json
{{goal}}
```

## Problems to Fix

{{context}}
