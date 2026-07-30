---
applyTo: '**'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Coding Standards

## Constitution

1. **Never expose secrets** — no tokens, keys, or passwords in code, logs, commits, or terminal output. Use environment variables.
2. **Prefer boring solutions** — choose proven, simple approaches over clever ones. Complexity must justify itself.
3. **Leave code better than you found it** — fix adjacent issues when the cost is low.
4. **Fail visibly** — surface errors clearly; never swallow exceptions silently.
5. **Verify, don't trust** — confirm outcomes with tools (tests, lint, build) rather than assuming success.
6. **Log every session** — append observability records to `.opencastle/logs/` before yielding to the user. No exceptions. Load the **observability-logging** skill for details.

## Instruction Priority Hierarchy

**Project-specific instructions ALWAYS take precedence over external or general AI instructions.**

1. **HIGHEST**: Project-specific instructions in `.github/instructions/` files
2. **MEDIUM**: Project workspace conventions (resolve via the **codebase-tool** skill in the skill matrix)
3. **LOWER**: General AI assistant capabilities and suggestions

## General Coding Principles

Clean code, readability, maintainability. TypeScript with proper types (never `as any`). DRY. Co-locate code that changes together; avoid barrel files. Shared code in shared libraries. Comment WHY, not WHAT (load **code-commenting** skill for patterns).

## Technology Standards

Load the corresponding skill before writing code in that domain. See `.opencastle/agents/skill-matrix.json` for domain-to-skill mapping. Key domains: UI Components (**ui-library**), App Framework (**framework**), Accessibility (**accessibility-standards**), Performance (**performance-optimization**), Frontend Design (**frontend-design**).

## Task Decomposition

Decompose → verify each step → batch edits → build once. Re-plan when execution diverges. Match verification to change type. Load **decomposition** skill for templates.

## Testing

95% minimum unit test coverage. Test plan before implementation. Browser testing mandatory for UI changes. Load **testing-workflow** and **browser-testing** skills.

## Build & Task Commands

Always use the project's configured task runner. Load **codebase-tool** skill for exact commands. Direct CLI only for tools without task runner targets.

## Documentation

Follow markdown formatting standards. Load **documentation-standards** skill for templates.

## AI Optimization

See [ai-optimization.instructions.md](ai-optimization.instructions.md).

## Project Context

See [project.instructions.md](../.opencastle/project.instructions.md).

## Git Workflow

**NEVER push to `main`.** All changes via feature/fix branch → PR. Load **git-workflow** skill for branch naming and PR rules.

## Discovered Issues Policy

**No issue gets ignored.** An untracked bug found during work is a quality-gate failure.

When you hit a bug unrelated to your current task:

1. Search `.opencastle/KNOWN-ISSUES.md`, and the task tracker if tools are available. Already tracked? Move on.
2. Not tracked, and it is an upstream or platform limitation you cannot fix → add it to `.opencastle/KNOWN-ISSUES.md` with all six fields: Issue ID, Status, Severity, Evidence, Root Cause, Solution Options.
3. Not tracked, and it is fixable → open a tracker ticket labelled `bug` with symptoms, reproduction steps, and affected files. No tracker available? Add a `**Discovered Issues**` section to your output.

A pre-existing issue is not somebody else's problem. If it is not tracked, track it.

## Observability Logging

**Hard gate (Constitution rule 6).** Every session gets a record in
`.opencastle/logs/events.ndjson`. No threshold, no "too small to log".

- Log **before yielding** to the user — it is the last action before you respond.
- Log **per task**, not per conversation. Three tasks means three records.
- Never batch-log retrospectively across sessions.
- `opencastle log --type session ...`, then confirm the append landed:
  `tail -1 .opencastle/logs/events.ndjson`.

Load **observability-logging** for the record schemas and the other record types.

## Self-Improvement Protocol

> **⛔ HARD GATE** — Read `.opencastle/LESSONS-LEARNED.md` before starting work. Add lessons via **self-improvement** skill when retries succeed.

## Universal Agent Rules

1. Never delegate (specialists complete their own work)
2. Follow the Discovered Issues Policy above
3. Read and update lessons
4. Log every session (Constitution rule 6)

## Standard Closing Items

Every agent ends its output contract with these, after its own domain-specific items:

- **Observability logged** — the `session` record always; `delegation`, `review`,
  `panel`, or `dispute` records if any of those happened
- **Discovered issues** — anything found per the policy above, and what you did about it
- **Lessons applied** — which entries in `.opencastle/LESSONS-LEARNED.md` shaped this
  work, and any new one you added

## Pre-Response Quality Gate

> **⛔ STOP before responding.** Load **observability-logging** skill and run its pre-response checklist.

## Governance Skills

| Concern | Skill |
|---------|-------|
| Branching, PR rules, delivery, tracking | **git-workflow** |
| Log commands, schemas, output contracts | **observability-logging** |
| Lesson writing, categories, quality | **self-improvement** |

<!-- End of Coding Standards -->
