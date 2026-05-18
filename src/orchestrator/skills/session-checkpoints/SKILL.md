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

## Checkpoint Template

Full checkpoint template moved to `CHECKPOINT-TEMPLATE.md` in this directory for progressive disclosure. Use that file as canonical, copy-pasteable checkpoint document.

See Decomposition Flow in `decomposition` skill for when to create checkpoints: [decomposition](../../skills/decomposition/SKILL.md).
## Checkpoint creation (quick)

1. Create `.opencastle/SESSION-CHECKPOINT.md` from example below.
2. Commit checkpoint or save to workspace; attach to tracker issue.
3. Verify: `cat .opencastle/SESSION-CHECKPOINT.md`; confirm listed files exist.

```markdown
# Session Checkpoint — 2026-04-01

## Summary
Implementing search filters — unit tests passing, E2E pending.

## Files Touched
- src/components/SearchFilter.tsx (new)
- src/hooks/useFilters.ts (modified)

## Task Status
| Task | Status |
|------|--------|
| TASK-12 Search filter component | Done |
| TASK-13 E2E filter tests | In Progress |

## Resume Instructions
1. Run `git checkout feat/search-filters`
2. Start dev server: `pnpm dev`
3. Continue TASK-13: write E2E tests for filter interactions
```

For complete copy-pasteable template, see [CHECKPOINT-TEMPLATE.md](./CHECKPOINT-TEMPLATE.md).

## Resuming

1. Read `.opencastle/SESSION-CHECKPOINT.md`
2. Run `git status`, `git branch` — confirm you are on correct branch
3. Check In Progress tasks — if stale (>1 session old), verify files match expected state
4. Check Pending Approvals — remove rows for questions answered via VS Code chat
5. Read tracker issues for tasks marked In Progress or Todo
6. Follow Resume Instructions section in checkpoint
7. Update checkpoint progress after each completed task

**If checkpoint missing or corrupt:** Rebuild from `git log --oneline -20`, tracker state.

## Cleanup & Team Lead

When all issues Done: archive to tracker; delete `.opencastle/SESSION-CHECKPOINT.md`.
