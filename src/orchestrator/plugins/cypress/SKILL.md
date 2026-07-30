---
name: cypress-testing
description: "Writes Cypress E2E/component tests, configures `cy.intercept()` and `cy.session()`, authors custom commands, and wires CI artifacts. Use when creating E2E specs, component tests, or CI test pipelines. Trigger terms: cypress, e2e, component test, cy.intercept, cy.session"
---

# Cypress Testing

Project test config and breakpoints: [testing-config.md](../../.opencastle/stack/testing-config.md). Docs: https://docs.cypress.io

## Layout

Specs `cypress/e2e/` • fixtures `cypress/fixtures/` • custom commands `cypress/support/commands.ts` • failure artifacts `cypress/screenshots/` and `cypress/videos/`.

## Gotchas

- `cy.session(key, setupFn)` caches and restores auth state across specs — the cache key must include every credential that changes the session, or you will silently reuse the wrong user.
- Give each spec **unique** `@alias` names for `cy.intercept()` routes. Shared alias names cause cross-test `cy.wait()` collisions when specs run in parallel.
- Prefer `cy.intercept()` with fixed fixture payloads over seeding real data — it is the only reliable fix for network flake.
- Selector priority: `data-testid` → `aria-*` / `role`. Never auto-generated classes or deep CSS paths.
- After `npm install --save-dev cypress`, run `npx cypress verify` — a corrupted binary cache fails later with confusing errors.

## Commands

```bash
npx cypress open                                              # interactive
npx cypress run                                               # headless / CI, assert exit 0
npx cypress run --spec "cypress/e2e/auth/login.cy.ts" --headed # single-spec smoke check
```

On failure, re-run the failing spec alone and inspect the screenshot/video artifacts. In CI, upload those artifacts only on failure.
