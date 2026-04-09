# Sentry SDK Setup

## Next.js (recommended: wizard)

```bash
npx @sentry/wizard@latest -i nextjs
```

The wizard creates three init files and patches `next.config.ts` automatically.

### Manual init files

**`instrumentation-client.ts`** (browser):
```typescript
import * as Sentry from '@sentry/nextjs';
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: true,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],
});
```

**`sentry.server.config.ts`** (Node.js server):
```typescript
import * as Sentry from '@sentry/nextjs';
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: true,
});
```

**`sentry.edge.config.ts`** (edge runtime):
```typescript
import * as Sentry from '@sentry/nextjs';
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
});
```

**`next.config.ts`**:
```typescript
import { withSentryConfig } from '@sentry/nextjs';
const nextConfig = { /* your config */ };
export default withSentryConfig(nextConfig, {
  org: 'your-org',
  project: 'your-project',
  tunnelRoute: '/monitoring',
  sourcemaps: { disable: false },
});
```

## React (Vite / CRA)

```typescript
// main.tsx
import * as Sentry from '@sentry/react';
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});
```

## Node.js / Express

```typescript
// instrument.ts — import BEFORE any other module
import * as Sentry from '@sentry/node';
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
});
```

```typescript
// index.ts
import './instrument';
import express from 'express';
// ... app setup
app.use(Sentry.expressErrorHandler()); // must be last error-handling middleware
```

## Key Config Options

| Option | Purpose |
|--------|---------|
| `dsn` | Project DSN — safe for client-side |
| `tracesSampleRate` | 0–1 fraction of transactions to sample |
| `sendDefaultPii` | Capture IP, user agent, authenticated user |
| `environment` | `production` / `staging` — filters in Sentry UI |
| `release` | Version string for suspect commits |
| `tunnelRoute` | Proxy path to avoid ad-blockers |
| `debug` | Log Sentry internals (dev only) |

## Environment Variables

| Variable | Required by |
|----------|------------|
| `NEXT_PUBLIC_SENTRY_DSN` | Browser + server init |
| `SENTRY_AUTH_TOKEN` | Source map upload (CI + local build) |
| `SENTRY_ORG` | `withSentryConfig` / CLI |
| `SENTRY_PROJECT` | `withSentryConfig` / CLI |
