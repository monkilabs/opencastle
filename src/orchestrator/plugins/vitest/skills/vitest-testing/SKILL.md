---
name: vitest-testing
description: "Vitest gotchas for mocking, timers, type tests and coverage. Use when writing or debugging Vitest tests, configuring vitest.config, or a coverage threshold fails."
---

# Vitest Testing

Project test configuration: `.opencastle/stack/testing-config.md`. Coverage thresholds, environment and setup files: the project's `vitest.config.*` (or the `test` block of `vite.config.*`) — read them, never assume a number.

## Running

- `vitest` alone starts **watch mode** in a terminal and never exits. Agents run `vitest run [file] [-t "name"]`.
- Type tests (`*.test-d.ts`, `expectTypeOf`) run with `vitest --typecheck` (or `vitest run --typecheck`). The old `vitest typecheck` subcommand is gone since 1.0.
- Coverage: `vitest run --coverage`. Below threshold → read the uncovered lines in the text report, add tests for those branches, re-run.

## Mocking gotchas

- **`vi.mock()` is hoisted** above every import, so its factory cannot use variables declared in the file. Declare them with `vi.hoisted()`:

  ```ts
  const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }))
  vi.mock('./database', () => ({ getUser }))
  ```

- Partial mock: `vi.mock('./config', async (importOriginal) => ({ ...(await importOriginal<typeof import('./config')>()), API_URL: 'http://test' }))`.
- `vi.spyOn(namespace, 'fn')` on a module's export misses calls made inside that module, and fails in Browser Mode; mock the module instead.
- **`vi.restoreAllMocks()` only restores `vi.spyOn` spies** (Vitest 3+). It does not reset `vi.fn()` call history; use `vi.clearAllMocks()`, or `restoreMocks` / `clearMocks` in the config, so state cannot leak between tests.
- Fake timers: `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`; advance with `vi.advanceTimersByTime(ms)` or `await vi.advanceTimersByTimeAsync(ms)` when promises are involved.
- One file needs a DOM in a `node` project: `// @vitest-environment jsdom` on its first line.
