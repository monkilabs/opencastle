---
name: documentation-standards
description: "Scaffolds issue docs, ADRs, README outlines, changelog entries, roadmap updates, Mermaid architecture diagrams using project templates. Use when drafting ADR, writing changelog, updating roadmap after a feature ships, creating README for a new library, or diagramming a system flow."
---

# Documentation Standards

Project directory structure and practices: [docs-structure.md](../../.opencastle/project/docs-structure.md). Writing guidelines, formatting rules, anti-patterns: [WRITING-GUIDE.md](WRITING-GUIDE.md).

## Templates

**Issue doc** — `### ISSUE-ID: Brief Description`, then: Issue ID, Status (Known Limitation | Fixed | Workaround Available), Severity (Critical | High | Medium | Low), Impact, Problem, Root Cause, Solution Options (numbered, each with Pros/Cons), Related Files (path — what it does).

**ADR** — `## ADR-NNN: Decision Title`, then: Date, Status (Accepted | Superseded | Deprecated), Context, Decision, Consequences, Alternatives Considered.

**Roadmap completion** — add a `COMPLETE` row: feature, `Completed: YYYY-MM-DD | Owner: @handle`, files changed with rationale, validation command plus exit status. Then move it to the `Completed` section with a one-line release note.

**Changelog** — under a `## [1.2.0] — YYYY-MM-DD` heading, group by Conventional Commits type (Added / Fixed / Changed), one imperative line per change with its PR or issue number, most recent version first.

## Mermaid Diagrams

One concern per diagram, max 10–12 nodes. `flowchart TD` for pipelines, `LR` for request flows, `sequenceDiagram` for API flows, `erDiagram` for data models. Verb labels on arrows; `%% Title: ...` on complex diagrams.

## Validate

```bash
npx markdown-link-check docs/**/*.md && pnpm prettier --check "docs/**/*.md"
```
