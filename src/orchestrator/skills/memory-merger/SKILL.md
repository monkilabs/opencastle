---
name: memory-merger
description: "Protocol for graduating mature lessons from LESSONS-LEARNED.md into permanent instruction and skill files. Closes the self-improvement loop by codifying validated knowledge at the source level."
---

# Memory Merger

Promotes validated lessons from `.opencastle/LESSONS-LEARNED.md` into instruction/skill files where they have permanent impact.

## When to Run

| Trigger | Threshold |
|---------|-----------|
| File size | >50 entries |
| Citation count | Cited 3+ times |
| Age | >60 days old |
| Category cluster | 5+ lessons in same category |
| Discretionary | Lessons file feels stale |

## Merge Protocol

### 1 — Scan Candidates

| Criterion | Signal |
|-----------|--------|
| Frequency | Cited/re-discovered 3+ times |
| Severity | Marked `high` |
| Age | >60 days, still relevant |
| Concentration | 5+ in same category → extract pattern |
| Tool-specific | MCP tool, codebase-tool command, or framework pattern |

### 2 — Map to Target File

| Category | Target |
|----------|--------|
| `task-management` | skill-matrix `task-management` slot |
| `mcp-tools` | agent/skill that uses the tool |
| `codebase-tool` | skill-matrix `codebase-tool` slot |
| `cms` / `database` | respective skill-matrix slots |
| `browser-testing` | skill-matrix `e2e-testing` slot |
| `git-workflow` | `.github/skills/git-workflow/SKILL.md` |
| `deployment` | `.github/skills/deployment-infrastructure/SKILL.md` |
| `delegation` | `.github/agents/team-lead.agent.md` or `team-lead-reference` skill |
| `testing` | `.github/skills/testing-workflow/SKILL.md` |
| `ui` / `framework` | `framework` slot or `react-development` skill |
| Cross-cutting | `.github/instructions/general.instructions.md` |

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

## Quality Gates

- [ ] Merged content reads naturally (not copy-pasted)
- [ ] No duplicate rules created
- [ ] Archived lesson references target file
- [ ] Core insight preserved — no loss of nuance

## Anti-Patterns

- Merge too eagerly — must meet 3+ citations or 60+ day threshold
- Copy verbatim — rewrite as rules/guidelines, not incident reports
- Merge conflicting lessons — resolve conflict first
- Create new files for merged content — merge INTO existing files only
