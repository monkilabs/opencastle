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

- **Clean Code**: Prioritize readability, maintainability, reusability
- **Self-documenting Code**: Comment WHY, not WHAT — for detailed patterns, load the **code-commenting** skill
- **TypeScript First**: All code in TypeScript with proper types — never `as any`
- **DRY**: Extract reusable logic into functions, custom hooks, or components
- **Feature Grouping**: Co-locate code that changes together; avoid barrel files
- **Shared Code**: Place reusable UI components and data queries in shared libraries

## Technology Standards

Load the corresponding skill for detailed conventions before writing code in that domain. These are **not optional**. See `.opencastle/agents/skill-matrix.json` for the full domain-to-skill mapping.

| Domain | Skill |
|--------|-------|
| UI Components | **ui-library** (via skill matrix) |
| App Framework | **framework** (via skill matrix) |
| Accessibility | **accessibility-standards** |
| Performance | **performance-optimization** |
| Frontend Design | **frontend-design** |

## Task Decomposition Protocol

For multi-step work: decompose → verify each step → batch edits → build once. Stop and re-plan when execution diverges. Match verification to the change type (logic → tests; types → lint; UI → browser; build config → full build). Load the **decomposition** skill for delegation spec templates and dependency resolution.

## Testing

- **95% minimum** unit test coverage for all new code
- **Test plan before implementation**: initial state, user interactions, state transitions, edge cases, integration
- **Browser testing mandatory** for any UI change — verified at responsive breakpoints defined in `testing-config.md`
- Load the **testing-workflow** skill for test patterns and the **browser-testing** skill for E2E automation

## Build & Task Commands

Always use the project's configured task runner — never invoke test runners or linters directly. Load the **codebase-tool** skill from the skill matrix for exact commands (test, lint, build, serve, affected). Tools without task runner targets (e.g., CMS CLI, database CLI) may be invoked directly after checking the task runner config first.

## Documentation

Follow markdown formatting and documentation standards when writing docs. For templates, structure, and detailed patterns, load the **documentation-standards** skill.

## AI Optimization

See [ai-optimization.instructions.md](ai-optimization.instructions.md) for batch processing, tool efficiency, and anti-patterns.

## Project Context

For project-specific context (apps, libraries, tech stack, ports, URLs), see [project.instructions.md](../.opencastle/project.instructions.md).

## Git Workflow

**NEVER commit or push directly to the `main` branch.** All changes go through a feature/fix branch and a pull request. Load the **git-workflow** skill for branch naming, PR rules, and the Delivery Outcome checklist.

## Discovered Issues Policy

> **⛔ No issue gets ignored.** Untracked bugs discovered during work are a quality gate failure.

When you encounter a bug unrelated to the current task: check if already tracked in `KNOWN-ISSUES.md` or the task tracker. If NOT tracked, track it (known issue entry or bug ticket). Never assume a pre-existing issue is somebody else's problem. See the **git-workflow** skill for the full procedure.

## Observability Logging

> **⛔ HARD GATE — This is a blocking requirement, not a suggestion.**
> Do NOT respond to the user until you have appended the required log records.
> A session without log records is a failed session — regardless of code quality.

**Every agent MUST log every session** to `.opencastle/logs/events.ndjson`. No exceptions. No threshold. No "too small to log." Load the **observability-logging** skill for CLI commands, record schemas, and the full logging checklist.

## Self-Improvement Protocol

> **⛔ HARD GATE — Lessons are the team's collective memory. Skipping them causes repeated failures.**

1. **Before starting work:** Read `.opencastle/LESSONS-LEARNED.md` — apply relevant lessons proactively. This is NOT optional.
2. **During execution:** If you retry with a different approach and it works, use the **self-improvement** skill to add a lesson immediately.
3. **Update source files:** If the lesson reveals a gap in instruction/skill files, update those files too.

## Universal Agent Rules

These rules apply to ALL specialist agents automatically. **Do not duplicate them in individual agent files.**

1. **Never delegate** — Specialist agents complete their own work and return results. Never invoke the Team Lead or spawn sub-agents.
2. **Follow the Discovered Issues Policy** — Track any pre-existing bugs found during your work (see above).
3. **Read and update lessons** — See Self-Improvement Protocol above.
4. **Log every session** — See Observability Logging above. This is Constitution rule #6 — a blocking gate, not optional.

## Pre-Response Quality Gate

> **⛔ STOP before responding to the user.** Load the **observability-logging** skill and run its full pre-response quality gate checklist. Do not respond until every item passes. At minimum, confirm that session, delegation, and review log counts are non-zero and that no discovered issues are untracked.

## Workflow & Governance Skills

These skills provide detailed procedures. Load when their phase is reached.

| Concern | Skill |
|---------|-------|
| Branch naming, PR rules, delivery outcome, task tracking | **git-workflow** |
| Log CLI commands, record schemas, output contracts | **observability-logging** |
| Lesson writing CLI, categories, quality standards | **self-improvement** |

<!-- End of Coding Standards -->
