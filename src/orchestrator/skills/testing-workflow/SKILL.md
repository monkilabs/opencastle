---
name: testing-workflow
description: "Plans tests, writes unit, integration and E2E tests, finds coverage gaps and flags testing anti-patterns. Use when writing or planning tests, mocking dependencies, or checking coverage."
---

# Testing Workflow

**Mandatory:** test in a real browser via the **e2e-testing** capability slot before marking any feature complete, including every project-defined responsive breakpoint (**validation-gates** Gate 7, **browser-testing** skill).

## E2E Context Limits

| Rule | Detail |
|------|--------|
| One suite per session | never run all suites in one conversation |
| Max 3 screenshots | per session |
| `evaluate_script()` over `take_snapshot()` | returns less data |
| Reload between flows | clears state |
| Report results | in the session output: suite, pass/fail counts, failures with their evidence |

Suite files and project test config: `.opencastle/project.instructions.md`.

## Coverage

| Layer | Minimum |
|-------|---------|
| Unit (functions, components, hooks) | the threshold in the project's test config |
| Integration (boundaries, URL sync) | all boundaries |
| E2E (journeys, interactions, errors) | all critical paths |

Verify with the project's own test and coverage commands (Key Commands in `.opencastle/project.instructions.md`).

## Anti-Patterns

- Testing only initial page load — exercise state/filter changes and confirm results actually differ.
- Assuming a control works because it renders — verify each option changes results and triggers a server request.
- Single scenario — cover empty results, min/max boundaries, invalid input, network errors.
- Visual inspection only — assert data values and URL parameters programmatically.
