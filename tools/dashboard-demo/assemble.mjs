#!/usr/bin/env node
/**
 * Build the static Observability dashboard: the page from src/cli/dashboard/,
 * switched to static mode, over the data an export wrote.
 *
 *   node tools/dashboard-demo/assemble.mjs <snapshotDir> <siteDir>
 *
 * The website's deploy runs it over the committed snapshot, so the published
 * demo is always the current page — the snapshot holds data only.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [snapshotArg, siteArg] = process.argv.slice(2)
if (!snapshotArg || !siteArg) {
  console.error('Usage: node tools/dashboard-demo/assemble.mjs <snapshotDir> <siteDir>')
  process.exit(1)
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pageDir = join(repo, 'src', 'cli', 'dashboard')
const data = join(resolve(snapshotArg), 'data')
if (!existsSync(join(data, 'runs.json'))) {
  console.error(`No snapshot data in ${data} (runs.json is missing). Run export.mjs first.`)
  process.exit(1)
}

const LIVE = '<meta name="opencastle-dashboard" content="live">'
const page = readFileSync(join(pageDir, 'index.html'), 'utf8')
if (!page.includes(LIVE)) {
  console.error('src/cli/dashboard/index.html has no mode marker to switch to static.')
  process.exit(1)
}

const site = resolve(siteArg)
mkdirSync(site, { recursive: true })
writeFileSync(join(site, 'index.html'), page.replace(LIVE, '<meta name="opencastle-dashboard" content="static">'))
for (const asset of ['dashboard.css', 'dashboard.js', 'icon-192.png']) copyFileSync(join(pageDir, asset), join(site, asset))
cpSync(data, join(site, 'data'), { recursive: true })
console.log(`Static dashboard → ${site}`)
