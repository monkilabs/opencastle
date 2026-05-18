---
name: performance-optimization
description: "Profiles, reduces frontend/backend costs: split bundles, optimize assets, apply caching, fix Core Web Vitals regressions. Use when profiling Lighthouse/CI regressions, reducing bundle size, or fixing high CLS/LCP/TTI metrics."
---

# Performance Optimization

**Rule:** Measure first (`Chrome DevTools`, `Lighthouse`, `Datadog`), optimize second. Set budgets (load time, memory, API latency). Automate in CI/CD.

Domain-specific patterns (rendering, JS, Node optimizations) referenced in REFERENCE.md to keep this skill concise.

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

## Executable Examples

### Dynamic import splitting (example)

```js
// Lazy-load a heavy chart only on client
import dynamic from 'next/dynamic';
const Chart = dynamic(() => import('../components/Chart'), { ssr: false, loading: () => <div>Loading chart…</div> });
export default function Page(){ return <Chart />; }
```

### React.memo + profiler pattern

```jsx
import React, { Profiler } from 'react';
const Item = React.memo(function Item({data}){ return <div>{data.title}</div>; });
function onRender(id, phase, actualDuration){ console.log(id, phase, actualDuration); }
export default function List({items}){
	return (
		<Profiler id="List" onRender={onRender}>
			{items.map(i=> <Item key={i.id} data={i} />)}
		</Profiler>
	);
}
```

## Profiling Workflow (step-by-step)

1. Run Lighthouse (or CI perf job); record baseline.
	 - Checkpoint: failing metric(s) identified (LCP/CLS/FID/TTI).
	 - Recovery: if noisy, reproduce locally with `--emulated-form-factor=mobile`.
2. Profile with DevTools Profiler / React profiler or Node `clinic` for backend.
	 - Checkpoint: hotspot call stacks / long tasks located.
3. Apply minimal fix (code-split, memoize, reduce payloads, defer non-critical work).
	 - Checkpoint: targeted change reduces measured hotspot time in profiler.
4. Re-run Lighthouse/CI perf job; compare; set threshold (e.g., 10% improvement or within budget).
5. If regression persists, iterate; create rollback plan; note fixes in changelog.

## Review Checklist

- [ ] No O(n²)+ algorithms; appropriate data structures
- [ ] Caching with correct invalidation; no N+1 DB queries
- [ ] Large payloads paginated/streamed; network requests batched
- [ ] No memory leaks or blocking ops in hot paths
- [ ] Assets optimized; memoization only where profiling shows benefit
- [ ] Benchmarks for perf-sensitive code; alerts for regressions

## References

- [web.dev/performance](https://web.dev/performance/) · [MDN Performance](https://developer.mozilla.org/en-US/docs/Web/Performance) · [Lighthouse](https://developers.google.com/web/tools/lighthouse)
