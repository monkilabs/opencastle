## Data Engineering Reference

Starters to adapt when `.opencastle/stack/data-pipeline-config.md` names no script of its own. Replace the URL, selectors and schema with the project's.

### Minimal Scraper: `scrape-to-ndjson.js` (Playwright)

```js
const fs = require('fs');
const { chromium } = require('playwright');
const out = process.argv[2] || 'data.ndjson';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const fh = fs.createWriteStream(out, { flags: 'w' });
  await page.goto('https://example.com/list');
  const items = await page.$$eval('.item', (nodes) => nodes.map(n => ({
    name: n.querySelector('.title')?.textContent?.trim(),
    source: 'example',
    sourceId: n.getAttribute('data-id')
  })));
  for (const it of items) fh.write(JSON.stringify(it) + '\n');
  fh.end();
  await browser.close();
})();
```

Usage: `node scrape-to-ndjson.js data.ndjson`.

### NDJSON Validator: `validate-ndjson.js` (Node)

```js
const fs = require('fs');
const readline = require('readline');
const { z } = require('zod');
const schema = z.object({ name: z.string(), source: z.string(), sourceId: z.string() });
const path = process.argv[2];
if (!path) throw new Error('Usage: node validate-ndjson.js <file.ndjson>');
const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
let line = 0; let errors = 0;
(async () => {
  for await (const l of rl) {
    line++;
    try { const obj = JSON.parse(l); schema.parse(obj); }
    catch (e) { console.error('Line', line, e.message); errors++; }
  }
  if (errors) { console.error(errors, 'validation errors'); process.exit(2); }
  console.log('OK');
})();
```
