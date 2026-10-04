---
name: git-workflow
description: "Branch names, commit messages, pushing and opening a pull request, and working with the task tracker. Use when branching, committing, pushing or opening a PR."
---

# Git Workflow

**Never push to `main`.** Every change goes through a branch and a pull request, and a person merges it.

| | |
|---|---|
| Branch | From `main`: `<type>/<slug>`, or `<type>/<issue-id>-<slug>` when there is an issue. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `chore` |
| Commits | Small and atomic, with an imperative subject — the issue ID first when there is one (`TAS-42: Fix token refresh`) |
| History | Never `--force` or `--amend` on a shared branch; `--force-with-lease` on your own only |
| Secrets | None in commits, pull request bodies or output; a leaked one is rotated at once |

## Deliver

1. Commit, then push: `git push -u origin <branch>`.
2. Open the pull request with its body in a file — an inline `--body` breaks on backticks and quotes in zsh:

   ```sh
   cat > /tmp/pr-body.md << 'EOF'
   Resolves TAS-42

   ## Changes
   - ...
   EOF
   GH_PAGER=cat gh pr create --base main --title "TAS-42: Short description" --body-file /tmp/pr-body.md
   ```

3. Do not merge it. Link it from the tracker issue when there is one.

## The tracker

When the project uses one, its conventions are in `.opencastle/project/<tracker>-config.md` and the skill bound to the **task-management** slot. Without its tools in this session, list the issues you would have created — title and acceptance criteria — in your answer, and carry on.
