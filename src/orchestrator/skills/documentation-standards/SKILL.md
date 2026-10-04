---
name: documentation-standards
description: "Templates for issue docs, ADRs, roadmap entries, changelogs and Mermaid diagrams. Use when drafting an ADR, a changelog entry or a known-issue doc, updating the roadmap after a feature ships, or diagramming a system."
---

# Documentation Standards

The project's own documents are listed under Key Documentation in `.opencastle/project.instructions.md`.

## Templates

Write the prose in each by the **technical-writing** and **unslop** skills.

**Issue doc** — `### ISSUE-ID: Brief Description`, then: Issue ID, Status (Known Limitation | Fixed | Workaround Available), Severity (Critical | High | Medium | Low), Impact, Problem, Root Cause, Solution Options (numbered, each with Pros/Cons), Related Files (path — what it does).

**ADR** — `## ADR-NNN: Decision Title`, then: Date, Status (Accepted | Superseded | Deprecated), Context, Decision, Consequences, Alternatives Considered.

**Roadmap completion** — add a `COMPLETE` row: feature, `Completed: YYYY-MM-DD | Owner: @handle`, files changed with rationale, validation command plus exit status. Then move it to the `Completed` section with a one-line release note.

**Changelog** — under a `## [1.2.0] - YYYY-MM-DD` heading, group changes as Added / Changed / Fixed / Removed, one imperative line per change with its PR or issue number, most recent version first. Breaking changes lead their group.

## Mermaid Diagrams

One concern per diagram, max 10–12 nodes. `flowchart TD` for pipelines, `LR` for request flows, `sequenceDiagram` for API flows, `erDiagram` for data models. Verb labels on arrows; `%% Title: ...` on complex diagrams.

## Validate

Check links and formatting before committing docs. Resolve the formatter
command via the **codebase-tool** slot; the link checker is standalone:

```bash
npx markdown-link-check docs/**/*.md
```
