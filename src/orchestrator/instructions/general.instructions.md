---
applyTo: '**'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Coding Standards

## Constitution

1. **Never expose secrets** — no tokens, keys, or passwords in code, logs, commits, or terminal output. Use environment variables.
2. **Prefer boring solutions** — proven, simple approaches over clever ones. Complexity must justify itself.
3. **Leave code better than you found it** — fix adjacent issues when the cost is low.
4. **Fail visibly** — surface errors; never swallow exceptions silently.
5. **Verify, don't trust** — confirm outcomes with the project's own tests, lint and build rather than assuming success.
6. **Log every session** — see Every session, below.

## Precedence

The project's own instructions win: the Project Context loaded with these, the rest of `.opencastle/`, and the project's rules outside OpenCastle's managed files. Then these standards. Then general habits.

## Working here

- **Commands.** Run the project's own commands — Key Commands in the Project Context — and go through its task runner (Nx, Turborepo) when it has one.
- **Domains.** Before writing code in a domain, load the skill for it: the Project Context's Domain Quick Reference maps domains to skills, and `.opencastle/agents/skill-matrix.json` maps each agent's capability slots. A slot with no skill bound means the project has nothing special there.
- **Tests.** Write the test with the change and meet the coverage the project's test config requires (**testing-workflow**). Check UI changes in a browser when the project has a UI (**browser-testing**).
- **Plans.** Decompose → verify each step → batch edits → build once; re-plan when execution diverges (**decomposition**).
- **Comments** say why, not what (**code-commenting**). Documents follow **documentation-standards**.
- **Git.** **Never push to `main`.** Every change goes through a branch and a pull request (**git-workflow**).

## Discovered Issues Policy

**No issue gets ignored.** When you hit a bug unrelated to your task:

1. Search `.opencastle/KNOWN-ISSUES.md`, and the task tracker if tools are available. Already tracked? Move on.
2. An upstream or platform limitation you cannot fix → add it to `.opencastle/KNOWN-ISSUES.md` with Issue ID, Status, Severity, Evidence, Root Cause, Solution Options.
3. Fixable → open a tracker ticket labelled `bug` with symptoms, reproduction steps and affected files; with no tracker, add a **Discovered Issues** section to your output.

## Every session

- **Before starting:** read `.opencastle/LESSONS-LEARNED.md` and the lessons that match your task.
- **Before responding:** log the session with `opencastle log --type session …`, one record per task, never batched afterwards; add `delegation`, `review`, `panel` or `dispute` records when those happened. **observability-logging** has the fields.
- **When a retry taught you something,** add a lesson (**self-improvement**).
- **Specialists finish their own work;** only the Team Lead delegates.
- **End your output** with what you logged, the issues you discovered and what you did about them, and the lessons you applied or added.

<!-- End of Coding Standards -->
