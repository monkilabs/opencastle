> Parent: [SKILL.md](./SKILL.md)

## Resend Reference: Templates & Webhook Handler

### React Email template (compact example)

```tsx
// emails/welcome.tsx
import { Html, Head, Body, Container, Heading, Text, Button } from '@react-email/components';

export function WelcomeEmail({ name, loginUrl = 'https://app.example.com/login' }: { name: string; loginUrl?: string }) {
  return (
    <Html>
      <Head />
      <Body>
        <Container>
          <Heading>Welcome, {name}!</Heading>
          <Text>Your account is ready.</Text>
          <Button href={loginUrl}>Get started</Button>
        </Container>
      </Body>
    </Html>
  );
}
```

### Webhook handler (verify signature)

```typescript
// app/api/webhooks/resend/route.ts
import { Webhook } from 'resend';

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get('svix-signature');
  if (!signature || !process.env.RESEND_WEBHOOK_SECRET) return new Response('Missing signature', { status: 400 });

  try {
    const webhook = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
    const event = webhook.verify(body, {
      'svix-id': request.headers.get('svix-id')!,
      'svix-timestamp': request.headers.get('svix-timestamp')!,
      'svix-signature': signature,
    });

    // handle event.type (delivered, bounced, complained)

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('resend webhook verify failed', (err as Error).message);
    return new Response('Invalid signature', { status: 400 });
  }
}
```
Last Updated: 2026-03-31

Reference: Resend verification & webhook troubleshooting

- DNS verification commands (dig examples) and expected DKIM/SPF headers
- Sample webhook test payloads and replay instructions
- Email header inspection checklist for deliverability debugging
