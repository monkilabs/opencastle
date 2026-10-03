#!/usr/bin/env node
/**
 * Export the Observability dashboard as a static page over recorded runs.
 *
 *   npm run cli:build
 *   node tools/dashboard-demo/export.mjs --out <dir> [--name <label>] <projectRoot>...
 *
 * Writes <dir>/index.html and the page's stylesheet, script and icon — the same
 * files `opencastle convoy dashboard` serves, switched to static mode — and
 * <dir>/data/*.json: the responses the dashboard's API gives, read through the
 * same compiled read model. Several projects combine into one snapshot: their
 * runs are listed together and the overview is computed over all of them, the
 * way it is for one project. Nothing is generated or made up; the page shows
 * the runs recorded in each <projectRoot>/.opencastle/convoy.db.
 *
 * A snapshot is never live: every run in it reads as not alive, and one that
 * was recorded as running reads as interrupted, as it would on a live page
 * once its process had gone.
 *
 * The website publishes tools/dashboard-demo/snapshot/ at opencastle.dev/dashboard
 * (see .github/workflows/deploy.yml). A deployed snapshot is public, so the
 * export replaces each project's own path with "<project>" and the home
 * directory with "~", and refuses to write anything that still holds an
 * absolute local path or the current user's name.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const USAGE = 'Usage: node tools/dashboard-demo/export.mjs --out <dir> [--name <label>] <projectRoot>...'

const args = process.argv.slice(2)
let outArg = null
let name = null
const projects = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outArg = args[++i]
  else if (args[i] === '--name') name = args[++i]
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else if (args[i].startsWith('-')) {
    console.error(`Unknown option ${args[i]}\n${USAGE}`)
    process.exit(1)
  } else projects.push(args[i])
}
if (!outArg || projects.length === 0) {
  console.error(USAGE)
  process.exit(1)
}

const readModelPath = join(repo, 'dist', 'cli', 'convoy', 'read-model.js')
if (!existsSync(readModelPath)) {
  console.error('dist/ is missing. Build the CLI first: npm run cli:build')
  process.exit(1)
}
const model = await import(pathToFileURL(readModelPath).href)

const roots = projects.map((p) => resolve(p))
for (const root of roots) {
  if (!existsSync(model.convoyDbPath(root))) {
    console.error(`No convoy runs recorded in ${root} (no .opencastle/convoy.db).`)
    process.exit(1)
  }
}
const outDir = resolve(outArg)

const pageDir = join(repo, 'src', 'cli', 'dashboard')
const LIVE = '<meta name="opencastle-dashboard" content="live">'
const page = readFileSync(join(pageDir, 'index.html'), 'utf8')
if (!page.includes(LIVE)) {
  console.error('The dashboard page has no mode marker to switch; was src/cli/dashboard/index.html changed?')
  process.exit(1)
}

// ── Local paths out ───────────────────────────────────────────────────────────

const replacements = []
for (const root of roots) {
  for (const p of new Set([root, safeRealpath(root)])) replacements.push([p, '<project>'])
}
const home = homedir()
for (const p of new Set([home, safeRealpath(home)])) replacements.push([p, '~'])
// Longest first, so a project inside the home directory becomes <project>, not ~/….
replacements.sort((a, b) => b[0].length - a[0].length)

function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function scrub(value) {
  if (typeof value === 'string') {
    let out = value
    for (const [from, to] of replacements) out = out.split(from).join(to)
    return out
  }
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
  return value
}

const user = userInfo().username
const FORBIDDEN = [/\/Users\//, /\/home\/[^/\s"]+/, /\/private\/(?:tmp|var)\//, /\/var\/folders\//, /[A-Z]:\\\\Users\\\\/i, ...(user && user.length > 2 ? [new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')] : [])]

// ── Read ──────────────────────────────────────────────────────────────────────

/** A snapshot is not running, whatever it was doing when it was taken. */
function settled(run) {
  const out = { ...run, alive: false, display_status: model.displayStatus(run.status, false) }
  if (Array.isArray(run.tasks)) out.tasks = run.tasks.map((t) => ({ ...t, display_status: model.taskDisplayStatus(t.status, false) }))
  return out
}

/** The page applies the same rule to find a run's files. */
const fileId = (id) => String(id).replace(/[^\w.-]/g, '_')

const files = new Map()
const write = (rel, value) => files.set(rel, typeof value === 'string' ? value : JSON.stringify(scrub(value), null, 1) + '\n')

const parts = []
const allRuns = []
const sessions = []
let eventCount = 0
const seen = new Map()
for (const root of roots) {
  const part = model.readOverviewParts(root)
  part.runs = part.runs.map(settled)
  part.tasks = part.tasks.map((t) => ({ ...t, display_status: model.taskDisplayStatus(t.display_status, false) }))
  parts.push(part)
  for (const summary of part.runs) {
    if (seen.has(summary.id)) {
      console.error(`Run ${summary.id} is in both ${seen.get(summary.id)} and ${root}; a snapshot needs each run once.`)
      process.exit(1)
    }
    seen.set(summary.id, root)
    allRuns.push(summary)
    const run = model.readRun(root, summary.id)
    if (!run) continue
    write(`data/runs/${fileId(run.id)}.json`, { run: settled(run), insights: model.readRunInsights(root, run.id) })
    const events = []
    for (let cursor = 0; ; ) {
      const batch = model.readEventsSince(root, run.id, cursor, 2000)
      events.push(...batch)
      if (batch.length < 2000) break
      cursor = batch[batch.length - 1].id
    }
    eventCount += events.length
    write(`data/events/${fileId(run.id)}.json`, { events, more: false })
  }
  sessions.push(...model.readAllSessions(root, 50))
}
allRuns.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
sessions.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))

write('data/runs.json', {
  project: name ?? (roots.length === 1 ? basename(roots[0]) : `${roots.length} projects`),
  projects: roots.length,
  generated_at: new Date().toISOString(),
  runs: allRuns,
  categories: model.eventCategories(),
  overview: model.overviewFrom(parts),
})
write('data/sessions.json', { sessions: sessions.slice(0, 50) })

// ── Check, then write ─────────────────────────────────────────────────────────

const hits = []
for (const [rel, text] of files) {
  for (const re of FORBIDDEN) {
    const m = re.exec(text)
    if (m) hits.push(`${rel}: …${text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ')}…`)
  }
}
if (hits.length) {
  console.error('Refusing to write a snapshot that holds local paths or the user name:')
  for (const h of hits.slice(0, 20)) console.error(`  ${h}`)
  process.exit(1)
}

rmSync(join(outDir, 'data'), { recursive: true, force: true })
for (const [rel, text] of files) {
  const path = join(outDir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
writeFileSync(join(outDir, 'index.html'), page.replace(LIVE, '<meta name="opencastle-dashboard" content="static">'))
for (const asset of ['dashboard.css', 'dashboard.js', 'icon-192.png']) copyFileSync(join(pageDir, asset), join(outDir, asset))
// The page from before the merge kept everything in one file; nothing else belongs here.
for (const entry of readdirSync(outDir)) {
  if (!['index.html', 'dashboard.css', 'dashboard.js', 'icon-192.png', 'data'].includes(entry) && statSync(join(outDir, entry)).isFile()) rmSync(join(outDir, entry))
}

console.log(`Exported ${allRuns.length} run(s) and ${eventCount} event(s) from ${roots.length} project(s)`)
console.log(`  → ${join(outDir, 'index.html')}`)
