---
name: playwright-testing
description: "Playwright E2E testing patterns, cross-browser configuration, page objects, and CI setup. Use when creating E2E specs, visual regression suites, or configuring Playwright in CI. Trigger terms: playwright, e2e, trace, page object, cross-browser"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Playwright Testing

Project test config and breakpoints: [testing-config.md](../../.opencastle/stack/testing-config.md). Docs: https://playwright.dev/docs/intro

Layout: specs `tests/e2e/{feature}/`, page objects `tests/pages/`, fixtures `tests/fixtures/`.

## Locator priority

`getByRole(role, { name })` → `getByLabel()` for inputs → `getByTestId()` for containers → `getByText()` → `page.locator(css)` **only** when no semantic alternative exists.

## Gotchas

- Page objects must hold no module-level/global state. Parallel workers share the process, so a singleton leaks state between tests and produces order-dependent failures.
- `trace: 'on-first-retry'` costs nothing on green runs — enable it for flaky suites and attach the trace ID to failure tickets.
- Visual diffs: snapshot only stable regions and `mask` dynamic content, otherwise every run diffs.
- `forbidOnly: !!process.env.CI` prevents a stray `test.only` from silently shrinking the CI suite to one test.
- `webServer.reuseExistingServer: !process.env.CI` — locally reuses your dev server; in CI it must start its own.
- `retries: 2` and `workers: 1` in CI trade wall-clock for determinism.
- Mock at the network layer: `await page.route('/api/login', route => route.fulfill({ status: 200, body: ... }))`.

## Commands

```bash
npx playwright test --ui                      # interactive iteration
npx playwright test auth.spec.ts              # single spec
npx playwright test --project=chromium        # one browser
npx playwright test --grep "login"            # filter by title
npx playwright test --debug                   # step through
npx playwright codegen http://localhost:3000  # record a spec
npx playwright show-report                    # HTML report (verify 0 failures)
npx playwright install                        # browsers — required on a fresh machine/CI
```

`projects` in `playwright.config.ts` map to `devices[...]` presets (`Desktop Chrome`, `Desktop Firefox`, `Desktop Safari`, `iPhone 14`).
