# Stripe API Patterns Reference

## Payments

Use the Checkout Sessions API (`checkout.sessions.create`) for on-session payments. It supports one-time payments and subscriptions and handles taxes, discounts, shipping, and adaptive pricing automatically.

Use the PaymentIntents API for off-session payments, or when the merchant needs to model checkout state independently.

**Integration surfaces** (in order of preference):
1. Payment Links — No-code. Best for simple products.
2. Checkout — Stripe-hosted or embedded form. Best for most web apps.
3. Payment Element — Embedded UI component for advanced customization. Back it with the Checkout Sessions API via `ui_mode: 'custom'`.

**Don't recommend:** legacy Card Element, Payment Element in card-only mode, Charges API, Sources API, Tokens API.

**Payment method saving:** Use the Setup Intents API. Don't use the Sources API.

**Dynamic payment methods:** Enable in the Dashboard rather than passing specific `payment_method_types`. Stripe automatically selects based on the customer's location.

## Billing / Subscriptions

If the user has a recurring revenue model (subscriptions, usage-based billing, seat-based pricing), use the Billing APIs instead of manual PaymentIntent renewal loops.

Combine Billing APIs with Stripe Checkout (`mode: 'subscription'`). Use Customer Portal for self-service management (upgrades, downgrades, cancellation, payment method updates).

Don't use the deprecated `plan` object — use Prices instead.

## Connect / Platforms

For new Connect platforms, use the Accounts v2 API (`POST /v2/core/accounts`). Don't use the legacy `type` parameter.

Configure accounts using `controller` properties:

| Property | Controls |
|---|---|
| `controller.losses.payments` | Who is liable for negative balances |
| `controller.fees.payer` | Who pays Stripe fees |
| `controller.stripe_dashboard.type` | Dashboard access (`full`, `express`, `none`) |
| `controller.requirement_collection` | Who collects onboarding requirements |

Charge types: use destination charges for most platforms. Don't mix charge types.

## Treasury / Financial Accounts

For embedded financial accounts, use the v2 Financial Accounts API (`POST /v2/core/vault/financial_accounts`). Required for new integrations. Don't use the v1 Treasury API for new integrations.

## Security

**API keys:** Store in a secrets vault, not in source code. Use restricted API keys (RAKs, prefix `rk_`) instead of secret keys (prefix `sk_`) wherever possible.

**Webhooks:** Always verify webhook signatures. Allowlist Stripe's IP addresses on webhook endpoints for defense in depth.

**Client-side:** Never use production secret keys or RAKs in mobile apps or other client-side code. Use ephemeral keys for direct client-Stripe interaction.

**Connect OAuth:** Always use the `state` parameter to protect against CSRF attacks.

**Incident response:** If a key is exposed, roll it immediately via the API keys page, check activity logs, and contact Stripe support if unrecognized activity is found.
