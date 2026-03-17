<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

````skill
---
name: fast-review
description: "Mandatory single-reviewer gate that runs after every agent delegation. Provides automatic retry with feedback and escalation to panel review after repeated failures. Essential for overnight/long-running autonomous sessions."
---

# Skill: Fast Review

## Contract

- Runs **after every delegation** — no exceptions.
- Single reviewer sub-agent (not 3); Economy/Standard tier.
- Produces PASS or FAIL with structured feedback.
- On FAIL: automatic retry with feedback (up to 2 retries); on 3rd FAIL → escalate to panel review.
- Total review time budget: ~2-5 minutes.

## Reviewer Model Selection

Use Economy-tier reviewer by default; upgrade to Standard for Premium agent work or security-touching tasks.

## Procedure

### Step 1: Collect Review Context

1. **Issue** — acceptance criteria
2. **File diff** — changed files and contents (key sections)
3. **File partition** — agent’s assigned files (boundary check)
4. **Deterministic results** — lint, test, build output
5. **Agent’s self-report** — what the agent claims to have done

### Step 2: Spawn Reviewer Sub-Agent

Launch a single `runSubagent` with the review prompt (see § Reviewer Prompt Template below).

**Critical:** Reviewer context = ONLY acceptance criteria, file diff, partition, and deterministic results — no session history, no delegation prompt.

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
- **PASS** — no critical/major issues; minor issues noted but don't block.
- **FAIL** — at least one critical/major issue, OR output format mismatch (re-dispatch emphasizing format).

**Auto-PASS conditions (skip reviewer):**
- The delegation was pure research/exploration with no code changes
- The delegation only modified documentation files (`.md`)
- All deterministic gates already passed AND the change is ≤10 lines across ≤2 files AND **no sensitive files were touched** (see validation-gates Gate 3 sensitive file list)

> **Sensitive file override:** Changes to auth/middleware files, database migrations, RLS policies, security headers, CSP configuration, environment variable schemas, or CI/CD configuration **always** require a reviewer — even for 1-line changes. Auto-PASS never applies to these files.

### Step 4: Handle Verdict

#### On PASS

- Log the review result (§ Logging), accept output, continue orchestration.

#### On FAIL (attempt 1 or 2)

- Log result; re-delegate to the **same agent** with feedback: "Retry N/2 — address listed issues before resubmitting."
- After re-submission, run fast review again (return to Step 1).

#### On FAIL (attempt 3 — escalation)

- Log with `escalated: true`; load **panel-majority-vote** skill with all 3 reports as context.
- If panel BLOCKs 3 times → create dispute record in `.opencastle/DISPUTES.md` (see **team-lead-reference** § Dispute Protocol).

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

Log each review using the **observability-logging** skill's review record command.

## Integration with Existing Workflow

Hooks into `on-post-delegate` as Gate 5 — runs after deterministic checks (Gates 1–4). Adds ~5-15% token overhead; far cheaper than panel review per step.

## Overnight/Long-Run Mode

- Upgrade reviewer one tier; escalate to panel after 2 FAILs instead of 3.
- Save a session checkpoint before proceeding to panel.

## Anti-Patterns

- **Skipping fast review** — Never. Not even for "trivial" changes.
- **Using Panel as fast review** — Wastes ~3x tokens and time vs. a single reviewer.
- **Reviewer sees the delegation prompt** — Reviewer evaluates output against acceptance criteria, not the prompt.
- **Ignoring minor issues** — Track them; if the same minor issue appears 3+ times, create a ticket.
- **Manual override of FAIL** — Never force-accept a FAIL. Fix through retry or escalate.
- **Skipping deterministic checks** — Fast review does NOT replace lint/test/build; those run first.

````
