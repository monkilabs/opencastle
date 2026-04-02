> Parent: [SKILL.md](./SKILL.md)

Netlify REFERENCE: extended CI build examples, function/edge function snippets, and verification scripts.

Put long-form troubleshooting steps and environment-specific snippets here; `SKILL.md` contains the concise checklist.
Last Updated: 2026-03-31

Reference: Netlify verification & scripts

- Post-deploy verification scripts (curl checks, env validation) and Lighthouse commands
- Netlify CLI examples for local `netlify build` and `netlify env:set`
- Common deploy log patterns and error snippets with remediation steps

## Environment Variable Scoping

| Scope | When Applied | Use For |
|-------|-------------|----------|
| **Production** | `main` deploys | Live secrets, production API keys |
| **Deploy previews** | All PR/branch builds | Staging/test API keys |
| **Branch deploy** | Specific branch deploys | Branch-specific overrides |
| **Local** | `netlify dev` | Local development |

## Security Headers (netlify.toml)

```toml
[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

