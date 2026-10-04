---
description: 'Fix the issues a PRD review found. Goal is the PRD, context is the list of issues; answers with the whole corrected PRD.'
agent: 'Team Lead (OpenCastle)'
output: prd
pipeline: true
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Fix PRD

You are the Team Lead. The PRD at the end of this prompt failed review. Fix **every reported issue** and return the complete, corrected PRD.

## What Happens to Your Answer

When `opencastle convoy` runs this step, your answer replaces the PRD file exactly as written, and the reviewer checks it again. That happens at most twice, so fix everything in one go.

This session is read-only; answer in text.

## Fix Instructions

1. Read every reported issue before changing anything.
2. Fix **all** of them; do not fix some.
3. Do not change the feature's intent, goals or scope. Change only what the reviewer flagged.
4. Keep everything else as it was, including every section heading and each `Phase N —` line in the Task Breakdown: the planner reads them, and the work was already sized from them.

### Common Fix Patterns

**Missing sections**
- Add the section with concrete content, not placeholder text.
- If it needs facts you cannot infer, write a reasonable default and mark it `<!-- TODO: verify -->`.

**Conflicting requirements**
- Resolve the contradiction in favour of what best matches the feature's goals.

**File partition conflicts**
- If two workstreams in the same phase claim the same file, move one to a later phase and say what it depends on.
- Or split the file's responsibilities so each workstream touches different files.

**Broad implementation scope**
- Replace broad paths (`src/`, "the frontend") with specific subdirectories or files.

**Placeholder text**
- Replace template filler ("2–3 sentences about…", "Description here") with real content drawn from the feature request.

## Output

Return the **complete corrected PRD** as raw Markdown, starting with the `#` heading. No code fence, no notes before or after it.

---

## Failing PRD

{{goal}}

## Issues to Fix

{{context}}
