#!/usr/bin/env node
/**
 * Export the convoy viewer as a static page over a snapshot of recorded runs.
 *
 *   npm run cli:build
 *   node tools/viewer-demo/export.mjs <projectRoot> <outDir>
 *
 * Writes <outDir>/index.html — the same page `opencastle convoy dashboard`
 * serves, switched to its static mode — and <outDir>/data/*.json, read through
 * the same read model the live viewer uses. Nothing is generated or made up: the
 * page shows exactly the runs recorded in <projectRoot>/.opencastle/convoy.db.
 *
 * The website publishes tools/viewer-demo/snapshot/ at opencastle.dev/dashboard
 * (see .github/workflows/deploy.yml). A deployed snapshot is public, task output
 * included, so export only a project whose runs you are happy to publish.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [projectArg, outArg] = process.argv.slice(2)
if (!projectArg || !outArg) {
  console.error('Usage: node tools/viewer-demo/export.mjs <projectRoot> <outDir>')
  process.exit(1)
}

const readModelPath = join(repo, 'dist', 'cli', 'convoy', 'read-model.js')
if (!existsSync(readModelPath)) {
  console.error('dist/ is missing. Build the CLI first: npm run cli:build')
  process.exit(1)
}
const model = await import(pathToFileURL(readModelPath).href)

const projectRoot = resolve(projectArg)
if (!existsSync(model.convoyDbPath(projectRoot))) {
  console.error(`No convoy runs recorded in ${projectRoot} (no .opencastle/convoy.db).`)
  process.exit(1)
}
const outDir = resolve(outArg)

const LIVE = '<meta name="opencastle-viewer" content="live">'
const page = readFileSync(join(repo, 'src', 'cli', 'viewer', 'index.html'), 'utf8')
if (!page.includes(LIVE)) {
  console.error('The viewer page has no mode marker to switch; was src/cli/viewer/index.html changed?')
  process.exit(1)
}

/** The page applies the same rule to find a run's files. */
const fileId = (id) => String(id).replace(/[^\w.-]/g, '_')
const write = (rel, value) => {
  const path = join(outDir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 1) + '\n')
}

rmSync(join(outDir, 'data'), { recursive: true, force: true })

// A snapshot is not running, whatever it was doing when it was taken.
const runs = model.readRuns(projectRoot, 50).map((r) => ({ ...r, alive: false }))
write('data/runs.json', {
  project: basename(projectRoot),
  generated_at: new Date().toISOString(),
  runs,
  categories: model.eventCategories(),
})

let eventCount = 0
for (const summary of runs) {
  const run = model.readRun(projectRoot, summary.id)
  if (!run) continue
  write(`data/runs/${fileId(run.id)}.json`, { run: { ...run, alive: false } })
  const events = []
  for (let cursor = 0; ; ) {
    const page = model.readEventsSince(projectRoot, run.id, cursor, 2000)
    events.push(...page)
    if (page.length < 2000) break
    cursor = page[page.length - 1].id
  }
  eventCount += events.length
  write(`data/events/${fileId(run.id)}.json`, { events, more: false })
}
write('data/sessions.json', { sessions: model.readSessions(projectRoot, 50) })
write('index.html', page.replace(LIVE, '<meta name="opencastle-viewer" content="static">'))

console.log(`Exported ${runs.length} run(s) and ${eventCount} event(s) from ${projectRoot}`)
console.log(`  → ${join(outDir, 'index.html')}`)
