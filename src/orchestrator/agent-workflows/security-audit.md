<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Security Audit

For a security review of the whole application or one area of it, and fixing what it finds. The rules it checks against: **security-hardening**, and the skills of the stack's database and framework.

1. **Scope** (Team Lead). The whole application or one area; the known issues; the auth flow; every endpoint and server action.
2. **Automated checks** (Security Expert). Lint with security rules, a secret scan (**validation-gates**), the dependency audit, the security headers and CSP of a running build, access control enabled on every table, and every place that renders raw HTML.
3. **Manual review** (Security Expert). Authentication and sessions; authorization and route protection; access policies; input validation on every endpoint; CSRF; rate limiting; error responses; OAuth callbacks, state and PKCE; headers; cookie flags. Each finding rated Critical, High, Medium or Low.
4. **Panel** — **panel-majority-vote** on the findings and the files they name, asking "Are there unmitigated vulnerabilities in this code?"
5. **Fix** (Security Expert, or the Developer for application code). Critical and High first; an issue in the tracker for each Medium or Low left for later; the panel again if it blocked. A risk accepted on purpose goes in `.opencastle/KNOWN-ISSUES.md`.

## Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
