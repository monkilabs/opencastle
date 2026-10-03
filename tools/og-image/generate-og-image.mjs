#!/usr/bin/env node

/**
 * Generate the OG social card image for the OpenCastle GitHub repo / website.
 *
 * Usage:  node tools/og-image/generate-og-image.mjs
 *
 * Requires: playwright (already in devDependencies)
 * Output:   website/public/og-image.png (1280×640)
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTML_PATH = path.resolve(__dirname, 'og-card.html');
const LOGO_PATH = path.resolve(__dirname, '..', '..', 'opencastle-logo.png');
const OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'website', 'public', 'og-image.png');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 2, // 2× for crisp retina output
  });

  // Read HTML template and inject logo as base64 data URI
  const logoBuffer = fs.readFileSync(LOGO_PATH);
  const logoDataUri = `data:image/png;base64,${logoBuffer.toString('base64')}`;
  let html = fs.readFileSync(HTML_PATH, 'utf-8');
  html = html.replace('{{LOGO_DATA_URI}}', logoDataUri);

  await page.setContent(html, { waitUntil: 'networkidle' });

  await page.screenshot({
    path: OUTPUT_PATH,
    type: 'png',
    clip: { x: 0, y: 0, width: 1280, height: 640 },
  });

  await browser.close();

  console.log(`✅ OG image saved to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error('Failed to generate OG image:', err);
  process.exit(1);
});
