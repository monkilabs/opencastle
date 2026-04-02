> Parent: [SKILL.md](./SKILL.md)

# Validation Gates Reference

Extended checklists and options for validation gates.

## Gate 4: Full Dependency Audit Checklist

| Check | Tool / Command | Pass Criteria | On Failure |
|-------|---------------|---------------|------------|
| Vulnerability | `npm audit --audit-level=moderate` | No new high/critical | BLOCK — use patched version or alternative |
| Bundle size | `npx source-map-explorer dist/*.js` | Frontend pkgs ≤50KB gzipped | SHOULD-FIX; blocking if >200KB |
| License | `npx license-checker --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0'` | No copyleft in prod deps | BLOCK — remove or replace |
| Duplicates | `npx npm-dedupe --check` or inspect lockfile | No duplicate major versions of same pkg | SHOULD-FIX |
| Maintenance | Check npm page / GitHub | Last publish <18 months; >100 weekly downloads | Evaluate alternatives |
| Peer deps | `npm ls --depth=0` | No unmet peer dependencies | Fix before merge |
| Type coverage | `npx @arethetypeswrong/cli <pkg>` | No `false` CJS/ESM resolution | SHOULD-FIX for new deps |

## Gate 7: Browser Testing Options

### Viewport Presets

| Preset | Width × Height |
|--------|---------------|
| `mobile` | 375 × 812 |
| `tablet` | 768 × 1024 |
| `desktop` | 1440 × 900 |

### MCP Payload Options

```json
{
	"tool": "browser-testing/capture_screenshot",
	"url": "http://localhost:3000/page",
	"viewports": ["mobile", "tablet", "desktop"],
	"wait_selector": ".content-loaded",
	"auth": { "cookie": "session=abc123" },
	"full_page": true
}
```

### Console Error Check

```json
{
	"tool": "browser-testing/evaluate_script",
	"url": "http://localhost:3000",
	"script": "window.__console_errors || []"
}
```
