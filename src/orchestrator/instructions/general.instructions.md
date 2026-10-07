---
applyTo: '**'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Coding Standards

The project's own instructions win: the Project Context loaded with these, the rest of `.opencastle/`, and the project's rules outside OpenCastle's managed files.

- **Use the project's commands.** Key Commands in the Project Context, through its task runner (Nx, Turborepo) when it has one. Before you call a change done, run its tests, lint and build; check a UI change in a browser when the project has a UI (**browser-testing**).
- **Load the skill for the domain** before writing code in it — the Project Context's Domain Quick Reference names it. Write or update the tests with the change (**testing-workflow**).
- **Stay in scope.** Change what the task needs. A bug you notice outside it: name it with its file and line in your answer; do not fix it unasked. A limitation you cannot fix (upstream, the platform): add it to `.opencastle/KNOWN-ISSUES.md`.
- **Never expose secrets** — no tokens, keys or passwords in code, logs, commits or output. Use environment variables.
- **Fail visibly** — surface errors; never swallow an exception.
- **Comments say why**, not what.
- **Git.** Never push to `main`: every change goes through a branch and a pull request (**git-workflow**).
- **Memory: the team's or the user's.** Read `.opencastle/LESSONS-LEARNED.md` before you start, and open the lessons that match your task. What you confirm that is true for anyone working in this repository, record as a lesson the moment you confirm it: a fix after a failure, a convention or decision the code does not show, a tool's or service's quirk, a correction the user gives about the code (**self-improvement**). What is about the user (their preferences, role, habits, machine) stays in your own memory. Never both.

<!-- End of Coding Standards -->
