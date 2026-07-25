<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Feature Implementation

Standard execution plan for multi-layer features. Customize file paths, agents, and criteria per task.

## Phases

```
Phase 0: Brainstorm      (sub-agent or direct, optional)
Phase 1: Research        (sub-agent, inline)
Phase 2: Foundation      (background agents, parallel)
Phase 3: Integration     (sub-agent, sequential)
Phase 4: Validation      (background agents, parallel)
Phase 5: QA Gate         (sub-agent, inline)
Phase 6: Delivery        (direct, Team Lead)
```

---

## State Tracking

Every Team Lead response during feature work **must** end with a state block. This enables context recovery after interruption and keeps the user informed:

```
📍 Phase 2/6 — Foundation | Progress: 3/7 issues | Budget: 2/7 delegations
   Last: ✅ TAS-42 schema deployed (Content Engineer)
   Next: Delegate TAS-43 migration (DB Engineer)
   Cost: ~45K tokens (Standard×2)
```

Fields: current phase, issues completed/total, delegations used/budget, last completed action, next planned action, running estimated token cost.

---

## Branch Strategy

1. **Team Lead creates the feature branch** in Phase 1 before any delegation: `git checkout -b feat/<ticket-id>-<short-description>`
2. **Sub-agents** work directly on the feature branch (they share the Team Lead’s working tree)
3. **Background agents** work in isolated worktrees branched from the feature branch
4. **Team Lead merges worktrees back** in Phase 5 (QA Gate) after verifying each background agent’s output
5. **Only the Team Lead pushes** to the feature branch and opens the PR

---

## Phase 0: Brainstorm (Optional)

**Agent:** Team Lead (self)
**Type:** Direct or sub-agent
**Blocking:** No — skip when the approach is obvious

Run the `brainstorm` prompt when the task has ambiguity, multiple valid approaches, or significant design decisions. Skip for well-defined tasks with obvious implementation paths.

### Steps

1. Clarify the problem — restate, surface assumptions
2. Explore solution space — search existing code, check docs
3. Generate 2-3 alternative approaches with trade-offs
4. Recommend an approach with rationale
5. Define scope boundaries (in/out/deferred)

### Exit Criteria

- [ ] Problem clearly understood
- [ ] Alternatives explored
- [ ] Approach chosen with rationale
- [ ] Scope boundaries defined
- [ ] Brainstorm report produced (feeds into Phase 1)

---

## Phase 1: Research & Planning

**Agent:** Team Lead (self)
**Type:** Sub-agent or direct
**Blocking:** Yes — all other phases depend on this

### Steps

1. Read `.opencastle/project.instructions.md`, `.opencastle/KNOWN-ISSUES.md`, `.opencastle/LESSONS-LEARNED.md`
2. Search codebase for existing implementations
3. Identify affected apps, libs, and layers
4. **Spec flow analysis** — Trace the complete user flow end-to-end and identify:
   - All user-visible states (loading, empty, populated, error, partial)
   - State transitions and what triggers them
   - Edge cases (network failure, invalid data, concurrent access, empty collections)
   - Missing paths in the spec ("what happens when X?")
   - Accessibility flows (keyboard navigation, screen reader announcements)
   - Document findings as acceptance criteria on the tracker issues
5. Decompose into tracker issues with file partitions
6. **Surface Open Questions** — Collect ambiguities, design choices, and assumptions that need user input. Present as a structured list for approval before proceeding.
7. Create session checkpoint

### Open Questions Gate

> **MANDATORY STOP.** Do not proceed to Phase 2 until the user has answered all open questions.

After decomposition, present a structured list of open questions. Each question should:
- State the decision needed clearly
- Offer 2-3 concrete options with brief trade-offs
- Flag a recommended option if one is obvious

```markdown
**Open Questions (answer before implementation begins):**
1. [Question]? Option A (trade-off) / Option B (trade-off) / **Recommended: A**
2. [Question]? Option A / Option B
```

If there are no open questions, explicitly state: "No open questions — plan is unambiguous."

### Exit Criteria

- [ ] All relevant docs read
- [ ] **User flow traced** — all states, transitions, and edge cases documented
- [ ] Tracker issues created for every subtask (including edge case coverage)
- [ ] File partitions mapped (no overlaps)
- [ ] Dependencies identified
- [ ] **Open questions answered** by user (or none identified)
- [ ] Session checkpoint saved

---

## Phase 2: Foundation (Parallel)

**Agents:** Varies by task (DB Engineer, Content Engineer, UI Expert)
**Type:** Background agents (parallel)
**Blocking:** Phase 3 depends on this

### Typical Partitions

> For project-specific paths, see `project.instructions.md` and the relevant `stack/` customization files.

| Track | Agent | Files | Purpose |
|-------|-------|-------|----------|
| A: Schema | Content Engineer | CMS schema directory | CMS schema changes |
| B: Database | Data Engineer | Database migrations directory | Migration + RLS policies |
| C: Components | UI/UX Expert | Shared component library | New UI components |

### Exit Criteria (per track)

- [ ] Schema deployed or migration applied
- [ ] Type definitions generated
- [ ] Lint + test pass
- [ ] Output contract returned

---

## Phase 3: Integration (Sequential)

**Agent:** Developer
**Type:** Sub-agent (needs Phase 2 results)
**Blocking:** Phase 4 depends on this

### Steps

1. Wire new components to data queries
2. Update data queries (see relevant skill for query library location)
3. Integrate into page routes
4. Add loading/error states
5. Run lint + test + build

### Exit Criteria

- [ ] Feature works end-to-end (data → query → component → page)
- [ ] Loading and error states implemented
- [ ] All affected projects build
- [ ] Output contract returned

---

## Phase 4: Validation (Parallel)

**Agents:** Testing Expert, Security Expert, Writer
**Type:** Background agents (parallel)

### Tracks

| Track | Agent | Focus |
|-------|-------|-------|
| A: Tests | Testing Expert | Unit tests, E2E browser tests |
| B: Security | Security Expert | RLS audit, input validation, auth check |
| C: Docs | Writer | Roadmap, ADRs, known issues |

### Exit Criteria (per track)

- [ ] 95% test coverage on new code
- [ ] Browser screenshots at all breakpoints
- [ ] Security audit passes (or panel review scheduled)
- [ ] Documentation updated
- [ ] Output contracts returned

---

## Phase 5: QA Gate

**Agent:** Team Lead (self)
**Type:** Sub-agent (inline)
**Blocking:** Must pass before merge

### Steps

1. Review all output contracts from Phases 2-4
2. Run full lint + test + build across all affected projects
3. Verify no files outside partitions were modified
4. Check all tracker issue acceptance criteria
5. Run panel review if high-stakes (security, DB, architecture)
6. **Final Smoke Test (Gate 10)** — verify the complete feature end-to-end:
   - Full clean build of all affected projects (not incremental)
   - End-to-end browser walkthrough of the complete user flow
   - Verify all states: loading, empty, populated, error, partial
   - Cross-task integration check (e.g., migration + component + page compose correctly)
   - Final responsive sweep at all breakpoints (if UI changes)
7. Move all issues to Done
8. Update session checkpoint → delete checkpoint
9. Update `.opencastle/project/roadmap.md`

### Exit Criteria

- [ ] All phases verified
- [ ] All tracker issues Done
- [ ] Full build passes
- [ ] **Final smoke test passed** — complete user flow verified end-to-end
- [ ] Roadmap updated
- [ ] Delivery Outcome completed (see `general.instructions.md`) — branch pushed, PR opened (not merged), tracker linked

---

### Phase 6: Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
>
> Commit → Push → PR → tracker linkage. Team Lead owns delivery.
