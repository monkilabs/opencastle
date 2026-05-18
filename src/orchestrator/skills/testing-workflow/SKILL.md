---
name: testing-workflow
description: "Generates test plans, writes unit/integration/E2E test files, identifies coverage gaps, flags common testing anti-patterns. Use when writing tests, creating test suites, planning test strategies, mocking dependencies, measuring code coverage, or test planning."
---

# Testing Workflow

## Workflow

1. **Plan** — Write a test plan using the Pre-Implementation categories below.
2. **Implement** — Write unit/integration tests; run and verify passing.
3. **E2E** — Run E2E tests in browser via the **e2e-testing** capability slot.
4. **Validate** — Run the Post-Implementation Checklist.
5. **Fix loop** — If any step fails → fix → re-run from step 2.

## Core Rules

- Validate every feature: happy paths, edge cases, error conditions, interactions.
- **Mandatory**: Test in browser via **e2e-testing** capability slot before marking complete.

## E2E Context Limits

| Rule | Detail |
|------|--------|
| One suite per session | Never run all suites in one conversation |
| Max 3 screenshots | Per session |
| `evaluate_script()` over `take_snapshot()` | Returns less data |
| Reload between flows | Clears state |
| Log results | Append to `.opencastle/logs/e2e-results.md` |

Suite files: see `.opencastle/project.instructions.md`.

## Pre-Implementation Test Plan

| Category | What to cover |
|----------|---------------|
| Initial state | Page loads with defaults; components in expected state |
| User interactions | Buttons, dropdowns, filters (URL params + refetch), form validation |
| State transitions | Filter changes produce different results; loading states; backend sync |
| Edge cases | Empty results, min/max boundaries, invalid input, network errors |
| Integration | Data flow server→UI, URL params↔state, server vs client filtering |
| Responsive (MANDATORY for UI) | All breakpoints per **browser-testing** skill / **validation-gates** Gate 3 |

## Coverage Requirements

| Layer | Minimum |
|-------|---------|
| Unit (functions, components, hooks) | 95% |
| Integration (boundaries, URL sync) | All boundaries |
| E2E (journeys, interactions, errors) | All critical paths |

## Anti-Patterns

| Anti-Pattern | Correct Approach |
|---|---|
| Testing only initial page load | Test filter changes, different results |
| Assuming filters work because they render | Verify each option changes results |
| Client-side only | Verify server requests are triggered |
| Single scenario | Test urban, rural, edge, out-of-range |
| Visual inspection only | Verify data values programmatically |

## Post-Implementation Checklist

- [ ] Dev server running; app opened in browser
- [ ] All interactive elements tested
- [ ] Data changes verified (not just visual)
- [ ] Edge cases: empty states, max/min values, errors
- [ ] All project-defined responsive breakpoints checked (no overflow/breakage)
- [ ] URL parameters correct
- [ ] Screenshots taken of key scenarios

## Commands

```sh
# Unit / integration
npx vitest run --coverage          # all tests + coverage
npx vitest run src/utils.test.ts   # single file

# E2E (Playwright)
npx playwright test                # all E2E suites
npx playwright test --ui           # interactive mode
```

```ts
// Unit test with mock
import { describe, it, expect, vi } from 'vitest';
import { fetchItems } from './api';

describe('fetchItems', () => {
  it('returns filtered results', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ id: 1, name: 'test' }]))
    );
    const items = await fetchItems({ category: 'active' });
    expect(items).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('category=active'));
  });
});
```

```ts
// E2E test (Playwright)
import { test, expect } from '@playwright/test';

test('filter updates results and URL', async ({ page }) => {
  await page.goto('/items');
  await page.getByRole('combobox', { name: 'Category' }).selectOption('active');
  await expect(page).toHaveURL(/category=active/);
  await expect(page.getByRole('listitem')).not.toHaveCount(0);
});
```

## References

| Resource | Purpose |
|----------|--------|
| **browser-testing** skill | Chrome DevTools automation for E2E |
| **validation-gates** Gate 3 | Responsive breakpoint checks |
| `project.instructions.md` | Suite files, project-specific test config |
