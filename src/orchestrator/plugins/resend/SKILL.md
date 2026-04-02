---
name: resend-email
description: "Resend transactional email patterns, React Email templates, domain configuration, and webhook handling. Use when sending emails, building email templates, or configuring email delivery."
---

# Resend Email


## Setup

```bash
npm install resend
npm install @react-email/components
```



## Sending Emails

```typescript
import { Resend } from 'resend';
import { WelcomeEmail } from '@/emails/welcome';

const resend = new Resend(process.env.RESEND_API_KEY);

// Plain text
await resend.emails.send({
  from: 'App <no-reply@yourdomain.com>',
  to: ['user@example.com'],
  subject: 'Welcome',
  html: '<p>Your account is ready.</p>',
});

// With React Email template
await resend.emails.send({
  from: 'App <no-reply@yourdomain.com>',
  to: ['user@example.com'],
  subject: 'Welcome',
  react: WelcomeEmail({ name: 'Alice' }),
});
```

## React Email Templates


Template pattern and webhook handler examples: see [REFERENCE.md](./REFERENCE.md).

### Preview Templates

```bash
npx email dev
```

## Domain Configuration

1. Add your domain at resend.com → Domains
2. Configure DNS records (SPF, DKIM, DMARC) and await verification (<1h)
3. Post-verify: send one canned test to `postmaster@` and confirm headers (SPF/DKIM pass).
4. Use `from: 'Name <no-reply@yourdomain.com>'` in sends

## Webhook Handling

Webhook handling patterns and a safe, verified handler example are in REFERENCE.md (this directory).

## Quick Verification Workflow
1. Add domain and copy DNS records.
2. Verify DNS propagation: `dig TXT yourdomain.com` — confirm SPF/DKIM records appear.
3. Send a test email and confirm SPF/DKIM pass in headers.
4. Deploy webhook handler; test with: `curl -X POST -H 'Content-Type: application/json' -d '{"type":"email.delivered"}' https://yourapp.com/api/webhooks/resend` — assert 200.
5. If verification fails: re-check DNS, API keys, and webhook secret.

See REFERENCE.md for detailed verification commands and troubleshooting.

