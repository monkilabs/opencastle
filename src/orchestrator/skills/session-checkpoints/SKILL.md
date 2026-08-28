---
name: session-checkpoints
description: "Saves, restores session state including task progress, file changes, delegation history. Use when saving progress, resuming interrupted work, picking up where you left off, or checkpointing current work."
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

Phase boundaries that warrant a checkpoint: load the **decomposition** skill.

## Creating a Checkpoint

1. Write `.opencastle/SESSION-CHECKPOINT.md` from the canonical [CHECKPOINT-TEMPLATE.md](./CHECKPOINT-TEMPLATE.md).
2. Commit it or save to workspace; attach to the tracker issue.
3. Verify: `cat .opencastle/SESSION-CHECKPOINT.md`; confirm listed files exist.

## Resuming

1. Read `.opencastle/SESSION-CHECKPOINT.md`
2. Run `git status`, `git branch` — confirm you are on correct branch
3. Check In Progress tasks — if stale (>1 session old), verify files match expected state
4. Check Pending Approvals — remove rows for questions the user has since answered in chat
5. Read tracker issues for tasks marked In Progress or Todo
6. Follow Resume Instructions section in checkpoint
7. Update checkpoint progress after each completed task

**If checkpoint missing or corrupt:** Rebuild from `git log --oneline -20`, tracker state.

## Cleanup & Team Lead

When all issues Done: archive to tracker; delete `.opencastle/SESSION-CHECKPOINT.md`.
