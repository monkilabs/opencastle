---
description: 'Fix validation errors in convoy task plan by outputting targeted JSON patches.'
agent: 'Team Lead (OpenCastle)'
output: json
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Fix Task Plan

You are the Team Lead. Task plan below has validation errors. Fix every error by outputting targeted JSON patches.

## Task Plan

```json
{{goal}}
```

## Validation Errors

{{context}}

---

## Instructions

1. Read every error before writing patches.
2. Fix ALL reported errors; do not partially fix.
3. Preserve intent, agent assignments, task scope. Only fix what is broken.
4. Each patch replaces ONE field on ONE task.

## Patch Format

Output single `json` fenced code block with array of patches:

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
    "task_id": "_plan",
    "field": "concurrency",
    "value": 2
  }
]
```

### Patch fields
- `task_id`: Task ID to modify, or `"_plan"` for top-level plan fields (`name`, `branch`, `concurrency`, `on_failure`, `gates`, `gate_retries`)
- `field`: Field name to replace (`prompt`, `files`, `depends_on`, `agent`, `timeout`, `description`, `max_retries`, `review`, `gates`)
- `value`: Complete new value (replaces old value entirely)

### Common fixes
- **Truncated prompt** → patch `field: "prompt"` with complete, self-contained prompt text
- **Missing dependency** → patch `field: "depends_on"` with corrected array
- **Partition conflict** → patch `field: "files"` to use specific paths, or patch `field: "depends_on"` to add sequencing
- **Wrong agent** → patch `field: "agent"` with correct value from roster
- **Vague prompt** → patch with detailed, file-specific prompt including acceptance criteria

## Output

Your entire response must be single `json` fenced code block with patches array. No text before or after.
