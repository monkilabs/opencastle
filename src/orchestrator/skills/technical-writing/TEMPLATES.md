# Document Templates

Shapes for the documents a project keeps. Write the prose in each by the rest of **technical-writing**, then run **unslop**. The project's own documents are listed under Key Documentation in `.opencastle/project.instructions.md`.

**Known issue** (`.opencastle/KNOWN-ISSUES.md`) — `### ISSUE-ID: Brief Description`, then: Status (Known Limitation | Fixed | Workaround Available), Severity (Critical | High | Medium | Low), Impact, Problem, Root Cause, Solution Options (numbered, each with pros and cons), Related Files (path — what it does).

**ADR** — `## ADR-NNN: Decision Title`, then: Date, Status (Accepted | Superseded | Deprecated), Context, Decision, Consequences, Alternatives Considered.

**Changelog** — under a `## [1.2.0] - YYYY-MM-DD` heading, group changes as Added / Changed / Fixed / Removed, one imperative line per change with its PR or issue number, most recent version first. Breaking changes lead their group.

**Roadmap entry done** — mark it complete with the date and owner, the files it changed, and the command that verified it; then move it to the Completed section with a one-line release note.

## Mermaid diagrams

One concern per diagram, at most 10–12 nodes. `flowchart TD` for pipelines, `LR` for request flows, `sequenceDiagram` for API flows, `erDiagram` for data models. Verbs on the arrows; a `%% Title: ...` line on a complex diagram.

## Check before committing

Run the project's formatter on the docs (Key Commands), and check the links:

```bash
npx markdown-link-check docs/**/*.md
```
