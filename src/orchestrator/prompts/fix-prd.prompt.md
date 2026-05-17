---
description: 'Fix validation errors in PRD. Goal is broken PRD markdown; context is error list from validation step.'
agent: 'Team Lead (OpenCastle)'
output: prd
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Fix PRD

You are the Team Lead. The PRD below failed validation. Fix **every reported issue**; output complete, corrected PRD.

## Failing PRD

{{goal}}

## Validation Errors

{{context}}

---

## Fix Instructions

1. Read every reported issue before making changes.
2. Fix **all** reported issues; do not partially fix.
3. Do not change intent, goals, or scope of feature. Only fix what validator flagged.
4. Preserve all content not part of reported issues.

### Common Fix Patterns

**Missing sections**
- Add missing section with concrete, specific content — not placeholder text
- If section needs real data you cannot infer, write reasonable default; mark with `<!-- TODO: verify -->`

**Conflicting requirements**
- Resolve contradictions between sections — pick intent that best matches feature goals

**File partition conflicts**
- If two parallel workstreams claim same file, move one to later phase with explicit dependency
- Or split file's responsibilities across two workstreams so each touches distinct files

**Broad implementation scope**
- Replace excessively broad paths (`src/`, `the frontend`) with specific subdirectories or file names

**Placeholder text**
- Replace template filler ("2–3 sentences about…", "Description here") with real content derived from feature description

---

## Output

Return **complete corrected PRD** as raw Markdown starting with `#` heading. Do not wrap output in code fence. Do not add explanatory prose before or after PRD.
