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

> Inherits: [never-expose-secrets](../../snippets/never-expose-secrets.md)

Scan every diff **before** any other gate.

Example tool: `gitleaks detect --source . --verbosity warn` (or CI equivalent) — fail on findings matching secrets rules.

## Gate 2: Deterministic Checks

Run for every affected project (resolve exact commands via **codebase-tool** skill): lint (with auto-fix), test, build. All must pass with zero errors.

Example (project with npm scripts):

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

| Check | Tool / Example Command | Pass Criteria | On Failure |
|-------|-------------------------|---------------|------------|
| Vulnerability | `npm audit --audit-level=moderate` | No new high/critical | BLOCK — use patched version or alternative |
| Bundle size | `npx source-map-explorer dist/*.js` or `npx bundlesize` | Frontend pkgs ≤50KB gzipped (project policy) | SHOULD-FIX; blocking if >200KB |

See [REFERENCE.md](REFERENCE.md) for full dependency-audit checklist (license, duplicates, maintenance, additional checks).

## Gate 5: Fast Review

Spawn reviewer sub-agent (load **fast-review** skill). PASS → proceed; FAIL → re-delegate (max 2); 3× FAIL → Gate 9. Auto-PASS rules: see **fast-review** skill.

## Gate 6: Cache Clearing

```bash
rm -rf node_modules/.cache .next/cache .astro/ dist/
```
## Gate 7: Browser Testing

UI changes require Chrome screenshots. Start dev server → verify ACs → responsive breakpoints → capture screenshots. Load **browser-testing** skill.

```json
{ "tool": "browser-testing/capture_screenshot", "url": "http://localhost:3000", "viewports": ["mobile", "desktop"] }
```

Additional options: see [REFERENCE.md](REFERENCE.md).

## Gate 8: Regression Testing

1. `npm test -- --runInBand` for all affected projects
2. Browser-test adjacent pages (navigation, routing, back-button). Identify adjacent pages by searching for route imports or links to changed path (e.g., `rg "href=\"/changed-path|import .*from '@/components/changed'"`).
3. Check consuming apps / packages importing changed files: search repo for component or package name (e.g., `rg "from '@/components/PriceRange'|@my-org/ui-package"`) and run their tests or quick smoke builds.

## Gate 9: Panel Review

Load **panel-majority-vote** skill — spawns 3 isolated reviewers, majority (2/3) wins. Use for: security-sensitive changes, DB migrations, architecture decisions.

```js
runSubagent({ agentName: 'Reviewer', prompt: `Panel review 1/3: ${criteria}` });
```

## Gate 10: Final Smoke Test

> Runs once after ALL tasks are Done.

```bash
npm run build && npm test && npx playwright test
```

Full build + test from clean state → E2E browser walkthrough → cross-task integration check → responsive sweep (if UI). On failure: re-delegate specific failing integration only.
