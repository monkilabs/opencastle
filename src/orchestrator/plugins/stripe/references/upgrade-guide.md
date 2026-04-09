# Stripe Upgrade Guide

Version-specific guidance for upgrading Stripe API versions and SDKs.

The latest Stripe API version is **2026-03-25.dahlia**. Use this version when upgrading unless a different target is specified.

Review the [API Changelog](https://docs.stripe.com/changelog) for all changes between your current and target versions before starting.

## Pinning the API Version

Always specify the API version explicitly:

```javascript
const stripe = require('stripe')('sk_test_xxx', {
  apiVersion: '2026-03-25.dahlia',
});
```

For strongly-typed languages (Java, Go, .NET), update the SDK package version instead of overriding — the API version is fixed to the SDK release.

## Stripe.js & Mobile SDKs

Stripe.js uses an evergreen model with biannual major releases. Each version auto-pairs with its API version — no override possible.

```html
<script src="https://js.stripe.com/dahlia/stripe.js"></script>
```

Mobile SDKs (iOS, Android, React Native) work with any backend API version unless docs specify otherwise. Update via your package manager.

## Handling Breaking Changes

Search the codebase for removed/renamed fields listed in the changelog before making any SDK or version changes.

```typescript
// 2022-11-15: charges no longer expanded on PaymentIntent
// Before:
const charge = paymentIntent.charges.data[0];
// After: retrieve via latest_charge
const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
```

Key patterns:
- Field renames/removals → update all call sites
- Nested expansion changes → switch to explicit `.retrieve()` calls
- List endpoint changes → switch to auto-pagination methods

## Version-Specific Breaking Changes

### PaymentIntent.charges Removal (2022-11-15)

```typescript
// Before:
const charge = paymentIntent.charges.data[0];
// After: retrieve via latest_charge
const charge = await stripe.charges.retrieve(paymentIntent.latest_charge as string);
```

### Invoice.lines Auto-Pagination (2023-08-16)

```typescript
// Before:
const lines = invoice.lines.data;
// After:
const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
```

## Webhook Migration

When event payloads change between versions, update handlers to match the new schema.

```typescript
// Before (pre-2023-08-16): amount on charge object
const amount = event.data.object.amount;
// After: amount_captured replaces amount in some flows
const amount = event.data.object.amount_captured ?? event.data.object.amount;
```

Test webhook changes:
```bash
stripe trigger checkout.session.completed --api-version 2026-03-25.dahlia
```

## Upgrade Checklist

1. Review the [API Changelog](https://docs.stripe.com/changelog) and [Upgrades Guide](https://docs.stripe.com/upgrades) for changes between versions
2. Update server-side SDK package version
3. Update the `apiVersion` parameter in your Stripe client initialization
4. Search codebase for removed/renamed fields and update all call sites
5. **Run test suite** — verify all Stripe-related tests pass before proceeding
6. Update webhook handlers to handle new event structures
7. **Verify webhook payloads** — send test events with `stripe trigger <event>` and confirm your handlers process them correctly
8. Update Stripe.js and mobile SDK versions if needed
9. Test against the new API version using the `Stripe-Version` header before promoting to default:
   ```bash
   curl https://api.stripe.com/v1/customers \
     -u sk_test_xxx: \
     -H "Stripe-Version: 2026-03-25.dahlia"
   ```
10. Store Stripe object IDs in databases that accommodate up to 255 characters (case-sensitive collation)

## Key Documentation

- [API Changelog](https://docs.stripe.com/changelog) — Complete list of version changes
- [Upgrades Guide](https://docs.stripe.com/upgrades) — SDK-specific upgrade details
