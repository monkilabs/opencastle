<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Bug Fix

Structured workflow for investigating and fixing reported bugs.

## Phases

```
Phase 1: Triage & Reproduce    (sub-agent, inline)
Phase 2: Root Cause Analysis    (sub-agent, inline)
Phase 3: Fix Implementation     (sub-agent or background)
Phase 4: Verification           (sub-agent, inline)
Phase 5: Delivery               (direct, Team Lead)
```

---

## Branch & Delivery Strategy

The Team Lead creates the branch before any delegation and delivers it as the Delivery phase below describes. Branch naming: `fix/<ticket-id>-<short-description>`.

---

## Phase 1: Triage & Reproduce

**Agent:** Team Lead (self)
**Type:** Direct research

### Steps

1. Check `.opencastle/KNOWN-ISSUES.md` for existing entry
2. Check tracker for existing bug ticket
3. Read `.opencastle/LESSONS-LEARNED.md` for related pitfalls
4. **Reproduce the bug** — this is mandatory before any fix attempt:
   a. Start the dev server (see the **codebase-tool** skill for the serve command)
   b. Navigate to the affected page in Chrome
   c. Follow the reproduction steps from the bug report
   d. **Confirm the failure** — screenshot the broken state as evidence
   e. If the bug **cannot be reproduced**, document what was tried and ask the reporter for more detail. Do NOT proceed to Phase 2 without reproduction
5. Assess severity (Critical/High/Medium/Low)
6. Create tracker issue with `[Bug]` prefix and `bug` label, including reproduction steps and screenshot

### Exit Criteria

- [ ] Bug **confirmed reproduced** with screenshot evidence (or documented as non-reproducible with investigation notes)
- [ ] Severity assessed
- [ ] Tracker issue created with reproduction steps and screenshot
- [ ] Affected apps identified (see `.opencastle/project.instructions.md` for inventory)

---

## Phase 2: Root Cause Analysis

**Agent:** Specialist (based on bug domain — Developer, Security Expert, etc.)
**Type:** Sub-agent (inline, result needed for Phase 3)

### Steps

1. Search codebase for components, queries, and logic involved
2. Trace data flow from source → query → component → render
3. Check `git log` on suspected files for recent changes
4. Identify root cause category:
   - Code bug (logic error, missing null check)
   - Data issue (unexpected shape, missing field)
   - Race condition (timing, hydration mismatch)
   - CSS/Layout (specificity, overflow, responsive)
   - Integration (API contract mismatch, schema drift)
5. Update tracker issue with root cause and affected files

### Exit Criteria

- [ ] Root cause identified and documented
- [ ] Affected files listed (defines the fix partition)
- [ ] Fix approach decided

---

## Phase 3: Fix Implementation

**Agent:** Specialist (same as Phase 2)
**Type:** Sub-agent (simple fix) or Background (complex fix)

### Steps

1. Implement the fix within the identified file partition
2. Add or update tests covering the bug scenario
3. Run lint + test + build for affected projects
4. Return output contract

### Exit Criteria

- [ ] Fix implemented
- [ ] Test covering the bug added
- [ ] Lint + test + build pass
- [ ] Output contract returned

---

## Phase 4: Verification

**Agent:** Team Lead (self)
**Type:** Direct verification

### Steps

1. Review the output contract
2. Start dev server with clean cache
3. Verify the bug is fixed in Chrome (screenshot the working state)
4. Test adjacent features for regressions
5. If security-related: schedule panel review
6. Move tracker issue to Done
7. Update `.opencastle/KNOWN-ISSUES.md` if the bug was listed there
8. Commit and push

### Exit Criteria

- [ ] Bug confirmed fixed with screenshot
- [ ] No regressions introduced
- [ ] Tracker issue moved to Done
- [ ] Known issues updated (if applicable)
- [ ] Delivery phase completed — branch pushed, PR opened (not merged), tracker linked

---

### Phase 5: Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
>
> Commit → Push → PR → tracker linkage. Team Lead owns delivery.
