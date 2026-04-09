# Sentry Error Patterns

## Basic Capture

```typescript
import * as Sentry from '@sentry/nextjs';

// Caught error
try {
  await riskyOperation();
} catch (err) {
  Sentry.captureException(err);
}

// Custom message
Sentry.captureMessage('Payment declined', 'warning');
```

## Context Enrichment

```typescript
// Set user (persists for subsequent events in the session)
Sentry.setUser({ id: user.id, email: user.email });

// Structured context object
Sentry.setContext('order', { orderId, amount, currency });

// Searchable tag
Sentry.setTag('tenant', organizationSlug);

// Scoped enrichment (one-off, does not persist)
Sentry.withScope((scope) => {
  scope.setTag('action', 'checkout');
  scope.setContext('cart', { itemCount, total });
  scope.setLevel('fatal');
  Sentry.captureException(err);
});
```

## Breadcrumbs

```typescript
Sentry.addBreadcrumb({
  category: 'payment',
  message: 'User clicked pay button',
  level: 'info',
  data: { amount: 99.99 },
});
```

## Custom Fingerprinting

```typescript
// sentry.client.config.ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend(event) {
    // Group all DB timeout errors together regardless of query
    if (event.exception?.values?.[0]?.value?.includes('timeout')) {
      event.fingerprint = ['database-timeout'];
    }
    return event;
  },
});
```

## Error Boundaries (React / Next.js App Router)

```typescript
// app/global-error.tsx
'use client';
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <h2>Something went wrong</h2>
        <button onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
```

### Wrapping components

```typescript
import * as Sentry from '@sentry/react';

export const SafeWidget = Sentry.withErrorBoundary(MyWidget, {
  fallback: <p>This widget failed to load</p>,
});
```

## Server Action Instrumentation

```typescript
'use server';
import * as Sentry from '@sentry/nextjs';

export async function submitForm(data: FormData) {
  return await Sentry.withServerActionInstrumentation('submitForm', async () => {
    // Your server action logic here
  });
}
```
