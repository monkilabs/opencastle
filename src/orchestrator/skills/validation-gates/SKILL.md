---
name: validation-gates
description: "Defines the ten gates delegated work passes, from secret scanning and lint/test/build to blast radius, dependency audit, browser, regression and smoke tests. Use when deciding which checks a change needs, or whether work is ready to merge or deploy."
---

# Validation Gates

The project's commands live under Key Commands in `.opencastle/project.instructions.md`; with a task runner (Nx, Turborepo), its skill has them. Every gate below runs those, never a guessed `npm run …`.

| Gate | Name | Runs When |
|------|------|-----------|
| 1 | Secret Scanning | Every delegation |
| 2 | Deterministic Checks | Every delegation |
| 3 | Blast Radius Check | Every delegation |
| 4 | Dependency Audit | When `package.json` or lockfiles change |
| 5 | Fast Review | Every delegation (with auto-PASS exceptions) |
| 6 | Cache Clearing | Only when a stale cache is suspected |
| 7 | Browser Testing | UI changes |
| 8 | Regression Testing | Every delegation |
| 9 | Panel Review | High-stakes changes only |
| 10 | Final Smoke Test | Feature completion (after all tasks Done) |

## Gate 1: Secret Scanning

**Secret scan (Constitution rule 1).** Block on any token, key, password, or
connection string in code, logs, commits, or terminal output.

Scan for: AWS keys (`AKIA...`), API tokens (`sk-...`, `ghp_...`), private keys,
database URIs, hardcoded `password`/`secret`/`api_key`/`token` assignments
(assignments, not references), `.env` contents pasted into source, and
base64-encoded secrets.

On a hit: block, name the file and line, and re-delegate with an instruction to use
an environment variable. Already committed? Rotate it - git history is permanent.

Not a hit: obviously fake test fixtures (`sk-test-1234567890`), documentation
placeholders (`YOUR_API_KEY_HERE`), and pattern matches inside explanatory
comments.

Scan every diff **before** any other gate: `gitleaks git --redact --log-opts="main..HEAD"` for the branch's commits, `gitleaks dir <path>` for uncommitted files (or the CI equivalent). Fail on any finding.

## Gate 2: Deterministic Checks

Run the project's own lint (with auto-fix), test and build commands for every affected project. All must pass with zero errors.

## Gate 3: Blast Radius Check

| Metric | Normal | Warning | Escalate |
|--------|--------|---------|----------|
| Lines changed | ≤200 | 201–500 | >500 |
| Files changed | ≤5 | 6–10 | >10 |
| Projects affected | ≤1 | 2 | >2 |

- **Normal** — proceed
- **Warning** — log; investigate partition drift
- **Escalate** — STOP; verify partition; split or revert; no auto-PASS

**Sensitive files** (always Warning): `**/auth/**`, DB migrations, `next.config.*`, `.env*`, `.github/workflows/**`, lockfiles — also triggers Gate 4.

## Gate 4: Dependency Audit

> Runs only when `package.json`, `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, or similar lockfiles are modified.

- **Vulnerability:** `npm audit --audit-level=high` — no new high/critical, else BLOCK (patched version or alternative).
- **Bundle size:** frontend pkgs ≤50KB gzipped (project policy) — SHOULD-FIX; blocking if >200KB.

Full checklist (license, duplicates, maintenance, peer deps, type coverage) with commands: [REFERENCE.md](REFERENCE.md).

## Gate 5: Fast Review

Spawn a reviewer sub-agent (load **fast-review**). Auto-PASS rules, retries and escalation: the **fast-review** Handle Verdict table.

## Gate 6: Cache Clearing

Skip unless a stale cache is the suspect: the browser shows old output, or a build reports files that no longer exist. Then clear the framework cache (e.g. `.next/cache`, `node_modules/.cache`) and the project's own build output directory, named in its build config, and rebuild.

## Gate 7: Browser Testing

UI changes are verified in Chrome with the **browser-testing** skill (Chrome DevTools MCP: `navigate_page`, `take_snapshot`, `evaluate_script` with a `function`). Start the dev server → verify ACs → every project breakpoint → at most 3 screenshots, as evidence.

## Gate 8: Regression Testing

1. Full test suite for all affected projects.
2. Browser-test adjacent pages (navigation, routing, back-button) — find them via `rg "href=\"/changed-path|import .*from '@/components/changed'"`.
3. Find consuming apps/packages via `rg "from '@/components/PriceRange'|@my-org/ui-package"`; run their tests or smoke builds.

## Gate 9: Panel Review

Load **panel-majority-vote** — 3 isolated reviewers, majority (2/3) wins. Use for: the 3rd fast-review FAIL, security-sensitive changes, DB migrations.

## Gate 10: Final Smoke Test

> Runs once after ALL tasks are Done.

The project's full build and test commands, its E2E suite included, from a clean state → E2E browser walkthrough → cross-task integration check → responsive sweep (if UI). On failure: re-delegate specific failing integration only.
