---
description: 'Instruct the Team Lead to implement specific task from a roadmap with full orchestration, validation, traceability.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Implement Roadmap Task

You are the Team Lead. Implement the roadmap task described below following this strict workflow. Task comes from `.opencastle/project/roadmap.md`.

## Task

{{roadmapTask}}

---

## Workflow

> **HARD GATE:** Steps 1→2 are **blocking prerequisites**. Do NOT write, edit, or delegate any code until tracker issues exist for every subtask. If you catch yourself writing code before issues are created, STOP immediately; create the issues; then resume.

### 1. Research & Context Gathering

1. **Read the roadmap** — Confirm scope, status, and acceptance criteria in `.opencastle/project/roadmap.md`
2. **Check blockers** — Read `.opencastle/KNOWN-ISSUES.md` and `.opencastle/LESSONS-LEARNED.md` for pitfalls and workarounds
3. **Read architecture docs** — Check `.opencastle/project.instructions.md` and `.opencastle/project/decisions.md` for constraints
4. **Search existing code** — Find related files, components, queries, and tests; check for reusable implementations before creating anything new

### 2. Task Board Setup (BLOCKING — must complete before Step 3)

Every subtask must be tracked. **No issue = no implementation.** This step produces the issues that gate all downstream work.

1. **Check existing issues** — Search the board for any in-progress or completed work related to this task
2. **Decompose into issues** — Create one tracker issue per subtask using `[Area] Short description` naming
3. **Set metadata** — Assign labels (agent name), priority, dependencies, and file partitions
4. **Write descriptions** — Objective (1 sentence), files (partition paths), acceptance criteria (checklist), dependencies (links)
5. **Link to roadmap** — Reference the roadmap section in the issue description so context is never lost
6. **Verify issues exist** — List all created issue IDs. If count is 0, do NOT proceed to Step 2.5

### 2.5 Generate Convoy Spec (BLOCKING — decides how Step 3 proceeds)

All project-related work executes via the convoy engine — regardless of subtask count.

1. **Generate the spec** — use the `generate-convoy` prompt with the decomposed task list. The spec IS the implementation plan; even single-task fixes go through convoy for observability.
2. **Hand the spec to the user** — tell them to run: `npx opencastle convoy run -f .opencastle/convoys/<name>.convoy.yml`
3. **The convoy engine handles** isolated git worktrees, parallel execution, merge queue ordering, crash recovery, and structured logging automatically.
4. **After convoy completes** — proceed to Step 4 (validation) and Step 5 (delivery/PR).

### 3. Implementation Rules

> **Convoy execution:** Convoy spec IS the implementation plan — skip manual delegation; jump to Step 4 after user runs convoy.

#### Issue Traceability

- Include tracker issue ID and title in every delegation prompt
- Reference issue IDs (e.g., `TAS-42`) in commit messages; move issues In Progress → Done as work progresses

#### DRY Code

- Search before creating — check for existing components, hooks, utilities, queries first
- Extract shared logic to `libs/`; no copy-paste across apps. Refactor duplicates when discovered

#### Visual Consistency

- Use shared component library; never re-implement existing components
- Match spacing, typography, colors from existing pages; verify in all affected apps

### 4. Validation & Testing

> Load **validation-gates** skill for detailed steps on each gate.

Every subtask must pass ALL gates before being marked Done:

1. **Secret Scanning** — block if API keys/tokens/passwords found in diff
2. **Deterministic Checks** — lint, test, build — zero errors (see **codebase-tool** skill)
3. **Blast Radius** — ≤200 lines / ≤5 files normal; escalate if >500 lines or >10 files
4. **Dependency Audit** — when `package.json` changes
5. **Fast Review** (MANDATORY) — single reviewer sub-agent
6. **Browser Testing** (MANDATORY for UI) — clear cache, verify features + responsive + screenshots
7. **Regression Testing** — full suite for affected projects
8. **Panel Review** — for security, DB migrations, architecture (use **panel-majority-vote** skill)
9. **Final Smoke Test** — end-to-end verification of complete feature

### 5. Delivery

Follow **Delivery Outcome** in **git-workflow** skill — commit, push, open PR (not merged), link to tracker. Convoy engine creates commits on configured `branch` directly; open PR from that branch after validation passes.

### 6. Documentation & Traceability

1. **Update roadmap** — Mark completed items with ✅ and date; include tracker issue IDs next to each scope item (e.g., `[PREFIX-6](<url>) — Description ✅ Done`)
2. **Update known issues** — Add new limitations to `.opencastle/KNOWN-ISSUES.md`
3. **Update architecture docs** — Add ADRs for architectural decisions to `.opencastle/project/decisions.md`
4. **Link tracker issues** — Reference roadmap section, partition files, and related issues in each description
5. **Close issues properly** — Move to Done only after independent verification passes all gates

### 7. Completion Criteria

Roadmap task is complete when:

- [ ] All tracker subtask issues are Done
- [ ] **All UI changes verified in Chrome browser via MCP with screenshots as proof**
- [ ] **Every feature in acceptance criteria visually confirmed** — not just "page loads"
- [ ] No duplicated code — shared logic extracted to libraries
- [ ] Visual consistency maintained across all affected pages, apps
- [ ] Documentation updated (roadmap, known issues, decisions)
- [ ] Panel review passed for any high-stakes changes
- [ ] Roadmap item marked complete in `.opencastle/project/roadmap.md`
- [ ] Delivery Outcome completed (see **git-workflow** skill) — branch pushed, PR opened (not merged), tracker linked
- [ ] Lessons learned captured if any retries occurred
