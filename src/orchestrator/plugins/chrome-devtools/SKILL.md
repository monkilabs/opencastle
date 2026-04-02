---
name: browser-testing
description: "Drive real browsers via Chrome DevTools MCP: navigate pages, capture snapshots, run responsive checks, and collect console/perf traces. Use when the user mentions: 'validate UI change in Chrome', 'capture a screenshot', 'run responsive checks', or 'collect console logs'. Trigger terms: browser testing, DevTools, console logs, screenshot, responsive testing"
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Browser Testing with Chrome DevTools MCP

For project-specific test app, selectors, suites, and breakpoint config, see [testing-config.md](../../.opencastle/stack/testing-config.md).


## Chrome MCP Tools Reference

### Navigation

```javascript
// Navigate to page
mcp_chrome-devtoo_navigate_page({ type: 'url', url: 'http://localhost:<port>/places' })
// Reload
mcp_chrome-devtoo_navigate_page({ type: 'reload' })
```

### Interaction

```javascript
mcp_chrome-devtoo_click({ uid: 'element_uid' })
mcp_chrome-devtoo_type({ uid: 'input_uid', text: 'search query' })
mcp_chrome-devtoo_wait_for({ text: 'Expected text' })
```

### Validation (preferred — lightweight)

```javascript
// Count elements
mcp_chrome-devtoo_evaluate_script({
  function: '() => document.querySelectorAll(".place-card").length'
})
// Check URL
mcp_chrome-devtoo_evaluate_script({
  function: '() => window.location.href'
})
// Verify element exists
mcp_chrome-devtoo_evaluate_script({
  function: '() => !!document.querySelector("[data-testid=filter-topbar]")'
})
// Get text content
mcp_chrome-devtoo_evaluate_script({
  function: '() => document.querySelector("h1")?.textContent'
})
// Check URL params
mcp_chrome-devtoo_evaluate_script({
  function: '() => new URL(window.location.href).searchParams.toString()'
})
```

### Screenshots (use sparingly — MAX 3 per session)

```javascript
mcp_chrome-devtoo_take_screenshot({ format: 'png' })
mcp_chrome-devtoo_take_snapshot()  // DOM snapshot, lighter than screenshot
```

### Performance

```javascript
mcp_chrome-devtoo_performance_start_trace({ reload: true, autoStop: true })
mcp_chrome-devtoo_performance_analyze_insight({ insightSetId: 'set_id', insightName: 'LCPBreakdown' })
```

## Testing Workflow

### 1. Setup

Start the dev server.

### 2. Initial State

```javascript
mcp_chrome-devtoo_navigate_page({ type: 'url', url: 'http://localhost:<port>/places' })
mcp_chrome-devtoo_wait_for({ text: 'places' })
// If wait_for times out: verify dev server is running and URL is correct
mcp_chrome-devtoo_evaluate_script({
  function: '() => ({ url: window.location.href, title: document.title })'
})
```

### 3–4. Test Interactions & Edge Cases

```javascript
mcp_chrome-devtoo_click({ uid: 'filter_uid' })
mcp_chrome-devtoo_evaluate_script({
  function: '() => document.querySelectorAll(".place-card").length'
})

mcp_chrome-devtoo_navigate_page({
  type: 'url', url: 'http://localhost:<port>/places?q=nonexistent-venue-xyz'
})
mcp_chrome-devtoo_evaluate_script({
  function: '() => !!document.querySelector("[data-testid=empty-state]")'
})
```

### 5. Console Error Check

```javascript
mcp_chrome-devtoo_list_console_messages()
// If errors found: fix source, rebuild, reload page, and re-run from step 2
```

### 6. Responsive Breakpoint Testing

Test every UI change at all responsive breakpoints — most layout bugs surface at smaller viewports. Define breakpoints in your project's testing config.

#### How to Resize

```javascript
// Example breakpoints — adjust to your project's testing config
mcp_chrome-devtoo_resize_page({ width: 375, height: 812 })   // Mobile
mcp_chrome-devtoo_resize_page({ width: 768, height: 1024 })  // Tablet
mcp_chrome-devtoo_resize_page({ width: 1440, height: 900 })  // Desktop
```

#### Per-Breakpoint Verification

- Verify interactions at each size (not layout only)
- Prefer `evaluate_script()` assertions over screenshots; reserve screenshots for failures

## Regression Re-Test Workflow

When re-testing after a fix:
1. Read previous `result.json` for failing tests.
2. Run build + lint to verify fix compiles.
3. Start dev server.
4. Re-run ALL tests from previous suite (fixes can regress other tests).
5. Compare results — every test must PASS.
6. Write updated `result.json`.

If any test still fails: analyze, fix, repeat. Do NOT stop.


## Context Management

- ONE focus area per session.
- MAX 3 screenshots — use `evaluate_script()` for most checks.
- Clear browser state between unrelated test flows.
