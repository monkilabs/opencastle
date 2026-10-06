<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Workflow: Data Pipeline

For crawling, converting and importing data into the project's database or CMS. Project-specific sources, paths and rules: `.opencastle/stack/data-pipeline-config.md`, when there is one, and the **data-engineering** skill.

1. **Analyse the source** (Data Engineer). What it offers, how its fields map to the target schema, how many records, its terms and rate limits, and any scraper the project already has to follow.
2. **Crawl** (Data Engineer). Raw records to files (NDJSON), with pagination, rate limiting and recovery from errors; log pages visited, records found and errors. Raw data is not committed.
3. **Process** (Data Engineer). Convert to the target schema, enrich and normalize by the project's rules, and validate every record against the schema; a bad record is skipped and logged with its reason, never dropped silently.
4. **Validate** (Team Lead). Spot-check 10–20 records by hand, run the validation over the whole set, and check for duplicates of what already exists.
5. **Import** (Data Engineer). A test batch of 5–10 records first, checked in the target; then the rest, idempotently, so a re-run changes nothing. Report created, updated, skipped and failed — counts that add up.

## Delivery

> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**
