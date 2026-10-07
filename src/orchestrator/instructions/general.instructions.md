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
- **Memory: the team's or the user's.** The team's lessons load with these instructions (if they did not, read `.opencastle/LESSONS-LEARNED.md`); open the ones that touch your task. Save what you learn in your own memory, as you normally do: in Claude Code and VS Code, OpenCastle shares what is about the project with the team when the session ends, and leaves what is about the user. So save what is about the user (their preferences, role, habits, machine) as about the user. In any other assistant, record what you confirm about the project as a lesson (**self-improvement**).

<!-- End of Coding Standards -->
