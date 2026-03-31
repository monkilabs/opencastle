---
name: memory-merger
description: "Protocol for graduating mature lessons from LESSONS-LEARNED.md into permanent instruction and skill files. Use when the lessons-learned file exceeds 50 entries, individual lessons have been cited 3+ times, or lesson clusters of 5+ appear in the same category. Closes the self-improvement loop by codifying validated knowledge at the source level."
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

## Workflow

### Step 1 — Scan Candidates

Evaluate each lesson in `LESSONS-LEARNED.md` against the promotion criteria:

| Criterion | Signal |
|-----------|--------|
| Frequency | Cited/re-discovered 3+ times |
| Severity | Marked `high` |
| Age | >60 days, still relevant |
| Concentration | 5+ in same category → extract pattern |
| Tool-specific | MCP tool, codebase-tool command, or framework pattern |

**Validation checkpoint:** Confirm at least one candidate meets the threshold before proceeding.

### Step 2 — Map to Target File

Determine the correct destination for each candidate lesson:

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

**Validation checkpoint:** Verify the target file exists and the target section is appropriate before drafting.

### Step 3 — Draft Edit

Prepare a structured edit proposal for each lesson:

```
Lesson: LES-XXX — [title]
Target: [file path]
Section: [section name]
Edit: [exact text]
```

Strategies: add rule, add anti-pattern, add code example, expand existing rule, add table row.

### Step 4 — Apply & Attribute

Edit target file; add `<!-- Merged from LES-XXX -->` attribution inline.

**Example:**
```markdown
<!-- Merged from LES-042 -->
- **Always validate CMS response shape** — Contentful can return partial entries when links are unresolved.
```

### Step 5 — Archive

Move merged lessons to `## Archived (Merged)` at the bottom of `LESSONS-LEARNED.md`:

```markdown
### LES-XXX: [title] → Merged to `[target]` on YYYY-MM-DD
```

**Never delete lessons** — archive for traceability.

### Step 6 — Update Index

Update `## Index by Category` in `LESSONS-LEARNED.md` to mark archived lessons.

**Validation checkpoint:** Confirm all merged lessons are archived, all target files are updated, and the index reflects the changes.

## Quality Gates

- [ ] Merged content reads naturally (not copy-pasted)
- [ ] No duplicate rules created
- [ ] Archived lesson references target file
- [ ] Core insight preserved — no loss of nuance

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Merge too eagerly | Must meet 3+ citations or 60+ day threshold before promoting |
| Copy verbatim | Rewrite as rules/guidelines, not incident reports |
| Merge conflicting lessons | Resolve conflict first, then merge the winner |
| Create new files for merged content | Merge INTO existing files only — never create new targets |
