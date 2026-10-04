<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Security Audit

Comprehensive security review workflow for auth, RLS, headers, and API security.

## Phases

```
Phase 1: Scope & Context      (sub-agent, inline)
Phase 2: Automated Checks     (sub-agent, inline)
Phase 3: Manual Review        (background agent)
Phase 4: Panel Review         (sub-agent, inline)
Phase 5: Remediation          (sub-agent or background)
Phase 6: Delivery             (direct, Team Lead)
```

---

## Branch & Delivery Strategy

The Team Lead creates the branch before any delegation and delivers it as the Delivery phase below describes. Branch naming: `fix/<ticket-id>-<short-description>` for remediations.

---

## Phase 1: Scope & Context

**Agent:** Team Lead (self)
**Type:** Direct research

### Steps

1. Define audit scope (full audit vs. targeted area)
2. Read `.opencastle/project.instructions.md` security sections
3. Read `.opencastle/KNOWN-ISSUES.md` for existing security items
4. Check current CSP configuration in `next.config.js`
5. Review auth flow (see database/auth customization for library paths)
6. Map all API routes and Server Actions
7. Create tracker issue for the audit

### Exit Criteria

- [ ] Scope defined (which apps, libs, routes)
- [ ] Existing security docs reviewed
- [ ] Attack surface mapped
- [ ] Tracker issue created

---

## Phase 2: Automated Checks

**Agent:** Security Expert (via sub-agent)
**Type:** Sub-agent (inline)

### Steps

1. Run lint with security rules
2. Check for hardcoded secrets (`grep -r "password\|secret\|api_key"`)
3. Validate CSP headers
4. Check dependency vulnerabilities (`yarn audit`)
5. Verify RLS is enabled on all database tables
6. Check for `dangerouslySetInnerHTML` usage

### Exit Criteria

- [ ] No hardcoded secrets found
- [ ] CSP headers valid
- [ ] Dependency audit clean (or known issues documented)
- [ ] RLS enabled on all tables
- [ ] No unsafe HTML injection points
- [ ] Findings documented

---

## Phase 3: Manual Review

**Agent:** Security Expert
**Type:** Background agent

### Checklist

- [ ] **Authentication:** Session handling, token refresh, logout flow
- [ ] **Authorization:** Role checks, route protection, middleware
- [ ] **RLS Policies:** Default-deny, explicit-allow, policy correctness
- [ ] **Input Validation:** Zod schemas on all API routes and Server Actions
- [ ] **CSRF Protection:** Server Actions use form tokens
- [ ] **Rate Limiting:** Proxy layer, per-IP limits, fingerprinting
- [ ] **Error Handling:** No sensitive data in error responses
- [ ] **OAuth:** Callback URLs, state parameter, PKCE
- [ ] **Headers:** HSTS, X-Content-Type-Options, X-Frame-Options
- [ ] **Cookies:** HttpOnly, Secure, SameSite flags

### Exit Criteria

- [ ] All checklist items reviewed
- [ ] Findings categorized by severity
- [ ] Output contract returned with findings list

---

## Phase 4: Panel Review

**Agent:** Team Lead (orchestrates panel)
**Type:** Sub-agent (inline)

### Steps

1. Load **panel-majority-vote** skill
2. Provide Phase 3 findings and affected files as in-scope artifacts
3. Panel question: "Are there any unmitigated security vulnerabilities in the reviewed code?"
4. Run 3 reviewer sub-agents
5. Consolidate results

### Exit Criteria

- [ ] Panel completed (PASS or BLOCK)
- [ ] Panel report linked to tracker issue
- [ ] If BLOCK: MUST-FIX items extracted

---

## Phase 5: Remediation

**Agent:** Security Expert or Developer (depends on finding)
**Type:** Sub-agent (critical fixes) or Background (non-critical)

### Steps

1. Fix Critical and High severity findings first
2. Create separate tracker issues for Medium/Low findings if not fixing now
3. Run verification after each fix
4. Re-run panel review if initial panel BLOCKed
5. Update `.opencastle/KNOWN-ISSUES.md` for any accepted risks

### Exit Criteria

- [ ] Critical/High findings remediated
- [ ] Medium/Low findings tracked in tracker
- [ ] Panel review passed (if applicable)
- [ ] Known issues updated for accepted risks
- [ ] All tracker issues updated
- [ ] Delivery phase completed — branch pushed, PR opened (not merged), tracker linked

---

### Phase 6: Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
>
> Commit → Push → PR → tracker linkage. Team Lead owns delivery.
