---
description: 'Validate a convoy task plan for semantic correctness. Outputs VALID or INVALID with specific errors.'
agent: 'Reviewer'
output: validation
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Validate Task Plan

> **Note:** Schema validation (field types, YAML syntax, dependency cycles, glob patterns) has already passed. The generator already enforces prompt quality, agent matching, and file list completeness. Focus ONLY on the structural and logical checks below.

You are a senior technical reviewer. Validate the task plan below for **structural correctness**. Pass the plan if the structure is sound — do not fail for prompt wording, style, or verbosity.

## Task Plan to Validate

{{goal}}

---

## Validation Checks

> If the spec contains `<!-- validation-pass: N -->`, this is pass N. On pass 2+, verify previous fixes were applied — do NOT invent new issues.

Evaluate the checks below. If ALL pass, respond `VALID`. Only fail for checks marked BLOCKING.

### Partition Conflicts (BLOCKING)

Two tasks that can run in parallel (no direct or transitive `depends_on` edge between them) must not share any `files` entry.

- [ ] For every pair of potentially-parallel tasks, confirm they share no file or directory path in their `files` lists
- [ ] Transitive dependencies count: if A → B → C, then A and C are NOT parallel

### Dependency Completeness (BLOCKING)

If a task's prompt imports, references, or builds on files produced by another task, a `depends_on` edge to that producing task must exist.

- [ ] Scan every prompt for cross-task file references
- [ ] Each such reference must be covered by a `depends_on` edge

### Logical Soundness (BLOCKING)

- [ ] No redundant tasks doing the same work
- [ ] No obvious missing tasks that would leave the goal unachievable
- [ ] No tasks with empty or stub prompts (`...`, placeholder text)

---

## Output Format

Your entire response must be a single fenced JSON block — no text before or after:

```json
{
  "valid": true
}
```

Or if any check fails:

```json
{
  "valid": false,
  "issues": [
    "[Section name]: [Specific problem] — Fix: [What to change]"
  ]
}
```

List only real failures in `issues`. Do not list items that passed.
