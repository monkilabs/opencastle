---
name: testing-workflow
description: "How to test a change: test first, what to cover, what to mock, and the anti-patterns that let tests pass without proving anything. Use when writing or planning tests, mocking a dependency, fixing a flaky test, or checking coverage."
---

# Testing Workflow

The project's test runner, its config and its commands are in the Project Context (Key Commands) and the skill bound to the **testing** slot; browser and E2E tests, in the skill bound to **e2e-testing**, and **browser-testing**.

## Test first

1. Write the test for the behaviour you are about to add or fix, and watch it fail, for the reason you expect. A test that has never failed proves nothing.
2. Write the least code that makes it pass.
3. Clean up with the test green.

A bug fix starts with a test that reproduces the bug.

## What to cover

- **Behaviour, not implementation:** inputs and outputs, what the user sees, what is stored. A refactor that keeps the behaviour keeps the tests green.
- **Past the happy path:** empty results, the boundaries, invalid input, a failing network or dependency, the same action twice.
- **That interactions change something:** assert that a control changes the result — not only that it renders — and assert the values, not a screenshot.
- **Coverage** at the threshold in the project's test config; integration tests at each boundary (API, database, URL state); E2E tests on the critical journeys.

## Mocks

Mock what you do not own — external APIs, the clock, randomness — at the boundary. Never mock the module under test, and never assert on a mock's own behaviour: that tests the mock.

## Flaky tests

No `sleep`: wait for the condition (`waitFor`, an assertion that polls). Reset state between tests. A test that fails one run in ten is a bug — fix it or delete it; never retry it into green.

## E2E in an agent session

One suite per session, at most three screenshots, a reload between flows, and the results in your answer: the suite, the counts, and each failure with its evidence.
