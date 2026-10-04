# New Dependencies: the Full Check

For a JavaScript project; other ecosystems have the same checks under their own tools.

| Check | Tool / Command | Pass Criteria | On Failure |
|-------|---------------|---------------|------------|
| Vulnerability | `npm audit --audit-level=high` | No new high/critical | BLOCK — use patched version or alternative |
| Bundle size | `npx source-map-explorer <build output>/*.js` | Frontend pkgs ≤50KB gzipped | SHOULD-FIX; blocking if >200KB |
| License | `npx license-checker --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0'` | No copyleft in prod deps | BLOCK — remove or replace |
| Duplicates | `npm find-dupes` or inspect lockfile | No duplicate major versions of same pkg | SHOULD-FIX |
| Maintenance | Check npm page / GitHub | Last publish <18 months; >100 weekly downloads | Evaluate alternatives |
| Peer deps | `npm ls --depth=0` | No unmet peer dependencies | Fix before merge |
| Type coverage | `npx @arethetypeswrong/cli <pkg>` | No `false` CJS/ESM resolution | SHOULD-FIX for new deps |
