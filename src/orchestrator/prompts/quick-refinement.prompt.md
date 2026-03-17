---
description: 'Handle follow-up refinements after a roadmap task — bug fixes, UI tweaks, polish, and adjustments that are too small for issue tracking.'
agent: 'Team Lead (OpenCastle)'
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Follow-Up Refinement

You are the Team Lead. Handle the follow-up refinement described below. This is a **post-task adjustment** — a bug fix, UI tweak, or polish item that came up after reviewing a completed roadmap task. It does NOT require issue tracking.

## Request

{{followUpRequest}}

---

## How Follow-Ups Differ from Roadmap Tasks

| Aspect | Roadmap Task | Follow-Up |
|--------|-------------|-----------|
| Tracker issues | Required (hard gate) | Depends on scope (see triage) |
| Panel review | For high-stakes changes | Only if security/data-related |
| Documentation updates | Roadmap + known issues + ADRs | Only if behavior changes significantly |
| Scope | Multi-step feature | Focused fix or adjustment |
| Branch strategy | Dedicated feature branch | Current branch (already in progress) |

**Despite being lighter-weight, follow-ups still require the same code quality and verification standards.** Never skip linting, testing, or browser checks just because the change is "small."

## Workflow

### 1. Triage: Decide Tracking Level

**Create a tracker issue if ANY of these are true:**
- Affects user-visible behavior, touches >2–3 files, or modifies `libs/`, queries, API routes, or Server Actions
- Could introduce regressions in other features
- You want a record for future reference

**Skip tracking if ALL of these are true:**
- Pure cosmetic/spacing/copy change with no behavioral impact
- Isolated to a single component or page
- Trivial to verify visually

If creating: title `[Follow-up] Short description`, label `follow-up`, priority Low/Medium, description: what changed, why, files

### 2. Understand the Request

1. **Clarify scope** — Identify exactly which pages, components, or behaviors need to change
2. **Find affected files** — Search the codebase for the relevant components, styles, queries, and tests
3. **Check known issues** — Scan `.opencastle/KNOWN-ISSUES.md` in case this is a documented limitation
4. **Read lessons learned** — Check `.opencastle/LESSONS-LEARNED.md` for relevant pitfalls before starting
5. **Assess complexity** — If larger than expected (>5 files, migration, or auth/security), inform the user, create a tracker issue, and switch to the `implement-feature` workflow

### 3. Plan the Fix

1. **Identify root cause** — For bugs, find why; for UI tweaks, understand the styling/layout chain
2. **Assess shared impact** — Will the fix affect other pages or apps? Check component usage across the codebase
3. **Minimal change** — Reuse existing components, utilities, and styles. Never introduce a new pattern for a one-off fix

### 4. Implement

#### Delegation Prompt Must Include

- What to fix, exact file paths, and how to verify the result
- Boundaries: "Only modify files listed above. Do not refactor unrelated code."
- Self-improvement reminder (see **self-improvement** skill)

#### Implementation Rules

- **No scope creep** — Fix only what was asked; note but don't fix adjacent issues
- **DRY + Visual consistency** — Reuse existing components, utilities, and design system patterns
- **Cross-app + Accessibility** — Verify `libs/` changes across apps; don't regress keyboard nav/contrast

### 5. Validate

> Load the **validation-gates** skill for detailed steps on each gate.

Every follow-up, no matter how small, must pass these gates:

1. **Secret Scanning** — block if API keys/tokens/passwords found in diff
2. **Deterministic Checks** — lint, test, build — zero errors (see **codebase-tool** skill)
3. **Blast Radius** — ≤100 lines / ≤3 files for follow-ups; if larger, escalate to `implement-feature`
4. **Dependency Audit** — when `package.json` or lockfiles change
5. **Fast Review** (MANDATORY) — single reviewer sub-agent
6. **Browser Testing** (MANDATORY for visual changes) — clear cache, verify + responsive + screenshots
7. **Regression Testing** — if shared component/library modified, test all consuming projects

### 6. Delivery

If tracked: follow the **Delivery Outcome** in the **git-workflow** skill — commit, push, open PR (not merged), tracker linked.

If untracked: commit to the current branch; Team Lead includes in the parent task's existing PR.

### 7. Escalation Triggers

- Requires a database migration or data model changes (CMS schemas, tables)
- Involves auth/authorization changes
- Touches >5 files across multiple libraries
- Introduces a new dependency or API endpoint
- Is a systemic issue requiring architectural changes
- Decomposes into 3+ subtasks → switch to `implement-feature`

### 8. Completion

- [ ] The specific request is resolved
- [ ] Tracker issue created and moved to Done (if triage determined tracking was needed)
- [ ] **Visual changes verified in Chrome with screenshot taken as proof**
- [ ] Shared component changes tested across all consuming apps
- [ ] Delivery Outcome completed if tracked (see the **git-workflow** skill) — branch pushed, PR opened (not merged), tracker linked
- [ ] Lessons learned captured and known issues updated if applicable
