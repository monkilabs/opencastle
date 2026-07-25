<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Performance Optimization

Measure-first optimization workflow. Never optimize without profiling data.

## Phases

```
Phase 1: Baseline Measurement    (sub-agent, inline)
Phase 2: Analysis                (sub-agent, inline)
Phase 3: Optimization            (background agents, parallel)
Phase 4: Verification            (sub-agent, inline)
Phase 5: Delivery                (direct, Team Lead)
```

---

## Branch & Delivery Strategy

Follow the **Delivery Outcome** in `general.instructions.md` and the **Branch Ownership** rules in `team-lead.agent.md`. Branch naming: `perf/<ticket-id>-<short-description>` or `feat/<ticket-id>-<short-description>`.

---

## Phase 1: Baseline Measurement

**Agent:** Performance Expert (via sub-agent)
**Type:** Sub-agent (inline)

### Steps

1. Build the affected app(s) with production config
2. Run Lighthouse audit on key pages
3. Measure bundle size (production build output — see the **codebase-tool** skill for the build command)
4. Record Core Web Vitals: LCP, FID/INP, CLS, TTFB
5. Profile server-side rendering time
6. Document baseline metrics

### Key Pages to Measure

> See `project.instructions.md` for the app inventory and key routes. Prioritize pages with the most traffic and the most complex rendering.

### Exit Criteria

- [ ] Baseline metrics recorded for all key pages
- [ ] Bundle size documented
- [ ] Lighthouse scores saved
- [ ] Tracker issue created with targets

---

## Phase 2: Analysis

**Agent:** Performance Expert (via sub-agent)
**Type:** Sub-agent (inline)

### Steps

1. Identify the top 3 performance bottlenecks
2. Analyze bundle composition (largest chunks)
3. Check for unnecessary client-side JavaScript
4. Review image optimization (WebP/AVIF, lazy loading, sizing)
5. Check caching headers and ISR configuration
6. Review database query performance (if applicable)
7. Prioritize optimizations by impact/effort

### Exit Criteria

- [ ] Top 3 bottlenecks identified with evidence
- [ ] Optimization plan created (ordered by impact)
- [ ] Each optimization has expected improvement estimate
- [ ] File partitions mapped for parallel work

---

## Phase 3: Optimization (Parallel)

**Agents:** Varies by optimization type
**Type:** Background agents (parallel where file partitions allow)

### Typical Tracks

| Track | Agent | Focus | Files |
|-------|-------|-------|-------|
| A: Bundle | Performance Expert | Code splitting, tree shaking, dynamic imports | `app/`, `libs/` |
| B: Images | UI/UX Expert | Image optimization, lazy loading, srcset | `components/`, `public/` |
| C: Queries | Developer | Query optimization, caching | Query library, framework config |
| D: Database | Data Engineer | Index optimization, query planning | Database migrations |

### Exit Criteria (per track)

- [ ] Optimization implemented
- [ ] Lint + test + build pass
- [ ] Output contract with before/after metrics

---

## Phase 4: Verification

**Agent:** Performance Expert (via sub-agent)
**Type:** Sub-agent (inline)

### Steps

1. Rebuild with production config
2. Re-run Lighthouse on same pages as Phase 1
3. Compare metrics: before vs. after
4. Verify no visual regressions (browser test)
5. Confirm no functional regressions (test suite)
6. Document results

### Exit Criteria

- [ ] Metrics improved (or justified why not)
- [ ] No visual regressions
- [ ] No functional regressions
- [ ] Results documented in tracker issue
- [ ] Roadmap updated
- [ ] Delivery Outcome completed (see `general.instructions.md`) — branch pushed, PR opened (not merged), tracker linked

---

### Phase 5: Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
>
> Commit → Push → PR → tracker linkage. Team Lead owns delivery.
