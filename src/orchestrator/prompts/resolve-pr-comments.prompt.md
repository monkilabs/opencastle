---
description: 'Resolve GitHub PR review comments by reading them, grouping by file, applying fixes systematically.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Resolve PR Comments

You are the Team Lead. A pull request has review comments needing resolution. Read comments, group by file, delegate fixes efficiently.

## PR Reference

{{prReference}}

---

## Workflow

### Phase 1: Gather Comments

1. **Read the PR** — Use `gh pr view <number> --comments` and `gh pr diff <number>` to understand the full context
2. **List review comments** — Use `gh api repos/{owner}/{repo}/pulls/{number}/comments` to get all inline review comments
3. **Group by file** — Organize comments by file path. Comments on the same file should be resolved together
4. **Classify each comment:**
   - **Must-fix** — Correctness issues, security concerns, logic errors, test gaps
   - **Should-fix** — Style issues, naming improvements, missing edge cases
   - **Discussion** — Questions, alternative suggestions, design debates (flag for human)

### Phase 2: Plan Fixes

1. **Map file ownership** — Ensure no two parallel agents touch the same file
2. **Check dependencies** — Some comments may depend on others (e.g., "rename this type" affects all files using it)
3. **Order by dependency** — Resolve foundational changes first (types, shared utilities) before downstream files
4. **Estimate scope** — If >10 must-fix comments, consider splitting into multiple delegation rounds

### Phase 3: Apply Fixes

For each file group, delegate to appropriate specialist agent:

```
Fix the following PR review comments in [file path]:

1. [Comment 1]: [reviewer's feedback] (Line X)
2. [Comment 2]: [reviewer's feedback] (Line Y)

Context: This file is part of [feature/area]. The PR is [brief PR description].

Acceptance criteria:
- [ ] Each comment is addressed (fixed or documented why not)
- [ ] No new lint/type errors introduced
- [ ] Existing tests still pass
- [ ] New tests added if the comment identified a gap
```

**Discussion comments** — Do not fix these. Compile into summary for human reviewer with your recommendation.

### Phase 4: Verify & Report

> Load **validation-gates** skill for detailed steps on each gate.

All fixes must pass applicable gates before pushing:

1. **Gate 1: Secret Scanning** — scan diff for API keys, tokens, passwords, connection strings — block immediately if found
2. **Gate 2: Deterministic Checks** — run lint, test, and build for all affected projects (see the **codebase-tool** skill for commands) — all zero errors
3. **Gate 3: Blast Radius Check** — verify changes are scoped to commented files only; flag any files modified outside the comment scope
4. **Gate 4: Fast Review** (MANDATORY) — single reviewer sub-agent validates the combined PR comment fixes
5. **Gate 5: Regression Testing** — run tests for all projects consuming modified files

After all gates pass:

6. **Commit fixes** — Use descriptive commit messages referencing the PR: `TAS-XX: Address PR review — [summary]`
7. **Push to the same branch** — The PR updates automatically
8. **Report back** — Provide a structured summary of what was resolved

## Output Format

After resolving comments, report:

```markdown
## PR Comment Resolution: #<number>

### Resolved (Must-Fix)
| File | Comment | Resolution |
|------|---------|------------|
| path/to/file.ts | [feedback summary] | [what was changed] |

### Resolved (Should-Fix)
| File | Comment | Resolution |
|------|---------|------------|
| path/to/file.ts | [feedback summary] | [what was changed] |

### Flagged for Discussion
| File | Comment | Recommendation |
|------|---------|---------------|
| path/to/file.ts | [question/debate] | [your take + options] |

### Verification
- Secret Scanning: PASS/FAIL
- Lint: PASS/FAIL
- Tests: PASS/FAIL
- Build: PASS/FAIL
- Blast Radius: PASS/ESCALATED
- Fast Review: PASS/FAIL

### Commits
- `abc1234` TAS-XX: Address PR review — [summary]
```

## Rules

- **Never dismiss a must-fix comment** — if you disagree, flag for discussion instead
- **Preserve reviewer's intent** — don't just technically satisfy the comment, address underlying concern
- **Don't over-fix** — resolve only what was commented on. Save unrelated improvements for separate PR
- **Respond to every comment** — nothing should be silently ignored
- **Self-improvement** — Follow **self-improvement** skill
