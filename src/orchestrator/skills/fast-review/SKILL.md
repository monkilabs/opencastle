<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

````skill
---
name: fast-review
description: "Mandatory single-reviewer gate that runs after every agent delegation. Provides automatic retry with feedback and escalation to panel review after repeated failures. Essential for overnight/long-running autonomous sessions."
---

# Skill: Fast Review

Mandatory lightweight review after **every** agent delegation — fills the gap between unchecked output and expensive panel reviews.

## Contract

- Runs **after every delegation** — no exceptions.
- Single reviewer sub-agent (not 3).
- Uses Economy/Standard tier models (cost-efficient).
- Produces PASS or FAIL with structured feedback.
- On FAIL: automatic retry with reviewer feedback (up to 2 retries).
- On 3rd FAIL: auto-escalates to panel review.
- Total review time budget: ~2-5 minutes per review.

## Reviewer Model Selection

Use Economy-tier reviewer by default; upgrade to Standard for Premium agent work or security-touching tasks.

## Procedure

### Step 1: Collect Review Context

1. **Issue** — acceptance criteria from the tracked issue
2. **File diff** — list of changed files and their contents (or key sections)
3. **File partition** — the agent's assigned files (to check for boundary violations)
4. **Deterministic results** — lint, test, build output (already run as part of validation gates)
5. **Agent's self-report** — what the agent claims to have done

### Step 2: Spawn Reviewer Sub-Agent

Launch a single `runSubagent` with the review prompt (see § Reviewer Prompt Template below).

**Critical:** The reviewer runs in an isolated sub-agent context. It must NOT have access to the original delegation prompt — it reviews the *output*, not the *intent*. Construct the review context precisely — provide only the acceptance criteria, file diff, partition, and deterministic results. No session history, no delegation prompt, no prior conversation.

### Step 3: Parse Verdict

The reviewer must output this exact structure:

```
VERDICT: PASS | FAIL

ISSUES:
- [severity:critical|major|minor] Description of issue

FEEDBACK:
Specific, actionable feedback for the implementer if FAIL.

CONFIDENCE: low | medium | high
```

**Verdict rules:**
- **PASS** — No critical or major issues. Minor issues are noted but don't block.
- **FAIL** — At least one critical or major issue found.
- If the reviewer output doesn't match the expected format, treat it as FAIL and re-dispatch with the prompt template re-emphasized.

**Auto-PASS conditions (skip reviewer):**
- The delegation was pure research/exploration with no code changes
- The delegation only modified documentation files (`.md`)
- All deterministic gates already passed AND the change is ≤10 lines across ≤2 files AND **no sensitive files were touched** (see validation-gates Gate 3 sensitive file list)

> **Sensitive file override:** Changes to auth/middleware files, database migrations, RLS policies, security headers, CSP configuration, environment variable schemas, or CI/CD configuration **always** require a reviewer — even for 1-line changes. Auto-PASS never applies to these files.

### Step 4: Handle Verdict

#### On PASS

1. Accept the agent's output
2. Log the review result (see § Logging)
3. Continue orchestration

#### On FAIL (attempt 1 or 2)

1. Log the review result
2. Re-delegate to the **same agent** with reviewer feedback appended and the note: "This is retry attempt N/2 after fast review — address the following issues before resubmitting"
3. After the agent re-submits, run fast review again (go back to Step 1)

#### On FAIL (attempt 3 — escalation)

1. Log the review result with `escalated: true`
2. **Auto-escalate to panel review** — load the `panel-majority-vote` skill
3. Include all 3 fast review reports as context for the panel
4. If panel BLOCKs 3 times → create a **dispute record** in `.opencastle/DISPUTES.md` (see **team-lead-reference** skill § Dispute Protocol)

## Reviewer Prompt Template

```markdown
You are a code reviewer. Verify the delegated task was completed correctly. Be concise and specific.

## Task Under Review
**Issue:** [ID] — [Title]
**Acceptance Criteria:**
- [ ] [Criterion 1]

## Agent's File Partition (allowed files)
[List of directories/files the agent was allowed to modify]

## Changed Files
[For each file: path, key sections of the diff or full new content]

## Deterministic Check Results
Lint: [PASS/FAIL] | Tests: [PASS/FAIL] | Build: [PASS/FAIL]

## Review Checklist
1. Acceptance criteria met?
2. File partition respected?
3. No regressions introduced?
4. Errors surfaced clearly (no swallowed exceptions)?
5. Type safety (no `as any`)?
6. Security basics (no secrets, injection vectors, unsafe input)?
7. Obvious edge cases handled?

## Previous Review Feedback (if retry)
[Prior FAIL feedback]

VERDICT: PASS | FAIL
ISSUES:
- [severity:critical|major|minor] Description
FEEDBACK: Actionable feedback.
CONFIDENCE: low | medium | high
```

## Logging

> **⛔ HARD GATE — Do NOT proceed to the next task or accept the review result until the review is logged.**

After each fast review, log the result using the **observability-logging** skill's review record command. See the skill for the exact CLI syntax, required fields, and verify step. An unlogged review is a failed review.

## Integration with Existing Workflow

Fast review hooks into `on-post-delegate` as Gate 5. The hook sequence is:

1. Verify output (file changes within partition) — validation-gates Gate 1
2. Run deterministic checks (lint, test, build) — validation-gates Gates 2–4
3. **Run fast review** — validation-gates Gate 5
4. Check acceptance criteria (cross-checked by reviewer)
5. Update issue

Fast review adds ~5-15% token overhead — far cheaper than panel review on every step.

## Overnight/Long-Run Mode

- **Upgrade reviewer** one tier for extra safety when unattended.
- **Stricter escalation** — escalate to panel after 2 FAILs instead of 3.
- **Checkpoint on escalation** — save a session checkpoint before proceeding to panel.

## Anti-Patterns

- **Skipping fast review** — Never. Not even for "trivial" changes.
- **Using Panel as fast review** — Wastes ~3x tokens and time vs. a single reviewer.
- **Reviewer sees the delegation prompt** — Reviewer evaluates output against acceptance criteria, not the prompt.
- **Ignoring minor issues** — Track them; if the same minor issue appears 3+ times, create a ticket.
- **Manual override of FAIL** — Never force-accept a FAIL. Fix through retry or escalate.
- **Skipping deterministic checks** — Fast review does NOT replace lint/test/build; those run first.

````
