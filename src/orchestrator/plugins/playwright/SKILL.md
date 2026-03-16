---
name: playwright-testing
description: "Playwright E2E testing patterns, cross-browser configuration, page objects, and CI setup. Use when writing E2E tests, visual regression tests, or configuring Playwright in CI pipelines."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Playwright Testing

Playwright-specific E2E testing patterns. For project-specific test configuration and breakpoints, see [testing-config.md](../../.opencastle/stack/testing-config.md).

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

## Test Structure

```
tests/
├── e2e/
│   ├── auth/
│   │   ├── login.spec.ts
│   │   └── signup.spec.ts
│   └── dashboard/
│       └── overview.spec.ts
├── fixtures/
│   └── auth.fixture.ts      # Custom test fixtures
└── pages/
    ├── login.page.ts         # Page object
    └── dashboard.page.ts
```

## Writing Tests

### Basic Test Pattern

```typescript
import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('should log in with valid credentials', async ({ page }) => {
    await page.getByTestId('email-input').fill('user@example.com');
    await page.getByTestId('password-input').fill('password123');
    await page.getByTestId('login-button').click();

    await expect(page).toHaveURL(/.*dashboard/);
    await expect(page.getByTestId('user-menu')).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.getByTestId('email-input').fill('wrong@example.com');
    await page.getByTestId('password-input').fill('wrong');
    await page.getByTestId('login-button').click();

    await expect(page.getByTestId('error-message')).toContainText('Invalid credentials');
  });
});
```

### Page Object Model

```typescript
// tests/pages/login.page.ts
import { type Page, type Locator } from '@playwright/test';

export class LoginPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(private readonly page: Page) {
    this.emailInput = page.getByTestId('email-input');
    this.passwordInput = page.getByTestId('password-input');
    this.submitButton = page.getByTestId('login-button');
    this.errorMessage = page.getByTestId('error-message');
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
```

## API Mocking

```typescript
// Mock API responses for deterministic tests
await page.route('/api/login', (route) => {
  route.fulfill({ status: 200, body: JSON.stringify({ token: 'test' }) });
});
```

## Locator Strategy

Use Playwright's built-in locators in priority order:

1. `page.getByTestId()` — most resilient
2. `page.getByRole()` — accessible, meaningful
3. `page.getByLabel()` — for form elements
4. `page.getByText()` — for unique visible text
5. `page.locator()` with CSS — last resort

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

## MCP Tools

The Playwright MCP server enables AI agents to interact with browsers directly:

| Tool | Purpose |
|------|---------|
| `playwright/navigate` | Navigate to a URL |
| `playwright/screenshot` | Take page screenshots |
| `playwright/click` | Click elements |
| `playwright/fill` | Fill form inputs |
| `playwright/evaluate` | Execute JavaScript in browser |
| `playwright/expect` | Assert page state |

## Best Practices

- Use `test.describe` to group related tests
- Use `test.beforeEach` for common setup — keep tests independent
- Prefer `getByTestId` and `getByRole` over CSS selectors
- Use `expect(locator).toBeVisible()` before interacting
- Use `page.waitForURL()` or `page.waitForResponse()` instead of arbitrary waits
- Run tests in parallel (`fullyParallel: true`) for speed
- Use `trace: 'on-first-retry'` to debug flaky tests
- Use `codegen` to bootstrap tests, then refactor into page objects
- Use `page.route()` to mock API responses — create isolated, deterministic tests without backend dependencies
