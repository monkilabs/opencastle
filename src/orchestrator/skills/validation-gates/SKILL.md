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

### What to scan

- Run regex scan for AWS keys, API tokens, private keys, database URIs, hardcoded secrets, and `password`/`secret`/`api_key`/`apiKey`/`token` assignments.
- Check for `.env` file contents copied into source and Base64-encoded secrets.

### On detection

- **BLOCK immediately** — flag file + line; re-delegate with instruction to use environment variables.
- If a secret was already committed, **rotate it immediately** — git history is permanent.

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

### Thresholds

| Metric | Normal | Warning | Escalate |
|--------|--------|---------|----------|
| Lines changed | ≤200 | 201–500 | >500 |
| Files changed | ≤5 | 6–10 | >10 |
| Projects affected | ≤1 | 2 | >2 |

### Actions

- **Normal** — proceed to Gate 4
- **Warning** — log in delegation record; if scope is unexpected, investigate partition drift before proceeding
- **Escalate** — **STOP.** Team Lead reviews diff: verify changed files are within partition; split task if needed; revert scope creep or proceed with mandatory fast review (no auto-PASS)

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

- **Vulnerability scan** — `npm audit`; no new `high` or `critical` vulnerabilities
- **License compatibility** — permit MIT, Apache-2.0, BSD-*, ISC; flag copyleft/proprietary for human review
- **Bundle size** — flag frontend packages >50KB gzipped with lighter alternatives
- **Duplicate functionality** — check for overlap with existing dependencies
- **Maintenance health** — flag packages with no updates in >2 years or <100 weekly downloads

### On failure

- **Vulnerability:** BLOCK — use patched version or alternative
- **License concern:** flag for human review; document in PR (non-blocking)
- **Size/duplicate:** SHOULD-FIX in fast review; blocking only if >200KB

## Gate 5: Fast Review (MANDATORY)

> **HARD GATE:** Every agent delegation output must pass fast review before acceptance. This is non-negotiable — even for overnight/unattended runs. Load the **fast-review** skill for the full procedure.

Spawn a reviewer sub-agent (see **fast-review** skill). On PASS → proceed. On FAIL → re-delegate with feedback (up to 2 retries). On 3x FAIL → escalate to Gate 9 panel review. Reviewer validates: acceptance criteria, partition, regressions, type safety, security, edge cases.

**Auto-PASS conditions** (skip the reviewer sub-agent):
- Pure research/exploration with no code changes
- Only `.md` files were modified
- All deterministic gates passed AND the change is ≤10 lines across ≤2 files AND **no sensitive files were touched** (see Gate 3 sensitive file list)

> **Sensitive file override:** If any changed file falls into the sensitive file categories listed in Gate 3 (auth, migrations, security headers, env schemas, CI/CD), auto-PASS is **never** applied — even for 1-line changes. These files always get a human-quality review.

## Gate 6: Cache Clearing (BEFORE Browser Testing)

**Always clear before testing.** Testing stale code wastes time and produces false results.

Clear framework caches and task runner caches before starting the dev server for browser testing. See the **codebase-tool** skill for cache-clearing commands.

## Gate 7: Browser Testing (MANDATORY for UI Changes)

> **HARD GATE:** UI changes are NOT done without screenshots in Chrome proving the feature works.

1. **Start the dev server** — see the **codebase-tool** skill; wait until ready
2. **Verify features and interactions** — confirm every acceptance-criteria item renders and behaves correctly; test all interactive elements
3. **Test responsive and edge cases** — resize to each breakpoint; verify empty, error, and loading states
4. **Screenshot evidence (REQUIRED)** — mandatory proof of key states

Load the **browser-testing** skill for Chrome MCP commands, breakpoint details, and reporting format.

## Gate 8: Regression Testing

1. **Run full test suite** for all affected projects — not just new tests
2. **Browser-test adjacent pages** and **verify navigation** — routing, links, and back-button behavior
3. **Check shared components** in all consuming apps if a shared library was modified

## Gate 9: Panel Review (High-Stakes Only)

Use the **panel-majority-vote** skill for:

- Security-sensitive changes (auth flows, RLS policies, API endpoints)
- Database migrations that alter production data or schema
- Architecture decisions or large refactors affecting multiple libraries
- Complex business logic without comprehensive test coverage

If the panel returns BLOCK, extract MUST-FIX items, re-delegate to the same agent, and re-run the panel. Never skip, never halt. Max 3 attempts, then escalate to Architect.

## Gate 10: Final Smoke Test (Feature-Level)

> Runs once after ALL tasks are Done — verifies the feature as a cohesive unit.

1. **Full build + full test suite** — all affected projects from clean state
2. **End-to-end browser walkthrough** — all states (loading, empty, populated, error), transitions, data flows
3. **Cross-task integration check** — verify outputs from different tasks compose correctly
4. **Smoke test at all breakpoints** — one final responsive sweep if the feature has UI

**Skip for:** non-UI with comprehensive test coverage, or single-task features (Gate 8 covers those). **On failure:** re-delegate the specific failing integration point only.
