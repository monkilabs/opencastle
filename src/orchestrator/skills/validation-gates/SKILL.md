---
name: validation-gates
description: "Defines 10 sequential validation gates: secret scanning, lint/test/build checks, blast radius analysis, dependency auditing, browser testing, cache management, regression checks, smoke tests. Use when running pre-deploy validation or CI checks, CI/CD pipelines, deployment pipeline validation, pre-merge checks, continuous integration, or pull request validation."
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

Scan every diff **before** any other gate: `gitleaks detect --source . --verbosity warn` (or CI equivalent) — fail on any findings.

## Gate 2: Deterministic Checks

Run for every affected project (resolve exact commands via **codebase-tool** skill): lint (with auto-fix), test, build. All must pass with zero errors.

```bash
npm run lint && npm test --silent && npm run build
```

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

Spawn reviewer sub-agent (load **fast-review** skill). PASS → proceed; FAIL → re-delegate (max 2); 3× FAIL → Gate 9. Auto-PASS rules: see **fast-review** skill.

## Gate 6: Cache Clearing

```bash
rm -rf node_modules/.cache .next/cache .astro/ dist/
```

## Gate 7: Browser Testing

UI changes require Chrome screenshots. Start dev server → verify ACs → responsive breakpoints → capture screenshots. Load **browser-testing** skill.

```json
{ "tool": "browser-testing/take_screenshot", "url": "http://localhost:3000", "viewports": ["mobile", "desktop"] }
```

Additional options: see [REFERENCE.md](REFERENCE.md).

## Gate 8: Regression Testing

1. Full test suite for all affected projects (resolve the command via the **codebase-tool** slot)
2. Browser-test adjacent pages (navigation, routing, back-button) — find them via `rg "href=\"/changed-path|import .*from '@/components/changed'"`.
3. Find consuming apps/packages via `rg "from '@/components/PriceRange'|@my-org/ui-package"`; run their tests or smoke builds.

## Gate 9: Panel Review

Load **panel-majority-vote** skill — spawns 3 isolated reviewers, majority (2/3) wins. Use for: security-sensitive changes, DB migrations, architecture decisions.

## Gate 10: Final Smoke Test

> Runs once after ALL tasks are Done.

```bash
npm run build && npm test && npx playwright test
```

Full build + test from clean state → E2E browser walkthrough → cross-task integration check → responsive sweep (if UI). On failure: re-delegate specific failing integration only.
