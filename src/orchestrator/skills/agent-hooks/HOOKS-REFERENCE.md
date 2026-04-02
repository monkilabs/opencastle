> Parent: [SKILL.md](./SKILL.md)

# Agent Hooks — Detailed Reference

## on-session-start (extended checks)

| # | Action |
|---|--------|
| 1 | `rg -n "keyword" .opencastle/LESSONS-LEARNED.md` |
| 2 | `cat .opencastle/SESSION-CHECKPOINT.md` |
| 3 | `rg -n "Pending Approvals" .opencastle/SESSION-CHECKPOINT.md || true` |
| 4 | `rg -n "ERROR\|FAIL" .opencastle/AGENT-FAILURES.md || true` |
| 5 | `jq '.bindings' .opencastle/agents/skill-matrix.json` — verify bindings present |
| 6 | Load domain skills before writing code |

## on-pre-delegate (example commands)

| # | Check | Example Command |
|---|-------|-----------------|
| 1 | Tracker issue | `gh issue view TAS-123 || gh issue create --title "TAS-123" --body "AC: ..."` |
| 2 | File partition | `rg -n "path:" prompts/* | cut -d: -f2 | sort | uniq -d` |
| 3 | Upstream deps | Verify upstream tasks are marked Done in tracker |
| 4 | Paths + AC | Include exact file paths (not globs) and acceptance criteria in prompt |
| 5 | Self-improvement | Add `Read .opencastle/LESSONS-LEARNED.md` to prompt text |
| 6 | Context map | `opencastle context-map` — load **context-map** skill for 5+ files |

Log delegation: `opencastle log --type=delegation --issue=TAS-123 --status=started --details "spawned subagent for feature X"`

## on-post-delegate (detailed verification)

| # | Action | Command |
|---|--------|---------|
| 1 | Log completion | `opencastle log --type=delegation --issue=TAS-XX --status=complete` |
| 2 | Fast review | `opencastle log --type=review --issue=TAS-XX --verdict=PASS` |
| 3 | CI checks | `pnpm lint && pnpm typecheck && pnpm test` |
| 4 | Verify ACs | Check each acceptance criterion against tracker issue |
| 5 | Track issues | `rg -n "Discovered issue" KNOWN-ISSUES.md || gh issue create` |
| 6 | Lesson check | If agent retried, verify lesson added via **self-improvement** |
| 7 | Close/retry | `gh issue edit TAS-XX --state done` or re-delegate; 3rd failure → `.opencastle/AGENT-FAILURES.md` |

## on-session-end (detailed)

| # | Action | Who |
|---|--------|-----|
| 1 | `opencastle doctor --fix` | Team Lead |
| 2 | `opencastle log --type session ...` | All |
| 3 | Write `.opencastle/SESSION-CHECKPOINT.md` if incomplete | Team Lead |
| 4 | `rg -c "^Lesson:" .opencastle/LESSONS-LEARNED.md` — flag merge if ≥5 | All |
