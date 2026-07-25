---
description: 'Investigate and fix reported bug with proper triage, root cause analysis, issue tracking, verification.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Fix Bug

You are the Team Lead. Investigate and fix the bug described below. Bugs are real defects affecting users — treat seriously with proper triage, tracking, verification.

## Bug Report

{{bugDescription}}

---

## How Bug Fixes Differ from Other Workflows

| Aspect | Roadmap Task | Follow-Up | Bug Fix |
|--------|-------------|-----------|---------|
| Issue tracking | Required | Not required | **Required** |
| Urgency | Planned | Low | Can be critical |
| Root cause analysis | Feature design | Not needed | **Required** |
| Reproduction steps | N/A | N/A | **Required** |
| Panel review | High-stakes only | Rarely | If security-related |
| Documentation | Roadmap + ADRs | Minimal | Known issues if needed |
| Scope | Multi-step feature | Focused tweak | Focused fix |

## Workflow

### 1. Triage & Reproduce

1. **Check known issues** — Search `.opencastle/KNOWN-ISSUES.md` for an existing entry. If found, note workarounds and decide if a fix is now feasible
2. **Check tracker** — Search for existing bug tickets. If one exists, take it over instead of creating duplicate
3. **Read lessons learned** — Check `.opencastle/LESSONS-LEARNED.md` for related pitfalls
4. **Reproduce the bug** — Start the dev server (see **codebase-tool** skill), navigate to the affected page in Chrome, follow the repro steps, and screenshot the broken state
5. **Determine scope** — Which apps are affected? (see `project.instructions.md` for the app inventory)
6. **Assess severity**: Critical (crash/data loss/auth bypass) | High (broken + workaround) | Medium (minor functional) | Low (edge case/cosmetic)

### 2. Create Tracker Issue

Every bug gets tracked. Create tracker issue with:

- **Title**: `[Bug] Short description of symptom`
- **Label**: `bug`; **Priority**: based on severity
- **Description**: Symptom, reproduction steps, expected vs actual behavior, affected apps + files, screenshot

### 3. Root Cause Analysis

1. **Search the codebase** — Find the components, queries, styles, and logic involved
2. **Trace the data flow** — Source (CMS/database) → query → component → render
3. **Check recent changes** — `git log` on suspected files
4. **Identify the root cause** — Code bug, Data issue, Race condition, CSS/Layout, or Integration failure
5. **Update the tracker issue** — Add root cause findings and affected file paths

### 4. Implement the Fix

All bug fixes execute via convoy engine — even single-task fixes — for observability, crash recovery.

1. **Generate a convoy spec** — use the `generate-convoy` prompt with the root cause analysis, fix approach, and file paths as context.
2. **Hand the spec to the user** — tell them to run: `npx opencastle convoy run -f .opencastle/convoys/<name>.convoy.yml`
3. **After convoy completes** — proceed to Step 5 (validation).

#### Convoy Task Prompt Must Include

- Tracker issue ID, title, root cause, fix approach, file paths, reproduction steps
- Boundaries: "Only modify files listed above. Fix the bug, do not refactor surrounding code."
- Self-improvement reminder (see **self-improvement** skill)

#### Implementation Rules

- **Fix cause not symptom** — Minimal change, no refactoring. A CSS `!important` or silent `catch {}` is not a fix
- **Add a test** — If no test covers this scenario, add one
- **Cross-app awareness** — If the fix is in `libs/`, verify it works in all consuming apps

### 5. Validate

> Load **validation-gates** skill for detailed steps on each gate.

1. **Secret Scanning** — block if API keys/tokens/passwords found in diff
2. **Deterministic Checks** — lint, test, build — zero errors (see **codebase-tool** skill)
3. **Blast Radius** — bug fixes should be ≤100 lines / ≤3 files; escalate if larger
4. **Dependency Audit** — when `package.json` or lockfiles change
5. **Fast Review** (MANDATORY) — single reviewer sub-agent
6. **Bug-Specific Verification** (MANDATORY) — reproduce original bug (should be gone), verify correct behavior, screenshot before/after, check both apps if shared code
7. **Browser Testing** (for UI bugs) — clear cache, verify fix + responsive + screenshots
8. **Regression Testing** — run tests for all projects consuming modified files
9. **Panel Review** — only if fix touches auth/authorization, RLS, security headers, or sensitive data (use **panel-majority-vote** skill)

### 6. Delivery

Follow **Delivery Outcome** in **git-workflow** skill — commit, push, open PR (not merged), link to tracker.

### 7. Wrap Up

1. **Close out** — Move tracker to Done; remove or update any `.opencastle/KNOWN-ISSUES.md` entry if applicable
2. **Capture lessons** — Use the **self-improvement** skill if the root cause reveals a pattern others should know
3. **Note prevention** — If the bug class could be caught earlier, note it in the tracker as a follow-up

### 8. Completion Criteria

Bug fix is complete when:

- [ ] Bug is reproduced and root cause identified
- [ ] Tracker issue created with full details
- [ ] Fix implemented with minimal change
- [ ] Test added covering the bug scenario
- [ ] Bug verified fixed in the browser
- [ ] Both apps checked if shared code was modified
- [ ] Delivery Outcome completed (see **git-workflow** skill) — branch pushed, PR opened (not merged), tracker linked
- [ ] Tracker issue moved to Done
- [ ] Known issues updated if applicable
- [ ] Lessons learned captured if any retries occurred
