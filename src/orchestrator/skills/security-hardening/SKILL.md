---
name: security-hardening
description: "Security rules for authentication, authorization, data access policies, input handling, headers and CSP, secrets and scheduled routes. Use when building an auth flow, adding an endpoint or handler, writing access policies, setting security headers, handling user input, or auditing security."
---

# Security Hardening

These hold whatever the stack. The stack's own rules — its auth library, its database's access policies, its framework's middleware — are in the skills bound to the **database** and **framework** slots of `.opencastle/agents/skill-matrix.json`.

## Authentication and sessions

- Sign-in, sign-up and sign-out go through server-side handlers with CSRF protection: POST only, Origin checked.
- Sessions live in HTTP-only, `Secure`, `SameSite` cookies, and are refreshed and checked on the server for every protected route — never only in the client.
- Roles and permissions are stored server-side, where the client cannot write them.

## Authorization and data access

- Check on the server, for every read and write, who is asking and whether they may touch *this* record. Hiding a button is not access control.
- Identity comes from the verified session, never from a request parameter.
- Where the data layer has policies (row-level security, rules), enable them on every table, deny by default and allow explicitly — and keep a test that proves another user reads nothing.

## Input and output

- Validate every handler's input with a schema before it reaches the database or another service. Client-side validation is feedback, not protection.
- Parameterized queries only. Sanitize user-supplied HTML (DOMPurify or the equivalent) before rendering it.
- Errors sent to the client carry no stack trace, query or internal id.

## Headers and CSP

Least privilege: allow only the origins each directive needs, and nonces or hashes in production instead of `'unsafe-inline'` or `'unsafe-eval'`. Check what actually ships with `curl -I` against a preview URL: CSP, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.

## Secrets and scheduled routes

- Secrets live in environment variables — never in code, logs or the client bundle. A value the browser needs is public.
- A cron or webhook route checks a shared secret (`authorization: Bearer <secret>`, generated with `openssl rand -hex 32`) or the provider's signature, and answers 401 otherwise.
- Check a new dependency's audit (`npm audit`, or the project's equivalent) before adding it.
