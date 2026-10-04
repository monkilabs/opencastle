---
name: browser-testing
description: "Browser testing through the Chrome DevTools MCP: navigation, DOM snapshots, scripted assertions, responsive checks, console and performance traces. Use when verifying a UI change in Chrome, checking breakpoints, or reading console errors."
---

# Browser Testing with Chrome DevTools MCP

Project test app, selectors, suites, and breakpoints: `.opencastle/stack/testing-config.md`. Docs: https://developer.chrome.com/docs/devtools

## Context budget — the main constraint

Screenshots are expensive. **MAX 3 per session**, reserved for evidence: a failure, a bug before and after its fix, a layout at its breakpoints. Assert everything else with `evaluate_script` — element counts, `window.location.href`, `!!document.querySelector(...)`, `textContent`, `new URL(location.href).searchParams.toString()`. `take_snapshot` (DOM) is far lighter than `take_screenshot`. One focus area per session; clear browser state between unrelated flows.

## Tools

- `navigate_page` — `{ type: 'url', url }` or `{ type: 'reload' }`
- `click` / `fill` / `wait_for` — `click` and `fill` take a `uid` from a prior snapshot, not a CSS selector
- `evaluate_script` — `{ function: '() => ...' }` (an arrow function *string*, not a raw expression)
- `resize_page` — `{ width, height }`
- `list_console_messages`
- `performance_start_trace` — `{ reload: true, autoStop: true }`; then `performance_analyze_insight({ insightSetId, insightName })`

`wait_for` timing out almost always means the dev server is down or the URL is wrong — check that before debugging selectors.

## Workflow

Navigate → `wait_for` anchor text → assert via `evaluate_script` → exercise interactions → hit an edge case URL (e.g. `?q=nonexistent`) and assert the empty state → `list_console_messages` (any error: fix source, rebuild, reload, restart from navigate) → re-run at every breakpoint, verifying interactions and not just layout. Most layout bugs only appear at narrow viewports.

## Regression re-test

Build + lint, then re-run the **entire** previous suite — a fix routinely regresses a different test. Every test must pass before reporting the result in the session output. Do not stop on partial green.
