---
name: sentry-monitoring
description: "Sentry error monitoring, SDK initialization, performance tracing, source maps, session replay, and release tracking. Use when adding Sentry to a project, capturing errors with context, setting up distributed tracing, configuring source maps, or debugging production issues."
---

# Sentry Monitoring

## Next.js

- Three separate init files, and the browser one is `instrumentation-client.ts` — not `sentry.client.config.ts` — alongside `sentry.server.config.ts` and `sentry.edge.config.ts`. `npx @sentry/wizard@latest -i nextjs` creates all three and patches `next.config.ts`.
- Source maps upload only when `next.config.ts` is wrapped in `withSentryConfig()` and `SENTRY_AUTH_TOKEN` (plus `SENTRY_ORG` / `SENTRY_PROJECT`) is present at build time, CI included.
- `tunnelRoute: '/monitoring'` proxies events through your own origin so ad-blockers stop dropping them.
- `app/global-error.tsx` reports nothing by itself — call `Sentry.captureException(error)` inside it. Wrap server actions in `Sentry.withServerActionInstrumentation('name', fn)`.

## Node / Express

`import './instrument'` must come before every other import in the process. `app.use(Sentry.expressErrorHandler())` must be the last error-handling middleware.

## Sampling and context

- `tracesSampleRate`: 1.0 dev, 0.2–0.5 low-traffic production, 0.05–0.1 high-traffic. Use `tracesSampler` returning 0 for `/health` and polling routes, ~0.5 for checkout/auth.
- `Sentry.setUser` / `setTag` / `setContext` persist for the rest of the session; `Sentry.withScope` is one-off. Re-throw after `captureException` when the caller still needs the error.
- Override issue grouping with `event.fingerprint = [...]` in `beforeSend`.
- Core Web Vitals are captured with no config. Alert thresholds: LCP > 2.5s, CLS > 0.1, INP > 200ms.
- The DSN is safe to expose client-side. `sendDefaultPii: true` captures IP, user agent, and authenticated user.

Docs: https://docs.sentry.io/
