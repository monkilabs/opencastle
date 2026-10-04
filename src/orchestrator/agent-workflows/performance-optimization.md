<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Performance Optimization

For making something measurably faster. Never optimize without a measurement.

1. **Measure the baseline** (Performance Expert). A production build of the affected apps; Lighthouse on the key pages — the most traffic, the heaviest rendering — at least three runs, the median; the bundle size; the Core Web Vitals (LCP, INP, CLS) and TTFB; server render time.
2. **Find the bottlenecks** (Performance Expert). The top three, ranked by what the user feels: the largest chunks, client-side JavaScript that need not ship, images, caching headers, slow queries.
3. **Optimize** — in parallel where the files do not overlap: bundle and code splitting (Performance Expert), images (UI/UX Expert), data fetching and caching (Developer), indexes and query plans (Data Engineer).
4. **Verify** (Performance Expert). The same pages, the same build, the same runs: before against after, with no visual regression (browser) and no functional one (the test suite). Keep a change only if it measurably helps.

## Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
