---
name: memory-merger
description: "Reviews mature LESSONS-LEARNED.md entries, rewrites them as permanent rules in skill/instruction files, and archives graduated lessons. Use when graduating lessons into skills, promoting validated lessons, updating skills from past learnings, archiving mature lessons, codifying repeated patterns, or cleaning up a crowded LESSONS-LEARNED.md."
---

# Memory Merger


## Run Criteria

Combined signals to identify merge candidates.

| Criterion | Signal / Threshold |
|-----------|--------------------|
| File size | LESSONS-LEARNED.md > 50 entries |
| Citation count | Cited 3+ times across sessions |
| Age | >60 days and still relevant |
| Category cluster | 5+ lessons in same category |
| Severity | Marked `high` or blocking |
| Discretionary | Curator / maintainer judgement (stale file) |

## Workflow (numbered)

1. Scan LESSONS-LEARNED.md for candidate entries (frequency, severity, age).
2. Map each candidate to a target file and section.
3. Draft the exact edit (concise rule or example).
4. Apply the edit with an attribution comment.
5. Archive the migrated lesson in LESSONS-LEARNED.md with a merge note.
6. Update the index and run validation checks.

## Merge Protocol

### 3 — Draft Edit

```
Lesson: LES-XXX — [title]
Target: [file path]
Section: [section name]
Edit: [exact text]
```
Strategies: add rule, add anti-pattern, add code example, expand existing rule, add table row.

### 4 — Apply & Attribute

Edit target file; add `<!-- Merged from LES-XXX -->` attribution inline.

### 5 — Archive

Move merged lessons to `## Archived (Merged)` at the bottom of `LESSONS-LEARNED.md`:

```markdown
### LES-XXX: [title] → Merged to `[target]` on YYYY-MM-DD
```

**Never delete lessons** — archive for traceability.

### 6 — Update Index

Update `## Index by Category` in `LESSONS-LEARNED.md` to mark archived lessons.

### Worked Example

See [REFERENCE.md](./REFERENCE.md) for a full worked merge example (LES-042: MCP tool timeout).

## Quality Gates (validation checkpoints)

- [ ] Merged content reads naturally (not copy-pasted)
- [ ] No duplicate rules created in target files or other skills
- [ ] Archived lesson references target file and date
- [ ] Core insight preserved — no loss of nuance
- [ ] Target file still passes lint/markdown checks (if applicable)
- [ ] A quick smoke verification (search for relevant keyword) confirms merge applied

## Anti-Patterns

- Merge too eagerly — must meet 3+ citations or 60+ day threshold
- Copy verbatim — rewrite as rules/guidelines, not incident reports
- Merge conflicting lessons — resolve conflict first
- Create new files for merged content — merge INTO existing files only
