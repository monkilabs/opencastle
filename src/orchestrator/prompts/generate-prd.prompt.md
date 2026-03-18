---
description: 'Generate a Product Requirements Document from a high-level feature prompt. Output feeds directly into the generate-convoy step.'
agent: 'Team Lead (OpenCastle)'
output: prd
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Generate PRD

You are the Team Lead. Convert the feature request below into a structured Product Requirements Document (PRD). The PRD will be consumed by the `generate-convoy` step to produce an automated agent task spec, so every section must be **concrete**, **specific**, and **implementation-ready**.

> **⚠ QUALITY GATE:** This PRD goes through automated validation. Getting it right on the first attempt is critical — every fix cycle costs a full LLM round-trip. Follow ALL rules below precisely. The self-validation checklist at the end is mandatory.

## Feature Request

{{goal}}

## Additional Context

{{context}}

---

## Research Before Writing

If the feature request involves a specific person, place, organization, topic, or any real-world subject:

1. **Search the internet first** if web search or fetch tools are available (e.g. `fetch_webpage`, web search MCP, or similar). Use the search results to gather accurate facts, names, dates, descriptions, and other details.
2. **If web search tools are unavailable or return no useful results**, you may use your training knowledge — but clearly mark any such content with:
   > ℹ️ Content based on training data — verify before launch.
3. **Never fabricate or hallucinate content.** If you genuinely have no knowledge about a real-world subject and cannot search, state what is unknown and use placeholder text. This applies to all content: bios, descriptions, histories, statistics, quotes, and any factual claims.

## Output Rules

**CRITICAL:** Return the PRD as your text response. Do NOT create any files. Do NOT use file-writing tools. Simply output the full PRD document as text. Do not wrap it in a code fence — start directly with the `#` heading. Do not summarize — output the complete document.

## Required PRD Structure

Produce the PRD in Markdown using **exactly** the sections below. Do not skip or merge sections.

---

# [Feature Name] — PRD

## Overview

2–3 sentences: what this feature does, who benefits, and why it matters now.

## Goals

Numbered list of specific, measurable outcomes this feature must achieve. Each goal should be a single sentence with a clear success condition.

1. …
2. …

## Non-Goals

Explicit exclusions — what this work does **not** cover. If nothing is excluded, write "None."

## User Stories & Acceptance Criteria

For each primary scenario, write a user story + binary acceptance criteria. Criteria must be testable (pass/fail — no subjective language).

**Quality rules for acceptance criteria (the validator WILL reject violations):**
- Every criterion must be evaluable as deterministic pass/fail — no subjective language ("looks good", "feels responsive", "is clean", "visually distinct")
- Do NOT use modal verbs that imply optionality: "should", "might", "could", "may"
- Do NOT use vague qualifiers: "or equivalent", "or similar", "as needed"
- State exact expected values (e.g., exact heading text, exact attribute names)

**US-1: [Short title]**
As a [user type], I want [action] so that [benefit].

Acceptance criteria:
- [ ] [Specific, testable condition]
- [ ] [Another condition]

*(Repeat for each user story)*

## Technical Requirements

Specific technical constraints the implementation must respect:
- Libraries, framework versions to use or avoid
- API contracts or interfaces that must not break
- Performance thresholds (e.g., "<200 ms p95 latency")
- Security requirements
- Browser/platform compatibility

## Implementation Scope

List **every file and directory** that will be created, modified, or deleted. Use specific paths — not broad paths like `src/`. Group by concern. Use compact file lists — group related files with commas instead of separate rows when they share a concern. Do NOT use glob patterns (`*`, `**`). Every concern must list at least one specific file.

| Concern | Files / Directories |
|---------|---------------------|
| [Frontend components] | `components/feature/`, `app/feature/page.tsx` |
| [API routes] | `app/api/feature/route.ts` |
| [Database] | `db/migrations/add_feature.sql`, `db/schema.ts` |
| [Shared types] | `types/feature.ts` |
| [Tests] | `__tests__/feature.test.ts`, `e2e/feature.spec.ts` |
| [Config / env] | `.env.example` |

**File partition rules (important for parallel execution):**
- No two concurrent workstreams may modify the same file
- If two workstreams need the same file, they must be sequenced (Phase N+1 after Phase N)

## Task Breakdown

Decompose into the minimum number of phases. Tasks in the same phase run in parallel and **must not share any files**.

Keep task descriptions **brief** — 1 sentence each. List only file paths, not explanations. Prefer compact formatting.

**Quality rules (the validator WILL reject violations):**
- Each workstream must list exact files it will modify
- No two parallel workstreams (same phase) may claim the same file
- Phases must have explicit dependency declarations (`depends on: Phase N`)
- No circular dependencies

```
Phase 1 — Foundation (parallel, no dependencies):
  - [Workstream A title]: [2-sentence description]
    Files: [list exact files]
  - [Workstream B title]: [2-sentence description]
    Files: [list exact files]

Phase 2 — Integration (depends on Phase 1):
  - [Workstream C title]: [2-sentence description]
    Files: [list exact files]
    Depends on: Phase 1

Phase 3 — Verification (depends on Phase 2):
  - [Tests]: Run full test suite, achieve ≥ 95% coverage on new files
  - [Documentation]: Update READMEs and changelogs
```

## Success Criteria

Measurable, binary checks that confirm the feature is shippable:
- [ ] All acceptance criteria in User Stories & Acceptance Criteria pass
- [ ] TypeScript compiles with zero errors
- [ ] Lint passes with zero warnings
- [ ] Unit test coverage ≥ 95% on all new/changed files
- [ ] [Feature-specific checks]

## Risks & Open Questions

- **[Risk title]**: [Description of the risk] — *Mitigation: [How to handle it]*
- **[Open question]**: [What needs to be decided before implementation can start]

If there are no risks or open questions, write "None identified."

---

## Self-Validation Checklist (MANDATORY)

Before outputting the PRD, verify **every item** below. The downstream validator will reject your PRD if any of the blocking checks fail — fix them now to avoid expensive retry cycles.

### Structural Integrity

- [ ] **No conflicting requirements**: Technical Requirements, Non-Goals, Risks & Open Questions, and User Stories must not contradict each other.
- [ ] **No duplicate open questions**: If a question is already answered elsewhere, do not re-open it in Risks & Open Questions.
- [ ] **No circular dependencies**: Phase dependency graph is acyclic.
- [ ] **No placeholder text**: Every section has real content, not template filler ("2–3 sentences about…", "Description here").

### Implementation Coherence

- [ ] **File completeness**: Every file mentioned in User Story acceptance criteria or Technical Requirements appears in the Implementation Scope table AND in the Task Breakdown file lists.
- [ ] **No file partition conflicts**: No two parallel workstreams (same phase) claim the same file.
- [ ] **Every workstream lists files**: Including verification-only workstreams — add "Files: none — verification only" if no artifacts are produced.
- [ ] **No orphan files**: Every file in the Implementation Scope table is assigned to exactly one workstream in Task Breakdown.
- [ ] **Scope specificity**: Implementation Scope uses specific subdirectory or file paths — not just `src/` or `the frontend`.

### Language Quality

- [ ] **Testable acceptance criteria**: Every criterion is evaluable as deterministic pass/fail — no subjective language ("looks good", "feels responsive").
- [ ] **No optional modals in criteria**: Acceptance criteria do not use "should", "might", "could", "may" — use "must" or "will".
- [ ] **Domain acronyms expanded**: Non-standard acronyms are expanded on first use (standard ones like API, CLI, JSON, REST, etc. are fine).
