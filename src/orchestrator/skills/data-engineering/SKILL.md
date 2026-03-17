---
name: data-engineering
description: "Data pipeline ETL workflows, web scraping, NDJSON processing, and CMS data import. Use when building scrapers, processing data, running CLI tools, or importing to a CMS."
---

# Data Engineering

Generic pipeline patterns. For project-specific sources, CLI commands, and data status see [data-pipeline-config.md](../../.opencastle/stack/data-pipeline-config.md).

## Scraper Architecture

```typescript
interface ScraperConfig {
  source: string; query: string; maxPages: number; concurrency: number;
  delay: { min: number; max: number }; outputPath: string; headless: boolean;
}
abstract class BaseScraper {
  abstract scrape(config: ScraperConfig): Promise<void>;
  abstract extractVenue(page: Page): Promise<RawVenue>;
  abstract getNextPage(page: Page): Promise<string | null>;
}
```

Launch a headless browser cluster (Puppeteer Cluster / Playwright) with `retryLimit: 3`, `retryDelay: 5000`, `timeout: 30000`, `args: ['--no-sandbox', '--disable-setuid-sandbox']`.

**Anti-detection:** rotate user-agents; random 2–5 s delays; randomize viewport; block images/fonts/CSS; use stealth plugin.

**Error recovery:** exponential backoff (3 retries); log failed URLs; save partial results; checkpoint/resume for long runs.

## NDJSON Output

One record per line: `{"name":"…","lat":50.0755,"lng":14.4378,"source":"google-maps","sourceId":"ChIJ…","category":"bar","address":"…","rating":4.5,"reviewCount":120}`

| Field | Type | Notes |
|-------|------|-------|
| `name` | Required | Preserve original encoding |
| `lat`/`lng` | Required | GPS coordinates |
| `address` | Required | Full text |
| `source` | Required | e.g. `google-maps` |
| `sourceId` | Required | Source-unique ID |
| `category` | Required | Domain category |
| `rating`, `reviewCount`, `phone`, `website`, `openingHours`, `photos`, `priceLevel` | Optional | — |

## Design Principles

| Principle | Detail |
|-----------|--------|
| Composable stages | Single-responsibility pipeline steps |
| Streams | Use for large files to minimize memory |
| Idempotent imports | `createOrReplace` + deterministic `_id` |
| Dry-run mode | Required for all destructive operations |
| Normalized names | Strip diacritics for search |
| Structured addresses | `{ street, city, postalCode, country, countryCode }` |
| Data lineage | Record source and transformation history |
| Error handling | Skip bad records; don't halt pipeline |
| Backup | Before all bulk operations |
| Rate limiting | Respect `robots.txt`; attribute sources |
