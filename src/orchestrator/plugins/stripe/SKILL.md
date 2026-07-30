---
name: stripe-payments
description: "Stripe payment integration patterns, Checkout Sessions, billing/subscriptions, Connect platforms, and API best practices. Use when building, modifying, or reviewing any Stripe integration — including accepting payments, building marketplaces, setting up subscriptions, or implementing secure key handling."
---

# Stripe Payments

Latest API version: **2026-03-25.dahlia**. Pin it explicitly on the client unless told otherwise.

## Never use

Charges API, Sources API, Tokens API, legacy Card Element, Payment Element in card-only mode, the deprecated `plan` object (use Prices), Connect legacy `type: 'express' | 'custom' | 'standard'`, v1 Treasury for new integrations.

## API selection

- On-session payments and subscriptions: Checkout Sessions. Off-session, or when checkout state is modeled independently: PaymentIntents. Saving a payment method: SetupIntents.
- Preference order: Payment Links → Checkout → Payment Element. Back Payment Element with Checkout Sessions `ui_mode: 'custom'` rather than raw PaymentIntents.
- Enable dynamic payment methods in the Dashboard instead of passing `payment_method_types`.
- New Connect platforms: `POST /v2/core/accounts`, configured via `controller.losses.payments`, `controller.fees.payer`, `controller.stripe_dashboard.type`, `controller.requirement_collection`. Destination charges; never mix charge types. Use Stripe-hosted onboarding.
- Embedded financial accounts: `POST /v2/core/vault/financial_accounts`.

## Gotchas

- Verify webhook signatures against the **raw** request body (`await request.text()`) — a parsed JSON body fails verification.
- Restricted keys (`rk_`) over secret keys (`sk_`); neither ever ships client-side (use ephemeral keys). Always pass `state` in Connect OAuth.
- Stripe.js is evergreen, biannual, and hard-paired to its API version — no override: `https://js.stripe.com/dahlia/stripe.js`. Java/Go/.NET SDKs also fix the version to the release; bump the package instead of setting `apiVersion`.
- Store Stripe object IDs in columns accommodating 255 chars with case-sensitive collation.
- Breaking changes to grep for: `paymentIntent.charges` removed 2022-11-15 → `stripe.charges.retrieve(pi.latest_charge)`; `invoice.lines.data` → `stripe.invoices.listLineItems()` 2023-08-16.
- Test locally with `stripe listen --forward-to localhost:3000/api/webhooks` and `stripe trigger <event> --api-version 2026-03-25.dahlia`; probe a new version with the `Stripe-Version` header before promoting it to default.
- `stripe plugin install projects` then `stripe projects init` writes `stripe-project.json` and a `.stripe/` directory of local skills — prefer those local skills afterwards.

Docs: [changelog](https://docs.stripe.com/changelog) · [integration options](https://docs.stripe.com/payments/payment-methods/integration-options) · [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)
