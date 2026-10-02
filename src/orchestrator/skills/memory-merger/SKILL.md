---
name: memory-merger
description: "Reviews mature lessons in .opencastle/lessons/, rewrites them as permanent rules in skill/instruction files, archives graduated lessons with opencastle lesson archive. Use when graduating lessons into skills, promoting validated lessons, updating skills from past learnings, archiving mature lessons, codifying repeated patterns, or cleaning up a crowded lessons index."
---

# Memory Merger


## Run Criteria

Combined signals to identify merge candidates.

| Criterion | Signal / Threshold |
|-----------|--------------------|
| Volume | More than 50 lessons in `.opencastle/lessons/` |
| Reference count | Referenced 3+ times across sessions |
| Age | >60 days and still relevant |
| Category cluster | 5+ lessons in same category |
| Severity | Marked `high` or blocking |
| Discretionary | Curator / maintainer judgement (stale file) |

## Workflow (numbered)

1. Scan `.opencastle/lessons/` for candidate lessons (frequency, severity, age — `added:` in each file).
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
# Lessons referenced 3+ times across sessions (ids are LES-NNN or YYYY-MM-DD-title)
rg -o '"lessons_added":\[[^]]*\]' .opencastle/logs/events.ndjson | rg -o '"[A-Za-z0-9-]+"' | sort | uniq -c | awk '$1 >= 3'

# Oldest lessons first — candidates once past 60 days
rg -H '^added:' .opencastle/lessons/ | sort -t'"' -k2 | head -20
```

## Quality Gates (validation checkpoints)

- [ ] No duplicate rules created in target files or other skills
- [ ] Archived lesson references target file and date
- [ ] Target file still passes lint/markdown checks (if applicable)
- [ ] Keyword search in the target file confirms the merge applied

## Anti-Patterns

- Merge too eagerly — must meet 3+ references or 60+ day threshold
- Copy verbatim — rewrite as rules/guidelines, not incident reports
- Merge conflicting lessons — resolve conflict first
- Create new files for merged content — merge INTO existing files only
