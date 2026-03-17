---
name: agent-hooks
description: "Lifecycle hooks for AI agent sessions — reusable actions that run at specific points (session start, session end, pre-delegation, post-delegation). Defines what to do at each lifecycle event so agents behave consistently."
---

# Agent Lifecycle Hooks

Conventions (not auto-triggers) agents execute at specific lifecycle points. Team Lead includes hook reminders in delegation prompts; specialists follow them in their own workflow.

```
on-session-start → [work loop] → on-session-end
                        ↓   ↑
               on-pre-delegate → on-post-delegate
```

---

## on-session-start — First action in any session

| # | Action | Detail |
|---|--------|--------|
| 1 | Read lessons | Scan `.opencastle/LESSONS-LEARNED.md` for task-relevant entries. |
| 2 | Check checkpoint | If `.opencastle/SESSION-CHECKPOINT.md` exists, resume from it. |
| 3 | Check pending approvals | If checkpoint has `## Pending Approvals`, check replies via messaging provider (`stack.teamTools` in `.opencastle.json`). Skip if no messaging configured. |
| 4 | Check DLQ | Scan `.opencastle/AGENT-FAILURES.md` for failures in current scope. |
| 5 | Validate skill-matrix | Open `.opencastle/agents/skill-matrix.json` — if all `bindings` entries are empty, **warn** user to run *"Bootstrap Customizations"* prompt first. |
| 6 | Check project context | If `.opencastle/project.instructions.md` has only empty template rows, warn bootstrap hasn't run. |
| 7 | Load domain skills | Load appropriate skills before writing code. |

**Delegation reminder:**
```
Session Start: Read `.opencastle/LESSONS-LEARNED.md`. Check `.opencastle/SESSION-CHECKPOINT.md` for prior state and pending approvals. Validate `.opencastle/agents/skill-matrix.json` — warn if bindings empty. Load relevant skills before coding.
```

---

## on-session-end — Before yielding control, every time unconditionally

> **⛔ HARD GATE** — See [logging-mandatory](../../snippets/logging-mandatory.md). Run the Pre-Response Quality Gate from the **observability-logging** skill.

| # | Action | Who |
|---|--------|-----|
| 1 | Call Session Guard with session summary; execute fix commands it returns | Team Lead only |
| 2 | Run Pre-Response Quality Gate checklist from **observability-logging** skill | Specialists only |
| 3 | Write `.opencastle/SESSION-CHECKPOINT.md` if work is incomplete (load **session-checkpoints** skill) | Team Lead only |
| 4 | Flag for memory merge if 5+ new lessons this session | All |
| 5 | Remove temp files created during session | All |

**Delegation reminder (specialists):**
```
Session End: Log session via observability-logging skill (Constitution rule #6). Add lesson via self-improvement if retried. Track discovered issues in KNOWN-ISSUES.md or tracker. Clean up temp files.
```

---

## on-pre-delegate — Team Lead only, before every delegation

Run the 5-point Pre-Delegation Checks from the Team Lead agent file: (1) Tracker issue exists, (2) File partition clean, (3) Dependencies verified Done, (4) Prompt has file paths + acceptance criteria, (5) Self-improvement reminder included. For 5+ files, generate a context map.

## on-post-delegate — Team Lead only, after receiving delegation results

| # | Action |
|---|--------|
| 0 | **⛔ Log delegation** via observability-logging skill — BLOCKING |
| 1 | **Fast review (mandatory)** — run `fast-review` skill; **⛔ log review** — BLOCKING. Escalate to panel if needed; **⛔ log panel** — BLOCKING |
| 2 | Read changed files; verify within file partition |
| 3 | Run lint, type-check, tests |
| 4 | Verify each acceptance criterion against tracker issue |
| 5 | Confirm Discovered Issues Policy followed (KNOWN-ISSUES.md or tracker ticket) |
| 6 | If agent retried, verify lesson added via **self-improvement** skill |
| 7 | Move issue to Done or re-delegate; on 3rd failure → log to `.opencastle/AGENT-FAILURES.md` |
| 8 | Update `.opencastle/AGENT-EXPERTISE.md` (strong/weak area + file familiarity) |
| 9 | Append file relationships to `.opencastle/KNOWLEDGE-GRAPH.md` |

**Quick checklist:**
```
☐ ⛔ Delegation logged (verify: tail -1 events.ndjson) — BLOCKING
☐ Changed files reviewed; within partition
☐ Lint/test/build passes
☐ Fast review PASS; ⛔ Review logged — BLOCKING
☐ ⛔ Panel logged if escalated — BLOCKING
☐ Acceptance criteria met
☐ Discovered issues tracked
☐ Lessons captured (if retries)
☐ Issue updated
☐ AGENT-EXPERTISE.md updated
☐ KNOWLEDGE-GRAPH.md appended
```

---

## Anti-Patterns

| Anti-pattern | Why it matters |
|---|---|
| Skipping on-session-start | Repeated mistakes already in lessons learned |
| Forgetting session logging | Observability dashboard empty; #1 most common failure |
| Treating logging as optional | Every session logged — no threshold, no exceptions |
| Batch-logging retrospectively | Log each task as it completes, not all at end |
| Partial post-delegate checks | Must verify acceptance criteria, not just "it compiled" |
| No cleanup | Temp files accumulate and confuse future sessions |
| Hooks as blockers | Hooks add ~2 min overhead — skip optional parts if needed |
