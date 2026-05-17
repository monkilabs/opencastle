> Parent: [SKILL.md](./SKILL.md)

# Writing & Formatting Guide

## Voice & Tone

- **Imperative mood** for instructions: "Add the header" not "You should add the header"
- **Active voice**: "The function returns X" not "X is returned by the function"
- **Concise**: one idea per sentence; trim filler words (just, simply, basically, very)

## Formatting Rules

| Element | Convention |
|---------|-----------|
| Headings | Sentence case (`## Core principles`, not `## Core Principles`). Exception: proper nouns and acronyms. |
| Lists | Parallel structure — all items start with same part of speech |
| Code | Inline backticks for symbols/commands; fenced blocks for multi-line |
| Links | Descriptive text: `[migration guide](./migrate.md)` not `[click here](./migrate.md)` |
| Tables | Use for structured comparisons; keep columns ≤5 |
| Line length | Wrap prose at ~120 characters for diff readability |

## Markdown Standards

- One blank line before, after headings, code blocks, tables
- No trailing whitespace
- Files end with a single newline
- Use `---` for horizontal rules (sparingly)
- Prefer `-` for unordered lists

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Walls of prose without structure | Break into headings, bullets, or tables |
| Duplicate content across docs | Link to canonical source |
| Stale "Last Updated" dates | Remove or automate; manual dates drift |
| TODO/FIXME placeholders in published docs | Resolve before merging |
| Screenshots without alt text | Add descriptive alt text for accessibility |
| Overly nested headings (h4+) | Flatten; if you need h4, consider splitting the doc |
