---
name: memory-merger
description: "Reviews mature LESSONS-LEARNED.md entries, rewrites them as permanent rules in skill/instruction files, archives graduated lessons. Use when graduating lessons into skills, promoting validated lessons, updating skills from past learnings, archiving mature lessons, codifying repeated patterns, or cleaning up a crowded LESSONS-LEARNED.md."
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
2. Map each candidate to target file, section.
3. Draft exact edit (concise rule or example).
4. Apply edit with attribution comment.
5. Archive migrated lesson in LESSONS-LEARNED.md with merge note.
6. Update index; run validation checks.

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

### Worked Example: LES-042 — MCP Tool Timeout

**Source lesson** (cited 4×, severity high, 90 days old):
> LES-042: MCP tool timeout causes silent failures — set explicit timeout, check return value

**Draft:**
```
Lesson: LES-042 — MCP tool timeout
Target: src/orchestrator/skills/orchestration-protocols/SKILL.md
Section: Error Recovery Playbook
Edit: Add row: | **MCP timeout** | Tool returns null/undefined after delay | Set explicit timeout (30s); check return value; retry once; fall back to CLI; log to DLQ | <!-- Merged from LES-042 -->
```

**Archive in `LESSONS-LEARNED.md`:**
```markdown
### LES-042: MCP tool timeout → Merged to `src/orchestrator/skills/orchestration-protocols/SKILL.md` on 2026-05-18
```

### Automating the scan

```sh
# Find lessons cited 3+ times across sessions
rg -c "LES-[0-9]+" .opencastle/logs/events.ndjson | awk -F: '$2 >= 3 {print $1}'

# Find lessons referenced in recent retries
rg "retry.*LES-[0-9]+" .opencastle/logs/events.ndjson | rg -o "LES-[0-9]+" | sort | uniq -c | sort -rn | head -20
```

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
