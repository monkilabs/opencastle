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

> Inherits: [discovered-issues-policy](../snippets/discovered-issues-policy.md)

See **git-workflow** skill for full tracking procedure.

## Observability Logging

> Inherits: [logging-mandatory](../snippets/logging-mandatory.md)

Load **observability-logging** skill for CLI commands and schemas.

## Self-Improvement Protocol

> **⛔ HARD GATE** — Read `.opencastle/LESSONS-LEARNED.md` before starting work. Add lessons via **self-improvement** skill when retries succeed.

## Universal Agent Rules

1. Never delegate (specialists complete their own work)
2. Follow Discovered Issues Policy
3. Read and update lessons
4. Log every session (Constitution rule #6)

## Pre-Response Quality Gate

> **⛔ STOP before responding.** Load **observability-logging** skill and run its pre-response checklist.

## Governance Skills

| Concern | Skill |
|---------|-------|
| Branching, PR rules, delivery, tracking | **git-workflow** |
| Log commands, schemas, output contracts | **observability-logging** |
| Lesson writing, categories, quality | **self-improvement** |

<!-- End of Coding Standards -->
