---
name: git-workflow
description: "Defines branch naming conventions, PR template requirements, commit message format, discovered-issues escalation policy, task tracking conventions. Load when committing, pushing, or opening PRs."
---

# Git Workflow & Delivery

**NEVER push directly to `main`.** All changes go through feature/fix branch → PR.

## Branch & Commit Rules

| Rule | Detail |
|------|--------|
| Branch from `main` | `git checkout -b <type>/<ticket-id>-<slug>` |
| Types | `fix`, `feat`, `chore`, `refactor`, `perf`, `docs` |
| Commit messages | Must reference issue ID — `TAS-42: Fix token refresh` |
| No force-push | Never `--force` or `--amend` on shared branches; `--force-with-lease` on personal only |
| No secrets | No tokens/keys in commits, PR descriptions, or output (rotate immediately if leaked) |

## Delivery Checklist (Every Task)

1. Branch `<type>/<ticket-id>-<slug>` from `main`
2. Atomic commits referencing issue ID
3. Push branch to origin
4. Open PR (do NOT merge) — write body to temp file first; use `--body-file`:
   ```sh
   # Write PR body to a temp file to avoid shell escaping issues
   cat > /tmp/pr-body.md << 'EOF'
   Resolves TAS-XX
   
   ## Changes
   - ...
   EOF
   GH_PAGER=cat gh pr create --base main --title "TAS-XX: Short description" --body-file /tmp/pr-body.md
   ```
   **Never use inline `--body` with markdown/backticks/special chars** — breaks in zsh heredocs, quoted strings.
5. Update issue with PR URL

## Discovered Issues Policy

**No issue gets ignored.** An untracked bug found during work is a quality-gate
failure. Search `.opencastle/KNOWN-ISSUES.md` and the tracker first; if it is not
tracked, either add it to KNOWN-ISSUES.md with all six fields (Issue ID, Status,
Severity, Evidence, Root Cause, Solution Options) when it is an upstream
limitation, or open a `bug` ticket with symptoms, repro steps, and affected files
when it is fixable.

## Task Tracking

Tracked in the **task tracker** (`tracker-config.md`). Team Lead creates/updates issues via MCP. Load **task-management** skill for conventions.

**If MCP tools unavailable:** Document planned issues (title + AC) in output; use `"N/A"` (no tracker) or `"TAS-PENDING"` (tracker configured); proceed with work; update IDs when available.
