---
name: testing-workflow
description: "Generates test plans, writes unit/integration/E2E test files, identifies coverage gaps, flags common testing anti-patterns. Use when writing tests, creating test suites, planning test strategies, mocking dependencies, measuring code coverage, or test planning."
---

# Testing Workflow

**Mandatory:** test in a real browser via the **e2e-testing** capability slot before marking any feature complete, including every project-defined responsive breakpoint (**validation-gates** Gate 3, **browser-testing** skill).

## E2E Context Limits

| Rule | Detail |
|------|--------|
| One suite per session | never run all suites in one conversation |
| Max 3 screenshots | per session |
| `evaluate_script()` over `take_snapshot()` | returns less data |
| Reload between flows | clears state |
| Log results | append to `.opencastle/logs/e2e-results.md` |

Suite files and project test config: `.opencastle/project.instructions.md`.

## Coverage Minimums

| Layer | Minimum |
|-------|---------|
| Unit (functions, components, hooks) | 95% |
| Integration (boundaries, URL sync) | all boundaries |
| E2E (journeys, interactions, errors) | all critical paths |

Verify with `npx vitest run --coverage`; E2E via `npx playwright test`.

## Anti-Patterns

- Testing only initial page load — exercise state/filter changes and confirm results actually differ.
- Assuming a control works because it renders — verify each option changes results and triggers a server request.
- Single scenario — cover empty results, min/max boundaries, invalid input, network errors.
- Visual inspection only — assert data values and URL parameters programmatically.
