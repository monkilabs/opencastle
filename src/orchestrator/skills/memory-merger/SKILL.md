---
name: memory-merger
description: "Graduates mature lessons from .opencastle/lessons/ into permanent rules in skill or instruction files, then archives them. Use when the lessons index grows past 50, or a lesson has proven itself and belongs in a skill."
---

# Memory Merger


## Run Criteria

Run a pass when `.opencastle/lessons/` holds more than 50 lessons. A lesson is a merge candidate when it meets one or more of these, each checkable from its file:

| Criterion | Check |
|-----------|-------|
| Age | `added:` more than 60 days ago, and the lesson still holds |
| Valid citation | Its cited files still exist and `opencastle doctor` reports no changed citation (or `verified:` is recent) |
| Recurrence | Two or more lessons describe the same problem, or 5+ share a category |
| Severity | `severity: high`, or the lesson blocked work |

## Workflow (numbered)

1. Scan `.opencastle/lessons/` for candidate lessons by the criteria above.
2. Map each candidate to target file, section.
3. Draft exact edit (concise rule or example).
4. Apply edit with attribution comment.
5. Archive the lesson with `opencastle lesson archive`.
6. Run validation checks.

## Merge Protocol

### 3 — Draft Edit

```
Lesson: <id> — [title]
Target: [file path]
Section: [section name]
Edit: [exact text]
```
Strategies: add rule, add anti-pattern, add code example, expand existing rule, add table row.

### 4 — Apply & Attribute

Edit target file; add `<!-- Merged from <id> -->` attribution inline.

### 5 — Archive

```sh
opencastle lesson archive <id> --into <target file>
```

The lesson keeps its file, is marked archived with where it went, and moves to the index's **Archived** section — out of the list agents read before work. Never edit `LESSONS-LEARNED.md` by hand: it is rewritten from the lesson files.

**Never delete lessons** — archive for traceability.

### Automating the scan

```sh
# Oldest lessons first — candidates once past 60 days
rg -H '^added:' .opencastle/lessons/ | sort -t'"' -k2 | head -20

# Categories with 5+ lessons
rg -o --no-filename '^category: *.*' .opencastle/lessons/ | sort | uniq -c | awk '$1 >= 5'
```

## Quality Gates (validation checkpoints)

- [ ] No duplicate rules created in target files or other skills
- [ ] Archived lesson references target file and date
- [ ] Target file still passes lint/markdown checks (if applicable)
- [ ] Keyword search in the target file confirms the merge applied

## Anti-Patterns

- Merge too eagerly — a lesson younger than 60 days needs recurrence or high severity to qualify
- Copy verbatim — rewrite as rules/guidelines, not incident reports
- Merge conflicting lessons — resolve conflict first
- Create new files for merged content — merge INTO existing files only
