---
name: playwright-testing
description: "Playwright E2E testing patterns, cross-browser configuration, page objects, and CI setup. Use when creating E2E specs, visual regression suites, or configuring Playwright in CI. Trigger terms: playwright, e2e, trace, page object, cross-browser"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Playwright Testing

For project-specific test configuration and breakpoints, see [testing-config.md](../../.opencastle/stack/testing-config.md).

## Commands

```bash
npx playwright test                       # Run all tests
npx playwright test --ui                  # Open interactive UI mode
npx playwright test --headed              # Run with visible browsers
npx playwright test auth.spec.ts          # Run specific spec
npx playwright test --project=chromium    # Run in specific browser
npx playwright test --grep "login"        # Filter by test name
npx playwright test --debug               # Step-through debugging
npx playwright codegen http://localhost:3000  # Generate tests from actions
npx playwright show-report                # View HTML test report
npx playwright install                    # Install browsers
```

## File Conventions

Tests: `tests/e2e/{feature}/`, page objects: `tests/pages/`, fixtures: `tests/fixtures/`.

## Writing Tests

### Basic Test Pattern

```ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login-page';

test.describe('Login', () => {
  test('submits valid credentials', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.fill('user@example.com', 'password123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
  });
});
```

## API Mocking

```typescript
// Mock API responses for deterministic tests
await page.route('/api/login', (route) => {
  route.fulfill({ status: 200, body: JSON.stringify({ token: 'test' }) });
});
```

## Locator Strategy

Prefer semantic locators; avoid brittle CSS selectors:

```ts
page.getByRole('button', { name: 'Sign in' })   // preferred: ARIA role + accessible name
page.getByLabel('Email address')                  // form inputs by label
page.getByTestId('login-form')                    // test-id for complex containers
page.getByText('Welcome back')                    // visible text
page.locator('[data-state="open"]')               // CSS only when no semantic alternative
```

## Quick Workflow: Write → Run → Debug → Verify
1. Write a focused spec using page objects and `test.describe`.
2. Run locally with `npx playwright test --ui` to iterate interactively.
3. On failure: collect a trace (`trace: 'on-first-retry'`), save an HTML report, and inspect via `npx playwright show-report`.
4. Validation checkpoint: confirm `npx playwright show-report` shows 0 failures and that saved traces contain the failing trace id.
5. Fix the test or app; re-run the spec and verify the HTML report is green.

## Configuration (playwright.config.ts)

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile', use: { ...devices['iPhone 14'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

See REFERENCE.md for MCP tools and advanced config (moved to a referenced file).
## Best Practices (non-obvious)

- Use `trace: 'on-first-retry'` selectively for flaky suites; attach trace IDs to failure tickets
- Favor page-object reuse across specs but avoid global singletons that leak state between parallel workers
- For CI visual diffs, snapshot only stable regions and mask dynamic content before comparison
