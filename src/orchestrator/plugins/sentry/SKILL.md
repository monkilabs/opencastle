---
name: sentry-monitoring
description: "Sentry error monitoring, SDK initialization, performance tracing, source maps, session replay, and release tracking. Use when adding Sentry to a project, capturing errors with context, setting up distributed tracing, configuring source maps, or debugging production issues."
---

# Sentry Monitoring

## Topic Routing

Read the matching reference before writing code for any of these topics:

| Topic | Reference |
|-------|-----------|
| SDK setup & initialization | `references/sdk-setup.md` |
| Error capture & context enrichment | `references/error-patterns.md` |
| Performance tracing & spans | `references/performance.md` |

## Critical Rules

**SDK Initialization**
- Next.js requires separate init files: `instrumentation-client.ts` (browser), `sentry.server.config.ts` (Node), `sentry.edge.config.ts` (edge runtime)
- Call `Sentry.init()` as early as possible — before any other imports that might throw
- Set `sendDefaultPii: true` to capture authenticated user context automatically
- Use `npx @sentry/wizard@latest -i nextjs` for guided setup; it creates all init files and patches `next.config.ts`

**Error Capture**
- Use `Sentry.captureException(err)` for caught errors; uncaught errors are captured automatically
- Enrich errors with `Sentry.setContext()`, `Sentry.setTag()`, `Sentry.setUser()` before or inside the capture call
- Add breadcrumbs with `Sentry.addBreadcrumb()` to build a debugging trail leading to the error
- Override fingerprinting via `event.fingerprint` in `beforeSend` to control issue grouping

**Performance**
- Set `tracesSampleRate: 1.0` in development, `0.1` (or lower) in production to control costs
- Use `Sentry.startSpan()` for custom instrumentation around expensive operations
- Core Web Vitals are captured automatically by the browser SDK — no extra config needed

**Source Maps**
- Wrap `next.config.ts` with `withSentryConfig()` to auto-upload source maps at build time
- Set `SENTRY_AUTH_TOKEN` in CI environment; generate at Organization Settings → Auth Tokens
- Enable `tunnelRoute: '/monitoring'` to proxy Sentry requests through your server and avoid ad-blockers

**Releases & Replay**
- Associate commits by setting `SENTRY_RELEASE` or letting the wizard configure it automatically
- Enable Session Replay with `replaysSessionSampleRate` and `replaysOnErrorSampleRate` for visual debugging
- Never expose the DSN in server-side code that handles secrets — DSN is safe for client-side use only

## Next.js Init Pattern

```typescript
// instrumentation-client.ts (browser) — mirrors sentry.server.config.ts / sentry.edge.config.ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  sendDefaultPii: true,
  // Browser-only options:
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],
});
```

## Capture with Context

```typescript
import * as Sentry from '@sentry/nextjs';

try {
  await processOrder(orderId);
} catch (err) {
  Sentry.withScope((scope) => {
    scope.setTag('action', 'process-order');
    scope.setContext('order', { orderId, userId });
    Sentry.captureException(err);
  });
  throw err; // re-throw after capturing
}
```

## Reference Files

- `references/sdk-setup.md` — Init patterns for Next.js, React, Node.js; wizard usage; config options
- `references/error-patterns.md` — captureException, context enrichment, breadcrumbs, fingerprinting, error boundaries
- `references/performance.md` — tracesSampleRate, startSpan, distributed tracing, custom instrumentation

## Quick Workflow: Add Sentry to a Next.js app
1. Run `npx @sentry/wizard@latest -i nextjs` — select your Sentry org and project when prompted
2. Wizard creates `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, and patches `next.config.ts`
3. Set `NEXT_PUBLIC_SENTRY_DSN` in `.env.local` and `SENTRY_AUTH_TOKEN` in `.env.local` (and CI secrets)
4. Adjust `tracesSampleRate` in each init file — verify Sentry receives a test event before merging
5. Add `global-error.tsx` and call `Sentry.captureException` inside it for App Router error boundaries
   - **If events not appearing:** check DSN matches the project → verify `tunnelRoute` is configured → confirm `SENTRY_AUTH_TOKEN` is set for source map uploads
   - **If source maps missing:** confirm `withSentryConfig` wraps the Next.js config → check build logs for upload errors
