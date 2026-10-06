---
name: validation-gates
description: "The checks a change passes before it is done or merged: secrets, the project's tests, lint and build, size, new dependencies, the browser for UI, review, regression and a smoke test. Use when deciding which checks a change needs, or whether work is ready to merge or deploy."
---

# Validation Gates

Every command here is the project's own: Key Commands in `.opencastle/project.instructions.md`, or the task runner's skill (Nx, Turborepo). Never a guessed `npm run …`. Run them in this order; when one fails, fix it and start again.

1. **Secrets.** No token, key, password or connection string in the diff, the logs or the output. With gitleaks installed: `gitleaks git --redact --log-opts="main..HEAD"` for the branch's commits, `gitleaks dir <path>` for files not yet committed. Without it, read the diff for keys (`AKIA…`, `sk-…`, `ghp_…`), private keys, connection strings and `password = "…"` assignments; fake fixtures and placeholders are not hits. A real secret that was committed must be rotated: git history keeps it.
2. **Tests, lint, build** for every project the change touches, with zero errors. Lint with auto-fix first.
3. **Size.** Over 500 changed lines, 10 files or 2 projects: stop and check the change has not drifted beyond its task, and split it if it can be split.
4. **New dependencies** — when a manifest or lockfile changed: the package manager's audit at high severity (`npm audit --audit-level=high`, `pnpm audit`, `pip-audit`) finds nothing new, and the package is maintained, its licence fits, and it does not duplicate one already used ([REFERENCE.md](REFERENCE.md) has the commands).
5. **Browser** — UI changes only: it works in a browser at every breakpoint the project uses, with no console errors (**browser-testing**). A stale page, or a build that lists deleted files: clear the framework's cache and rebuild first.
6. **Review** — **fast-review**; **panel-majority-vote** for auth, payments, migrations or deleting data.
7. **Regression** — the whole test suite of every project that uses what changed, not only the tests you touched.
8. **Smoke test** — when a feature is complete: walk its main path end to end, from a clean build, as a user would.
