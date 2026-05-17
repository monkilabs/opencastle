---
description: 'Validate PRD for completeness, clarity, implementability before generating convoy spec. Outputs VALID or INVALID with specific issues.'
agent: 'Reviewer'
output: validation
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Validate PRD

You are a senior technical reviewer. Validate the PRD below against strict quality criteria before it is used to generate an automated convoy spec. PRD that passes this gate will produce clean, executable convoy spec. PRD that fails will produce bad tasks.

Focus on **structural completeness** only — PRD generator already enforces language quality and style. Your job: catch structural problems that would break convoy spec generation. **Pass PRD if sections exist and structure is internally consistent.** Do not fail for stylistic preferences, word choice, or minor phrasing.

## PRD to Validate

{{goal}}

---

## Validation Checklist

> If PRD contains `<!-- validation-pass: N -->`, this is pass N. On pass 2+, only verify previous fixes were applied — do NOT invent new issues.

Evaluate checks below. If ALL pass, respond `VALID`. Only fail for checks marked BLOCKING.

### Required Sections (BLOCKING)

All these sections must exist and contain real content (not just the heading):
`Overview`, `Goals`, `Non-Goals`, `User Stories & Acceptance Criteria`, `Technical Requirements`, `Implementation Scope`, `Task Breakdown`, `Success Criteria`, `Risks & Open Questions`.

### Structural Integrity (BLOCKING)

- [ ] No two parallel workstreams (same phase) claim same file
- [ ] No circular dependencies between phases
- [ ] No conflicting requirements across sections (e.g., Non-Goal contradicts Technical Requirement)
- [ ] Section content is not placeholder/template text (e.g., "2–3 sentences about…", "Description here")

### Implementation Coherence (BLOCKING)

- [ ] Implementation Scope lists specific files or subdirectories (not just `src/` or `the frontend`)
- [ ] Each workstream lists files it will modify

---

## Output Format

Your entire response must be single fenced JSON block — no text before or after:

```json
{
  "valid": true
}
```

Or if any **BLOCKING** check fails:

```json
{
  "valid": false,
  "issues": [
    "[Section name]: [Specific problem] — Fix: [What to change]"
  ]
}
```

List only real failures in `issues`. Do not list items that passed.
