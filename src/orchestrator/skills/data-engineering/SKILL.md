---
name: data-engineering
description: "Method for scraping, transforming, validating and loading data through NDJSON. Use when building a scraper or ETL step, validating an NDJSON feed, or importing data into a CMS or database."
---

# Data Engineering

The project's sources, record schema, scripts and commands live in `.opencastle/stack/data-pipeline-config.md`. Use those names; when a script it lists does not exist, write it rather than guessing at one. Starter scraper and validator: [REFERENCE.md](./REFERENCE.md).

## Scraper

Headless browser (Playwright, or Puppeteer Cluster for volume) with retries and a per-page timeout, so one slow page does not stall the run.

## NDJSON Output

One record per line, valid JSON, fields as the project's schema names them. Every record carries a source-unique ID (e.g. `source` + `sourceId`) to deduplicate and import on; keep text in its original encoding.

## Pipeline

1. **Scrape** a sample of 50–200 records first; check it has the schema's required fields. Missing fields → fix the extractor selectors and re-run the sample.
2. **Validate** every line (JSON parse + schema): 0 parse errors, all required fields. Isolate failing lines and inspect their source HTML.
3. **Dry-run** the import against a staging target: counts within ±5% of expectation, no duplicates. Otherwise reset staging and adjust the dedupe key.
4. **Snapshot** the target (timestamped export) before writing.
5. **Import** with idempotent upserts keyed on the source ID; restore the snapshot on failure.
