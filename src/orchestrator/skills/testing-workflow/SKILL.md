---
name: testing-workflow
description: "Comprehensive testing workflow including test planning, unit/integration/E2E testing patterns, coverage requirements, and common testing mistakes. Use when writing tests, planning test strategies, or validating feature completeness."
---

# Testing Workflow

## Core Rules

- Validate every feature: happy paths, edge cases, error conditions, interactions.
- **Mandatory**: Test in browser via the **e2e-testing** capability slot before marking complete.

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
| Testing only initial page load | Test filter changes and different results |
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

Resolve exact commands via the **codebase-tool** skill (run tests, run with coverage, update snapshots, run affected only).
