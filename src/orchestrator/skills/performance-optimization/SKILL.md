---
name: performance-optimization
description: "Frontend and backend performance optimization patterns including rendering, asset optimization, JavaScript performance, caching, profiling, and code review checklist. Use when optimizing components, reviewing code for performance, or analyzing bundle size and Core Web Vitals."
---

# Performance Optimization

**Rule:** Measure first (`Chrome DevTools`, `Lighthouse`, `Datadog`), optimize second. Set budgets (load time, memory, API latency). Automate in CI/CD.

## Patterns by Domain

| Domain | Key patterns |
|--------|-------------|
| **Rendering** | `React.memo`/`useMemo`/`useCallback` only after profiling; stable `key` props; CSS classes over inline styles; CSS animations (GPU); `requestIdleCallback` for non-critical work |
| **Assets** | WebP/AVIF images; SVG icons; bundle+minify+tree-shake (esbuild/Rollup); `loading="lazy"`; dynamic imports; long-lived cache headers + cache-busting; font subsetting + `font-display: swap` |
| **JS** | Web Workers for heavy computation; debounce/throttle events; clean up listeners/intervals; `Map`/`Set` for lookups; `TypedArray` for numeric data |
| **Node.js** | Async APIs only (never `readFileSync` in prod); clustering/worker threads for CPU; streams for large I/O; profile with `clinic.js` / `node --inspect` |

## Debounce Example

```js
// BAD: fetch on every keystroke
input.addEventListener('input', (e) => fetch(`/search?q=${e.target.value}`));
// GOOD: debounced 300 ms
let t; input.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => fetch(`/search?q=${e.target.value}`), 300); });
```

## Review Checklist

- [ ] No O(n²)+ algorithms; appropriate data structures
- [ ] Caching with correct invalidation; no N+1 DB queries
- [ ] Large payloads paginated/streamed; network requests batched
- [ ] No memory leaks or blocking ops in hot paths
- [ ] Assets optimized; memoization only where profiling shows benefit
- [ ] Benchmarks for perf-sensitive code; alerts for regressions

## References

- [web.dev/performance](https://web.dev/performance/) · [MDN Performance](https://developer.mozilla.org/en-US/docs/Web/Performance) · [Lighthouse](https://developers.google.com/web/tools/lighthouse)
