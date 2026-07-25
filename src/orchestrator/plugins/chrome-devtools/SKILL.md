---
name: browser-testing
description: "Drive real browsers via Chrome DevTools MCP: navigate pages, capture snapshots, run responsive checks, and collect console/perf traces. Use when the user mentions: 'validate UI change in Chrome', 'capture a screenshot', 'run responsive checks', or 'collect console logs'. Trigger terms: browser testing, DevTools, console logs, screenshot, responsive testing"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Browser Testing with Chrome DevTools MCP

Project test app, selectors, suites, and breakpoints: [testing-config.md](../../.opencastle/stack/testing-config.md). Docs: https://developer.chrome.com/docs/devtools

## Context budget — the main constraint

Screenshots are expensive. **MAX 3 per session**, reserved for failures. Assert with `evaluate_script` instead — element counts, `window.location.href`, `!!document.querySelector(...)`, `textContent`, `new URL(location.href).searchParams.toString()`. `take_snapshot` (DOM) is far lighter than `take_screenshot`. One focus area per session; clear browser state between unrelated flows.

## Tools

- `navigate_page` — `{ type: 'url', url }` or `{ type: 'reload' }`
- `click` / `type` / `wait_for` — `click` and `type` take a `uid` from a prior snapshot, not a CSS selector
- `evaluate_script` — `{ function: '() => ...' }` (an arrow function *string*, not a raw expression)
- `resize_page` — `{ width, height }`
- `list_console_messages`
- `performance_start_trace` — `{ reload: true, autoStop: true }`; then `performance_analyze_insight({ insightSetId, insightName })`

`wait_for` timing out almost always means the dev server is down or the URL is wrong — check that before debugging selectors.

## Workflow

Navigate → `wait_for` anchor text → assert via `evaluate_script` → exercise interactions → hit an edge case URL (e.g. `?q=nonexistent`) and assert the empty state → `list_console_messages` (any error: fix source, rebuild, reload, restart from navigate) → re-run at every breakpoint, verifying interactions and not just layout. Most layout bugs only appear at narrow viewports.

## Regression re-test

Read the prior `result.json`, build + lint, then re-run the **entire** previous suite — a fix routinely regresses a different test. Every test must pass before writing the updated `result.json`. Do not stop on partial green.
