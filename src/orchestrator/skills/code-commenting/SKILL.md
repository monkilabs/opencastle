---
name: code-commenting
description: "Guidelines for writing self-explanatory code with minimal comments. Covers when to comment (WHY not WHAT), anti-patterns to avoid, annotation tags, public API documentation. Use when writing or reviewing code comments, docstrings, TODO/FIXME tags, code readability, or inline comments."
---

# Code Commenting

**Comment WHY, not WHAT.** Prefer renaming over commenting.

## When to Comment

| Situation | Action |
|-----------|--------|
| Self-explanatory code | No comment |
| Bad name is the real problem | Rename instead |
| Complex business logic / non-obvious algorithm | Comment WHY |
| Regex, API constraints, gotchas | Comment WHY |
| Public API function/method | JSDoc |
| Magic number / config constant | Inline rationale |

## Examples

```javascript
// ✗ Obvious
let counter = 0; // Initialize counter to zero

// ✓ WHY
// Apply progressive tax brackets: 10% up to 10k, 20% above
const tax = calculateProgressiveTax(income, [0.1, 0.2], [10000]);

// ✓ Algorithm rationale
// Floyd-Warshall: need all-pairs distances, not just single-source
for (let k = 0; k < vertices; k++) { /* ... */ }

// ✓ API constraint
// GitHub API: 5000 req/hr for authenticated users
await rateLimiter.wait();

// ✓ Config rationale
const MAX_RETRIES = 3;     // network reliability baseline
const API_TIMEOUT = 5000;  // Lambda max is 15 s — leave headroom
```

## Public APIs — JSDoc

```javascript
/**
 * @param principal - Initial amount
 * @param rate - Annual rate as decimal (0.05 = 5%)
 * @param time - Years
 * @param n - Compounds per year (default 1)
 * @returns Final amount
 */
function calculateCompoundInterest(principal, rate, time, n = 1) { ... }
```

## Annotation Tags

| Tag | Use |
|-----|-----|
| `TODO` | Planned work |
| `FIXME` | Known bug needing fix |
| `HACK` | Workaround — note why and when to remove |
| `NOTE` | Important non-obvious constraint |
| `WARNING` | Side effect / mutation risk |
| `PERF` | Hot path — optimization opportunity |
| `SECURITY` | Security-sensitive code |
| `DEPRECATED` | Note replacement and removal version |

## Anti-Patterns

| Anti-pattern | Rule |
|--------------|------|
| Commented-out code | Delete it — git has history |
| Changelog in comments | Use git log |
| Decorative dividers | Use proper file/section structure |

## Checklist

- [ ] Explains WHY, not WHAT
- [ ] Still accurate after change
- [ ] Adds genuine value
- [ ] Placed above code it describes
