---
name: performance-optimization
description: "Profiles, reduces frontend/backend costs: split bundles, optimize assets, apply caching, fix Core Web Vitals regressions. Use when profiling Lighthouse/CI regressions, reducing bundle size, or fixing high CLS/LCP/TTI metrics."
---

# Performance Optimization

Measure before changing anything. Add `React.memo`/`useMemo`/`useCallback` only after a profile shows the cost — never speculatively. Set budgets (load time, memory, API latency) and enforce them in CI.

## Rules

- Node: async APIs only — never `readFileSync` or other sync I/O on a request path.
- Debounce input-driven fetches at 300 ms.
- INP replaced FID as a Core Web Vital in March 2024: budget it at ≤200 ms, and measure every interaction, not just the first.
- Profile Node with `clinic.js` or `node --inspect`; profile React with `<Profiler onRender>` or the DevTools Profiler.

## Profiling Workflow

1. Lighthouse (or the CI perf job) for a baseline; name the failing metric (LCP/CLS/INP/TTI). Lighthouse emulates mobile by default; pass `--preset=desktop` when the regression is desktop-only.
2. Profile to locate the hotspot call stacks / long tasks.
3. Apply the minimal fix (code-split, memoize, shrink payloads, defer non-critical work); confirm in the profiler that the measured hotspot actually shrank.
4. Re-run Lighthouse / the CI perf job. Ship only at ≥10% improvement or once inside budget.
5. If the regression persists, iterate and record a rollback plan; note fixes in the changelog.
