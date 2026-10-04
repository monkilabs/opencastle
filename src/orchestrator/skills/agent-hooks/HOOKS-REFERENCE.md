# Agent Hooks — Detailed Reference

## on-session-start (extended checks)

In addition to the four checks in SKILL.md:

| # | Action |
|---|--------|
| 5 | `rg -n "Pending Approvals" .opencastle/SESSION-CHECKPOINT.md || true` |
| 6 | `jq '.bindings' .opencastle/agents/skill-matrix.json` — verify bindings present, then load domain skills before writing code |

## on-pre-delegate (example commands)

| # | Check | Example Command |
|---|-------|-----------------|
| 1 | Tracker issue | Look it up in the tracker (its skill), or `gh issue view <number>` for GitHub Issues; create it if missing |
| 2 | File partition | `rg -n "path:" prompts/* | cut -d: -f2 | sort | uniq -d` |
| 3 | Upstream deps | Verify upstream tasks are marked Done in tracker |
| 4 | Paths + AC | Include exact file paths (not globs) and acceptance criteria in prompt |
| 5 | Self-improvement | Add `Read .opencastle/LESSONS-LEARNED.md` to prompt text |
| 6 | Context map | Load the **context-map** skill for 5+ files |

The delegation is logged once, when it finishes (on-post-delegate) — a delegation record carries its outcome.

## on-post-delegate (detailed verification)

| # | Action | Command |
|---|--------|---------|
| 1 | Log completion | `opencastle log --type delegation …` — the delegation record in the **observability-logging** skill |
| 2 | Fast review | `opencastle log --type review …` — the review record in the **observability-logging** skill |
| 3 | CI checks | Lint, typecheck, and test (commands via the **codebase-tool** slot) |
| 4 | Verify ACs | Check each acceptance criterion against tracker issue |
| 5 | Track issues | `rg -n "Discovered issue" .opencastle/KNOWN-ISSUES.md`, else open a tracker issue |
| 6 | Lesson check | If agent retried, verify lesson added via **self-improvement** |
| 7 | Close/retry | Move the issue to Done in the project's tracker (its skill: linear/jira/trello), or `gh issue close <number>` for GitHub Issues; on FAIL follow **fast-review**'s Handle Verdict table |

## on-session-end (detailed)

| # | Action | Who |
|---|--------|-----|
| 1 | `opencastle doctor` | Team Lead |
| 2 | `opencastle log --type session ...` | All |
| 3 | Write `.opencastle/SESSION-CHECKPOINT.md` if incomplete | Team Lead |
| 4 | `ls .opencastle/lessons/ \| wc -l` — flag a memory-merger pass if more than 50 | All |
