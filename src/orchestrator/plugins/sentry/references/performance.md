# Sentry Performance Tracing

## Sampling Configuration

```typescript
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Sample 10% of transactions in production
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  // Dynamic sampling based on transaction name
  tracesSampler: (samplingContext) => {
    if (samplingContext.name?.includes('/health')) return 0; // never sample health checks
    if (samplingContext.name?.includes('/checkout')) return 0.5;
    return 0.1;
  },
});
```

## Custom Spans

```typescript
import * as Sentry from '@sentry/nextjs';

const result = await Sentry.startSpan(
  { name: 'process-payment', op: 'payment.process' },
  async (span) => {
    span.setAttribute('payment.provider', 'stripe');
    span.setAttribute('payment.amount', amount);
    return await stripe.charges.create({ /* ... */ });
  }
);

// Nested span inside an existing transaction
await Sentry.startSpan({ name: 'db.query', op: 'db' }, async () => {
  return await db.select().from(orders).where(eq(orders.id, orderId));
});
```

## Distributed Tracing

Sentry propagates trace context automatically via `sentry-trace` and `baggage` HTTP headers when using `fetch` or Node.js `http`. Verify in the trace view that frontend and backend spans are linked under the same trace ID.

For manual header forwarding:
```typescript
import * as Sentry from '@sentry/node';

const headers = {};
Sentry.getActiveSpan()?.toTraceparent() // inject into outgoing request headers
```

## Core Web Vitals

Captured automatically by the browser SDK — no extra config needed. View in Sentry → Performance → Web Vitals. Configure alerts for regressions:
- LCP > 2.5s (Largest Contentful Paint)
- CLS > 0.1 (Cumulative Layout Shift)
- INP > 200ms (Interaction to Next Paint)

## Sampling Recommendations

| Scenario | `tracesSampleRate` |
|----------|--------------------|
| Development | `1.0` |
| Low-traffic production | `0.2`–`0.5` |
| High-traffic production | `0.05`–`0.1` |
| Critical flows (checkout, auth) | Use `tracesSampler` to return `0.5` |
| Health check / polling routes | Use `tracesSampler` to return `0` |
