---
name: validation-gates
description: "Shared validation gates for all orchestration workflows — secret scanning, deterministic checks, blast radius analysis, dependency auditing, browser testing, cache management, regression checks, and final smoke tests. Referenced by prompt templates to maintain single source of truth."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Validation Gates

Canonical reference for validation gates shared across all orchestration workflows. Prompt templates reference this skill to avoid duplication.

**Gate summary:**

| Gate | Name | Runs When |
|------|------|-----------|
| 1 | Secret Scanning | Every delegation |
| 2 | Deterministic Checks | Every delegation |
| 3 | Blast Radius Check | Every delegation |
| 4 | Dependency Audit | When `package.json` or lockfiles change |
| 5 | Fast Review | Every delegation (with auto-PASS exceptions) |
| 6 | Cache Clearing | Before browser testing |
| 7 | Browser Testing | UI changes |
| 8 | Regression Testing | Every delegation |
| 9 | Panel Review | High-stakes changes only |
| 10 | Final Smoke Test | Feature completion (after all tasks Done) |

---

## Gate 1: Secret Scanning

> **HARD GATE — Constitution rule #1.** No tokens, keys, passwords, or connection strings in code, logs, commits, or terminal output.

Scan every diff **before** any other gate. A secret leak caught after merge is exponentially more expensive than one caught at review time.

### What to scan

Run regex scan of changed files for AWS keys, API tokens, private keys, database URIs, and hardcoded secrets. Also scan for hardcoded `password`, `secret`, `api_key`, `apiKey`, `token` assignments, `.env` file contents copied into source files, and Base64-encoded secrets.

### On detection

- **BLOCK immediately** — do not proceed to Gate 2
- Flag the specific file and line number
- Re-delegate to the agent with explicit instruction to use environment variables instead
- If a secret was already committed, **rotate it immediately** — git history is permanent

### Exceptions

- Test fixtures with obviously fake values (e.g., `sk-test-1234567890`)
- Documentation examples with placeholder values (e.g., `YOUR_API_KEY_HERE`)
- Pattern matches inside comments that are clearly explanatory

## Gate 2: Deterministic Checks

Run for every affected project (resolve exact commands via the **codebase-tool** skill):

- **Lint** (with auto-fix)
- **Test**
- **Build**

All must pass with zero errors. Run for **every** project that consumed modified files, not just the primary project.

## Gate 3: Blast Radius Check

Assess the scope of changes to catch scope creep and ensure reviewers can evaluate the diff effectively.

### Thresholds

| Metric | Normal | Warning | Escalate |
|--------|--------|---------|----------|
| Lines changed | ≤200 | 201–500 | >500 |
| Files changed | ≤5 | 6–10 | >10 |
| Projects affected | ≤1 | 2 | >2 |

### Actions

- **Normal** — proceed to Gate 4
- **Warning** — log a note in the delegation record. Ask: *"Was this scope expected?"* If yes, proceed. If unexpected, investigate whether the agent drifted from the partition
- **Escalate** — **STOP.** The Team Lead must review the diff before proceeding:
  1. Verify all changed files are within the agent's assigned partition
  2. Check whether the task should have been split into smaller subtasks
  3. If scope creep: revert extra changes, re-delegate with tighter scope
  4. If legitimately large: proceed, but **always run fast review** (no auto-PASS) and consider panel review

### Sensitive files

Changes to these file categories always trigger Warning regardless of line count:

- Auth/middleware files (e.g., `middleware.ts`, `auth.ts`, `**/auth/**`)
- Database migrations, RLS policies
- Security headers, CSP configuration (`next.config.*`, `vercel.json`)
- Environment variable schemas (`.env.example`, `env.ts`)
- CI/CD configuration (`.github/workflows/**`)
- Package manager configs (`package.json`, lockfiles) — also triggers Gate 4

## Gate 4: Dependency Audit

> Runs only when `package.json`, `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, or similar lockfiles are modified.

When agents add, remove, or update npm packages, verify:

1. **Vulnerability scan** — Run `npm audit` (or the project's equivalent). No new `high` or `critical` vulnerabilities
2. **License compatibility** — New packages must use MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, or ISC licenses. Flag any copyleft (GPL, LGPL, AGPL) or proprietary licenses for human review
3. **Bundle size impact** — For frontend packages, note the minified + gzipped size. Flag packages >50KB gzipped that have lighter alternatives
4. **Duplicate functionality** — Check whether the new dependency overlaps with an existing one (e.g., adding `moment` when `date-fns` is already installed)
5. **Maintenance health** — Flag packages with no updates in >2 years or <100 weekly downloads

### On failure

- **Vulnerability:** BLOCK. Re-delegate with instruction to use a patched version or alternative package
- **License concern:** Flag for human review. Do not block, but document in the PR description
- **Size/duplicate:** Flag as SHOULD-FIX in the fast review. Not blocking unless egregious (>200KB)

## Gate 5: Fast Review (MANDATORY)

> **HARD GATE:** Every agent delegation output must pass fast review before acceptance. This is non-negotiable — even for overnight/unattended runs. Load the **fast-review** skill for the full procedure.

After gates 1–4 pass:

1. **Spawn a single reviewer sub-agent** with the review prompt from the fast-review skill
2. **On PASS** — proceed to remaining gates
3. **On FAIL** — re-delegate to the same agent with reviewer feedback (up to 2 retries)
4. **On 3x FAIL** — escalate to panel review (Gate 9)

The reviewer validates: acceptance criteria met, file partition respected, no regressions, type safety, error handling, security basics, and edge cases.

**Auto-PASS conditions** (skip the reviewer sub-agent):
- Pure research/exploration with no code changes
- Only `.md` files were modified
- All deterministic gates passed AND the change is ≤10 lines across ≤2 files AND **no sensitive files were touched** (see Gate 3 sensitive file list)

> **Sensitive file override:** If any changed file falls into the sensitive file categories listed in Gate 3 (auth, migrations, security headers, env schemas, CI/CD), auto-PASS is **never** applied — even for 1-line changes. These files always get a human-quality review.

## Gate 6: Cache Clearing (BEFORE Browser Testing)

**Always clear before testing.** Testing stale code wastes time and produces false results.

Clear framework caches and task runner caches before starting the dev server for browser testing. See the **codebase-tool** skill for cache-clearing commands.

## Gate 7: Browser Testing (MANDATORY for UI Changes)

> **HARD GATE:** A task with UI changes is NOT done until you have screenshots in Chrome proving the feature works. "The code looks correct" is not proof. "Tests pass" is not proof. Only a screenshot of the working UI in Chrome is proof.

1. **Start the dev server** — use the project's serve command (see the **codebase-tool** skill) — wait for it to be ready
2. **Navigate to affected pages** — Verify the new feature renders correctly
3. **Verify features and interactions** — Confirm every acceptance-criteria item renders and behaves correctly; click buttons, fill forms, toggle filters, submit data
4. **Test responsive and edge cases** — Resize to each breakpoint; verify empty, error, and loading states
5. **Screenshot evidence (REQUIRED)** — Take screenshots of key states. These are mandatory proof

Load the **browser-testing** skill for Chrome MCP commands, breakpoint details, and reporting format.

## Gate 8: Regression Testing

New features must not break existing functionality:

1. **Run full test suite** for affected projects — not just the new tests
2. **Browser-test adjacent pages** — If you changed a shared component, test pages that use it
3. **Verify navigation** — Ensure routing, links, and back-button behavior still work
4. **Check shared components** — If a component from a shared library was modified, test it in all apps that consume it

## Gate 9: Panel Review (High-Stakes Only)

Use the **panel-majority-vote** skill for:

- Security-sensitive changes (auth flows, RLS policies, API endpoints)
- Database migrations that alter production data or schema
- Architecture decisions or large refactors affecting multiple libraries
- Complex business logic without comprehensive test coverage

If the panel returns BLOCK, extract MUST-FIX items, re-delegate to the same agent, and re-run the panel. Never skip, never halt. Max 3 attempts, then escalate to Architect.

## Gate 10: Final Smoke Test (Feature-Level)

> Runs once after ALL tasks are Done. Individual tasks pass gates 1–9 independently but the combined result may have integration issues — this gate verifies the feature as a cohesive unit.

1. **Full build** — Build all affected projects from clean state (not incremental)
2. **Full test suite** — Run tests across all projects that consumed any changed files
3. **End-to-end browser walkthrough** — All states (loading, empty, populated, error, partial), transitions, data flows, and error paths
4. **Cross-task integration check** — Verify that outputs from different tasks (e.g., DB migration + component + page) compose correctly
5. **Smoke test at all breakpoints** — If the feature has UI, one final responsive sweep

**Skip for:** non-UI features with comprehensive test coverage, or single-task features (Gate 8 already covers those).

**On failure:** re-delegate the specific failing integration point; do NOT re-run the entire feature.

## Universal Completion Checklist

Use this checklist for any orchestration workflow:

- [ ] **No secrets in diff** (Gate 1)
- [ ] Lint, test, and build pass for all affected projects (Gate 2)
- [ ] Blast radius assessed — scope is expected (Gate 3)
- [ ] Dependency audit passed if packages changed (Gate 4)
- [ ] **Fast review passed** (mandatory — load **fast-review** skill) (Gate 5)
- [ ] Dev server started with **clean cache** (Gate 6)
- [ ] UI changes verified in Chrome with screenshots at all breakpoints (Gate 7)
- [ ] Every acceptance criteria item visually confirmed — not just "page loads"
- [ ] No regressions in adjacent functionality (Gate 8)
- [ ] Panel review passed for high-stakes changes (Gate 9)
- [ ] **Final smoke test passed** for multi-task features (Gate 10)
