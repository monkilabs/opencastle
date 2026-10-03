---
name: resend-email
description: "Resend transactional email patterns, React Email templates, domain configuration, and webhook handling. Use when sending emails, building email templates, or configuring email delivery."
---

# Resend Email

Docs: https://resend.com/docs

Env: `RESEND_API_KEY` (resend.com → API Keys), `RESEND_WEBHOOK_SECRET` (resend.com → Webhooks).

## Gotchas

- **Resend webhooks are Svix-signed.** Verification needs all three headers — `svix-id`, `svix-timestamp`, `svix-signature` — passed to `new Webhook(process.env.RESEND_WEBHOOK_SECRET).verify(rawBody, headers)`. Verify against the **raw** `request.text()`; parsing the JSON first invalidates the signature. Return 400 on failure, 200 on success. Events: `email.delivered`, `email.bounced`, `email.complained`.
- `from` must use a verified domain and the `'Name <no-reply@yourdomain.com>'` form. `to` is an array.
- Pass a React Email component via `react:` (not `html:`); the two are mutually exclusive.

## Domain setup

1. Add the domain at resend.com → Domains, then add the SPF, DKIM, and DMARC records. Verification typically completes within an hour.
2. Confirm propagation before blaming the API: `dig TXT yourdomain.com` — SPF/DKIM records must appear.
3. Send one test message and check the received headers show SPF and DKIM **pass**.
4. Smoke-test the webhook endpoint returns 200:
   `curl -X POST -H 'Content-Type: application/json' -d '{"type":"email.delivered"}' https://yourapp.com/api/webhooks/resend`

Failures here are nearly always DNS propagation, a wrong API key scope, or a mismatched webhook secret.

## Templates

`npm install resend @react-email/components`. Build templates from `@react-email/components` primitives (`Html`, `Head`, `Body`, `Container`, `Heading`, `Text`, `Button`) — plain HTML/CSS is unreliable across clients. Preview locally with `npx email dev`.
