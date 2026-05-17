---
name: data-engineering
description: "Transforms, validates, loads data in ETL pipelines. Use when building scrapers, validating NDJSON feeds, or importing data into CMS/DB targets."
---

# Data Engineering

Generic pipeline patterns. For project-specific sources, full schema references see [REFERENCE.md](./REFERENCE.md).

## Scraper Architecture

Launch a headless browser cluster (Puppeteer Cluster / Playwright) with `retryLimit: 3`, `retryDelay: 5000`, `timeout: 30000`, `args: ['--no-sandbox', '--disable-setuid-sandbox']`.

## NDJSON Output

One record per line. Schema:
| Field | Type | Notes |
|-------|------|-------|
| `name` | Required | Preserve original encoding |
| `lat`/`lng` | Required | GPS coordinates |
| `address` | Required | Full text |
| `source` | Required | e.g. `google-maps` |
| `sourceId` | Required | Source-unique ID |
| `category` | Required | Domain category |
| `rating`, `reviewCount`, `phone`, `website`, `openingHours`, `photos`, `priceLevel` | Optional | — |

## Recommended Workflow (numbered, with validation)

1. Scrape: run scraper in `--dry-run` to collect sample (50–200 records).
   - Checkpoint: sample contains expected fields, geo data.
   - Recovery: fix extractor selectors; re-run sample.
2. Validate NDJSON: run line-by-line JSON parse + schema validator (see `validate-ndjson.js` example).
   - Checkpoint: 0 parse errors, required fields present.
   - Recovery: run `ndjson-filter` to isolate failing records; inspect source HTML.
3. Dry-run import: import into staging with `createOrReplace` disabled; check counts, duplicates.
   - Checkpoint: counts match expectation ±5%; no duplicates inserted.
   - Recovery: revert staging; adjust dedupe key.
4. Backup: snapshot current target (DB export); store with timestamp.
5. Import: run import with idempotent keys; monitor logs; on failure revert to backup.

## Quick executable pipeline (copy & adapt)

```bash
node ./scripts/scrape-to-ndjson.js --out=data.ndjson --pages=100
node ./scripts/validate-ndjson.js data.ndjson
node ./scripts/dry-import.js data.ndjson --target=staging
node ./scripts/import.js data.ndjson --target=production
```

## Inline: minimal NDJSON validator

```js
const fs = require('fs'), rl = require('readline'), { z } = require('zod');
const schema = z.object({ name: z.string(), source: z.string(), sourceId: z.string() });
const iface = rl.createInterface({ input: fs.createReadStream(process.argv[2]) });
let line = 0, errors = 0;
for await (const l of iface) { line++; try { schema.parse(JSON.parse(l)); } catch(e) { console.error(`Line ${line}:`, e.message); errors++; } }
if (errors) { console.error(`${errors} errors`); process.exit(2); }
console.log('OK');
```

Full scraper, extended validator: see [REFERENCE.md](./REFERENCE.md).

