<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Refactoring

For improving code without changing what it does.

1. **Scope and baseline** (Team Lead). Every file and module in scope; the current behaviour (test output, API responses, screenshots for UI); the test count, coverage, lint and bundle size, run now.
2. **Close the coverage gap** (Testing Expert). Tests for the existing behaviour of everything in scope, written *before* the refactor, all passing.
3. **Refactor** (the specialist for the area). Inside the scoped files only; public interfaces and behaviour unchanged; lint and type-check after each significant step; one concern per commit.
4. **Verify** (Team Lead and Testing Expert). The full test suite, lint and build; the metrics against the baseline; a UI refactor checked in the browser at every breakpoint; nothing that depends on the code broken.
5. **Panel** — over 10 files, a shared library's interface, or auth and security code: **panel-majority-vote**, asking "Does this refactoring keep all existing behaviour?"

## Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
