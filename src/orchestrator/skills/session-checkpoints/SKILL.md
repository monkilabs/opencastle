---
name: session-checkpoints
description: "Protocol for saving and restoring session state across agent sessions. Enables replay, fork, and resume of interrupted work — inspired by Sandcastle Run Time Machine."
---

# Skill: Session Checkpoints

## When to Checkpoint

| Trigger | Action |
|---------|--------|
| Before first delegation | After decomposition, before agents start |
| After each phase | When a parallel batch completes |
| Before risky work | DB migrations, large refactors, security changes |
| Session end | Any session with incomplete work |
| Context running low | Checkpoint immediately |

## Checkpoint Format (`.opencastle/SESSION-CHECKPOINT.md`)

```markdown
# Session Checkpoint

**Last Updated:** YYYY-MM-DD HH:MM
**Feature:** Short feature name
**Branch:** git branch name
**Tracker Issues:** TAS-XX, TAS-YY

## Current Phase

## Completed Work

| Task | Tracker | Agent | Status | Files |
|------|---------|-------|--------|-------|
| Description | TAS-XX | Agent | ✅ Done | file1.ts |

## In Progress

| Task | Tracker | Agent | Status | Notes |
|------|---------|-------|--------|-------|
| Description | TAS-ZZ | Agent | 🔄 In Progress | what's done |

## Remaining Work

| Task | Tracker | Agent | Dependencies | Files |
|------|---------|-------|-------------|-------|
| Description | TAS-AA | Agent | TAS-ZZ | file4.ts |

## Pending Approvals

| Provider | Channel | Thread ID | Question | Posted At |
|----------|---------|-----------|----------|-----------|
| slack | C0AHAQFJ7C1 | 1772393542.345149 | Run migration on production? | 2026-03-01 14:30 |

Remove row once answered (VS Code chat reply also counts as resolved).

## Decisions & Blockers

- Decision: rationale
- Blocker: what's needed to unblock

## Delegation Cost Log

| # | Agent | Tracker | Model Tier | Est. Tokens | Duration | Status |
|---|-------|---------|------------|-------------|----------|--------|
| 1 | Content Engineer | TAS-XX | Standard | ~20K | 8 min | ✅ Done |

## File Partitions

```
Agent A: dir1/, dir2/
Agent B: dir3/
```

## Resume Instructions

1. Check out branch `feat/xxx`
2. Read tracker issues TAS-XX for context
3. Start Phase N+1: [specific instructions]
```

## Resuming

Read checkpoint → `git status` → check tracker → follow resume instructions → update progress.

## Cleanup & Team Lead

When all issues Done: archive to tracker, delete `.opencastle/SESSION-CHECKPOINT.md`.

- Checkpoint after decomposition (Step 2 of Decomposition Flow)
- Update after each verification pass
- Reference checkpoint in delegation prompts
