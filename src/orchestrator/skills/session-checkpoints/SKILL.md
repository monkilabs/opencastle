---
name: session-checkpoints
description: "Protocol for saving and restoring session state across agent sessions. Use when starting a multi-phase delegation, before risky operations like DB migrations, when context is running low, or when resuming interrupted work. Enables replay, fork, and resume of interrupted work."
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

## Workflow

### Step 1 — Create Checkpoint File

Write `.opencastle/SESSION-CHECKPOINT.md` using the format below. Include all metadata fields — omitting fields causes resume failures.

```markdown
# Session Checkpoint

**Last Updated:** YYYY-MM-DD HH:MM
**Feature:** Short feature name
**Branch:** git branch name
**Tracker Issues:** TAS-XX, TAS-YY

## Current Phase
[Phase name and number]

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

Agent A: dir1/, dir2/
Agent B: dir3/

## Resume Instructions

1. Check out branch `feat/xxx`
2. Read tracker issues TAS-XX for context
3. Start Phase N+1: [specific instructions]
```

**Validation checkpoint:** Verify the checkpoint file contains all required sections and that the branch name matches the current git branch.

### Step 2 — Update on Progress

After each delegation completes or each parallel batch finishes, move tasks between the In Progress, Completed, and Remaining tables. Update the Current Phase field.

### Step 3 — Resume from Checkpoint

When starting a new session with incomplete work:

1. Read `.opencastle/SESSION-CHECKPOINT.md`
2. Run `git status` to confirm branch and working tree state
3. Check tracker for any updates made outside the agent session
4. Follow the Resume Instructions section
5. Update the checkpoint with current progress

**Validation checkpoint:** Confirm the branch exists, all referenced files are present, and the tracker state matches the checkpoint before continuing work.

### Step 4 — Cleanup

When all issues are Done:

1. Archive the checkpoint content to the tracker
2. Delete `.opencastle/SESSION-CHECKPOINT.md`

## Integration Points

- Checkpoint after decomposition (Step 2 of Decomposition Flow)
- Update after each verification pass
- Reference checkpoint in delegation prompts

## Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Skipping checkpoint before risky work | Always checkpoint before DB migrations, security changes, or large refactors |
| Stale checkpoint with outdated file partitions | Update partitions whenever agents are reassigned or files move |
| Resuming without checking git status | Always verify branch and working tree state match the checkpoint |
| Leaving checkpoint after feature completion | Delete the file once all tracker issues are Done |
