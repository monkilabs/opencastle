---
name: validation-gates
description: "Shared validation gates for all orchestration workflows — secret scanning, deterministic checks, blast radius analysis, dependency auditing, browser testing, cache management, regression checks, and final smoke tests. Referenced by prompt templates to maintain single source of truth."
---

# Validation Gates

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

## Gate 1: Secret Scanning

> Inherits: [never-expose-secrets](../../snippets/never-expose-secrets.md)

Scan every diff **before** any other gate.

## Gate 2: Deterministic Checks

Run for every affected project (resolve exact commands via the **codebase-tool** skill): lint (with auto-fix), test, build. All must pass with zero errors.

## Gate 3: Blast Radius Check

| Metric | Normal | Warning | Escalate |
|--------|--------|---------|----------|
| Lines changed | ≤200 | 201–500 | >500 |
| Files changed | ≤5 | 6–10 | >10 |
| Projects affected | ≤1 | 2 | >2 |

- **Normal** — proceed to Gate 4
- **Warning** — log in delegation record; investigate partition drift if unexpected
- **Escalate** — STOP. Verify partition; split or revert; mandatory fast review (no auto-PASS)

**Sensitive files** (always Warning regardless of line count): auth/middleware (`middleware.ts`, `auth.ts`, `**/auth/**`), DB migrations/RLS, security headers/CSP (`next.config.*`, `vercel.json`), env schemas (`.env.example`, `env.ts`), CI/CD (`.github/workflows/**`), package configs (`package.json`, lockfiles) — also triggers Gate 4.

## Gate 4: Dependency Audit

> Runs only when `package.json`, `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, or similar lockfiles are modified.

| Check | Tool | Pass Criteria | On Failure |
|-------|------|---------------|------------|
| Vulnerability | `npm audit` | No new high/critical | BLOCK — use patched version or alternative |
| License | — | MIT, Apache-2.0, BSD-*, ISC | Flag for human review (non-blocking) |
| Bundle size | — | Frontend pkgs ≤50KB gzipped | SHOULD-FIX; blocking if >200KB |
| Duplicates | — | No overlap with existing deps | SHOULD-FIX |
| Maintenance | — | Updated <2yr, ≥100 weekly DLs | Flag |

## Gate 5: Fast Review

> **HARD GATE.** Every delegation must pass. Spawn a reviewer sub-agent; PASS → proceed; FAIL → re-delegate (up to 2 retries); 3× FAIL → Gate 9 panel. Load **fast-review** skill.

**Auto-PASS** (skip reviewer): pure research with no code changes; only `.md` files modified; all deterministic gates passed AND ≤10 lines across ≤2 files AND no sensitive files touched.

> **Sensitive file override:** Sensitive files (Gate 3 list) never get auto-PASS, even for 1-line changes.

## Gate 6: Cache Clearing

Clear framework and task runner caches before starting the dev server. See **codebase-tool** skill.

## Gate 7: Browser Testing

> **HARD GATE:** UI changes are NOT done without screenshots in Chrome proving the feature works.

1. Start dev server (see **codebase-tool** skill)
2. Verify all acceptance-criteria items render and behave correctly
3. Test responsive breakpoints; verify empty, error, and loading states
4. Capture screenshots of key states (REQUIRED)

Load the **browser-testing** skill for Chrome MCP commands, breakpoints, and reporting format.

## Gate 8: Regression Testing

1. Run full test suite for all affected projects
2. Browser-test adjacent pages; verify navigation, routing, and back-button
3. Check shared components in all consuming apps if a shared library changed

## Gate 9: Panel Review

Use the **panel-majority-vote** skill for: security-sensitive changes, DB migrations, architecture decisions/large refactors, complex business logic without comprehensive tests.

On BLOCK: extract MUST-FIX items, re-delegate, re-run panel. Max 3 attempts, then escalate to Architect.

## Gate 10: Final Smoke Test

> Runs once after ALL tasks are Done.

1. Full build + full test suite from clean state
2. End-to-end browser walkthrough (loading, empty, populated, error states, transitions)
3. Cross-task integration check
4. Final responsive sweep (if UI)

**Skip for:** non-UI with comprehensive tests, or single-task features (Gate 8 covers those). On failure: re-delegate the specific failing integration only.
