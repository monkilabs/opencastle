---
name: data-engineering
description: "Transforms, validates, loads data in ETL pipelines. Use when building scrapers, validating NDJSON feeds, or importing data into CMS/DB targets."
---

# Data Engineering

Project-specific sources, full schema, full scraper and extended validator: [REFERENCE.md](./REFERENCE.md).

## Scraper

Headless browser cluster (Puppeteer Cluster / Playwright) with `retryLimit: 3`, `retryDelay: 5000`, `timeout: 30000`, `args: ['--no-sandbox', '--disable-setuid-sandbox']`.

## NDJSON Output

One record per line. Required: `name` (preserve original encoding), `lat`/`lng`, `address` (full text), `source` (e.g. `google-maps`), `sourceId` (source-unique), `category`. Optional: `rating`, `reviewCount`, `phone`, `website`, `openingHours`, `photos`, `priceLevel`.

## Pipeline

```bash
node ./scripts/scrape-to-ndjson.js --out=data.ndjson --pages=100
node ./scripts/validate-ndjson.js data.ndjson
node ./scripts/dry-import.js data.ndjson --target=staging
node ./scripts/import.js data.ndjson --target=production
```

1. Scrape a `--dry-run` sample of 50–200 records; require expected fields and geo data. Otherwise fix extractor selectors and re-run the sample.
2. Validate NDJSON line-by-line (JSON parse + schema): require 0 parse errors, all required fields. Isolate failures with `ndjson-filter`, inspect source HTML.
3. Dry-run import to staging with `createOrReplace` disabled: counts within ±5% of expectation, no duplicates. Otherwise revert staging and adjust the dedupe key.
4. Snapshot the target (timestamped export) before writing.
5. Import with idempotent keys; revert to the snapshot on failure.
