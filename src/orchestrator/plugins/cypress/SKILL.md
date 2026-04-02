---
name: cypress-testing
description: "Writes Cypress E2E/component tests, configures `cy.intercept()` and `cy.session()`, authors custom commands, and wires CI artifacts. Use when creating E2E specs, component tests, or CI test pipelines. Trigger terms: cypress, e2e, component test, cy.intercept, cy.session"
---

# Cypress Testing

Cypress-specific E2E and component testing patterns. For project-specific test configuration and breakpoints, see [testing-config.md](../../.opencastle/stack/testing-config.md).

## Commands

```bash
# Interactive runner
npx cypress open

# Headless run (CI) — target a specific spec with --spec when needed
npx cypress run
```

## Workflow (install → add data-testid → write → run → CI)

1. Install and verify: `npm install --save-dev cypress` then `npx cypress verify`.
2. Add `data-testid` attributes to key elements. Write custom commands in `cypress/support/commands.ts`, configure `cy.intercept()` stubs, and author fixtures under `cypress/fixtures/`.
3. Write focused tests under `cypress/e2e/` using `data-testid` selectors. After authoring a spec, validate the setup by running a single spec: `npx cypress run --spec "cypress/e2e/auth/login.cy.ts" --headed` (quick smoke check).
4. Run locally: `npx cypress open` (interactive) or `npx cypress run` (headless). If a spec fails, re-run the failing spec directly and inspect `cypress/screenshots/` and `cypress/videos/` for evidence.
5. CI: `npx cypress run` — assert exit code 0; upload videos/screenshots on failures.


## Test Structure

Tests: `cypress/e2e/`  •  Fixtures: `cypress/fixtures/`  •  Commands: `cypress/support/commands.ts`

## Writing Tests

### E2E Test Pattern (single focused spec)

```typescript
// cypress/e2e/auth/login.cy.ts
describe('Login', () => {
  beforeEach(() => cy.visit('/login'));

  it('logs in with valid credentials and lands on dashboard', () => {
    cy.get('[data-testid="email-input"]').type('user@example.com');
    cy.get('[data-testid="password-input"]').type('password123');
    cy.get('[data-testid="login-button"]').click();

    cy.url().should('include', '/dashboard');
    cy.get('[data-testid="user-menu"]').should('be.visible');
  });
});
```

### Custom Commands

```typescript
// cypress/support/commands.ts
Cypress.Commands.add('login', (email: string, password: string) => {
  cy.session([email, password], () => {
    cy.visit('/login');
    cy.get('[data-testid="email-input"]').type(email);
    cy.get('[data-testid="password-input"]').type(password);
    cy.get('[data-testid="login-button"]').click();
    cy.url().should('include', '/dashboard');
  });
});
```

## Selector Strategy

Priority: prefer `data-testid`, then `aria-*` attributes or `role`. Avoid fragile selectors (auto-generated classes, deep CSS paths). See [REFERENCE.md](REFERENCE.md) for CI selector consistency rules.

## Best Practices (Cypress-specific and non-obvious)

- Prefer `cy.intercept()` with deterministic fixture payloads over test-time seeding for flaky network scenarios
- Use `cy.session()` with serialized auth state to speed repeatable suites; persist and reuse tokens across related specs
- Use route alias scoping (unique `@alias` names per spec) to avoid cross-test waits when running in parallel


For CI pipeline examples and `cypress.config.ts` snippets, see [REFERENCE.md](REFERENCE.md).

For advanced configuration examples and CI optimizations, see [REFERENCE.md](REFERENCE.md).
