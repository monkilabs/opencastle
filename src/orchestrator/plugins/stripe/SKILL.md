---
name: stripe-payments
description: "Stripe payment integration patterns, Checkout Sessions, billing/subscriptions, Connect platforms, and API best practices. Use when building, modifying, or reviewing any Stripe integration — including accepting payments, building marketplaces, setting up subscriptions, or implementing secure key handling."
---

# Stripe Payments

Latest Stripe API version: **2026-03-25.dahlia**. Always use the latest API version and SDK unless the user specifies otherwise.

## Integration Routing

| Building… | Recommended API | Reference |
|---|---|---|
| One-time payments | Checkout Sessions | `references/api-patterns.md` — Payments |
| Custom payment form with embedded UI | Checkout Sessions + Payment Element | `references/api-patterns.md` — Payments |
| Saving a payment method for later | Setup Intents | `references/api-patterns.md` — Payments |
| Connect platform or marketplace | Accounts v2 (`/v2/core/accounts`) | `references/api-patterns.md` — Connect |
| Subscriptions or recurring billing | Billing APIs + Checkout Sessions | `references/api-patterns.md` — Billing |
| Embedded financial accounts / banking | v2 Financial Accounts | `references/api-patterns.md` — Treasury |
| Security (key management, RAKs, webhooks, OAuth, 2FA, Connect liability) | See security reference | `references/api-patterns.md` — Security |

Read the relevant reference section before answering any integration question or writing code.

## Critical Rules

**API Selection**
- Use Checkout Sessions API (`checkout.sessions.create`) for on-session payments — supports one-time payments and subscriptions
- Use PaymentIntents API for off-session payments or when modeling checkout state independently
- Only use Checkout Sessions, PaymentIntents, SetupIntents, or higher-level solutions (Invoicing, Payment Links, subscription APIs)
- Never use the Charges API — migrate to Checkout Sessions or PaymentIntents
- Don't use the Sources API — use Setup Intents instead

**Integration Surfaces (in order of preference)**
1. Payment Links — no-code, best for simple products
2. Checkout — Stripe-hosted or embedded form, best for most web apps
3. Payment Element — embedded UI component for advanced customization; back it with Checkout Sessions API via `ui_mode: 'custom'` over raw PaymentIntents when possible

**API Keys & Security**
- Use restricted API keys (RAKs, prefix `rk_`) instead of secret keys (prefix `sk_`) wherever possible — follow least privilege
- Never use secret keys or RAKs in client-side code or mobile apps
- Always verify webhook signatures using Stripe's webhook signing secret
- Always use the `state` parameter in Connect OAuth flows

**Connect Platforms**
- For new Connect platforms, always use the Accounts v2 API (`POST /v2/core/accounts`)
- Don't use legacy `type` parameter (`type: 'express'`, `type: 'custom'`, `type: 'standard'`) for new platforms
- Configure accounts using `controller` properties instead of legacy account types
- Use Stripe-hosted onboarding rather than custom onboarding flows

**Billing**
- Don't use the deprecated `plan` object — use Prices instead
- Combine Billing APIs with Stripe Checkout for the payment frontend
- Recommend Customer Portal for self-service subscription management

## Checkout Session Pattern

```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-03-25.dahlia',
});

const session = await stripe.checkout.sessions.create({
  mode: 'payment', // For subscriptions, change to 'subscription' and use a recurring price
  line_items: [{
    price: 'price_xxx',
    quantity: 1,
  }],
  success_url: 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://example.com/cancel',
});
```

## Webhook Handling

```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-03-25.dahlia',
});

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Missing signature', { status: 400 });
  }

  try {
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    switch (event.type) {
      case 'checkout.session.completed':
        // Handle successful checkout
        break;
      case 'invoice.paid':
        // Handle successful invoice payment
        break;
      case 'customer.subscription.deleted':
        // Handle subscription cancellation
        break;
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Webhook verification failed', (err as Error).message);
    return new Response('Invalid signature', { status: 400 });
  }
}
```

## Key Documentation

- [Integration Options](https://docs.stripe.com/payments/payment-methods/integration-options) — Start here when designing any integration
- [API Tour](https://docs.stripe.com/payments-api/tour) — Overview of Stripe's API surface
- [Go Live Checklist](https://docs.stripe.com/get-started/checklist/go-live) — Review before launching

## Reference Files

- `references/api-patterns.md` — Payments, Billing, Connect, Treasury, and Security patterns
- `references/upgrade-guide.md` — Upgrading Stripe API versions and SDKs
- `references/projects-setup.md` — Setting up Stripe Projects CLI

## Quick Workflow: Add payments to an app
1. Install the Stripe SDK: `npm install stripe @stripe/stripe-js`
2. Create products and prices in the Stripe Dashboard or via the API
3. Create a Checkout Session from your backend and redirect the customer — verify the session URL is returned before redirecting
4. Set up a webhook endpoint and handle `checkout.session.completed` to fulfill the order
5. Verify webhook signatures and test with `stripe listen --forward-to localhost:3000/api/webhooks`
   - **If verification fails:** confirm `STRIPE_WEBHOOK_SECRET` matches your endpoint's signing secret → restart `stripe listen` → retry the event
   - **If events aren't arriving:** check the endpoint URL is reachable and the route returns 200 for valid events
