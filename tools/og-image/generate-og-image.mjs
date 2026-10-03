#!/usr/bin/env node

/**
 * Generate the OG social card image for the OpenCastle GitHub repo / website.
 *
 * Usage:  node tools/og-image/generate-og-image.mjs
 *
 * Requires: playwright and @fontsource-variable/inter (both devDependencies).
 *           Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use a Chromium that is
 *           already installed instead of Playwright's own download.
 * Output:   website/public/og-image.png (1280×640, rendered at 2×)
 *
 * The logo and the tagline sit in the card's central 4:1 band, so the same
 * image crops to a profile or page banner (LinkedIn's is 1584×396).
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This file lives two levels below the repository root. The paths below still
// said one, from before it moved here, so the script could not find the logo.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HTML_PATH = path.resolve(__dirname, 'og-card.html');
const LOGO_PATH = path.resolve(REPO_ROOT, 'opencastle-logo.png');
const OUTPUT_PATH = path.resolve(REPO_ROOT, 'website', 'public', 'og-image.png');
const FONT_PATH = createRequire(import.meta.url).resolve(
  '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
);

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 2, // 2× for crisp retina output
  });

  // Read the HTML template and inject the logo and the font as data URIs, so
  // the page needs nothing from the network or from the machine's fonts.
  const logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;
  const fontDataUri = `data:font/woff2;base64,${fs.readFileSync(FONT_PATH).toString('base64')}`;
  const html = fs
    .readFileSync(HTML_PATH, 'utf-8')
    .replace('{{LOGO_DATA_URI}}', logoDataUri)
    .replace('{{FONT_DATA_URI}}', fontDataUri);

  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

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
