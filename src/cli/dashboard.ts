/**
 * `opencastle convoy dashboard` — the Observability dashboard: a read-only,
 * live view of a project's convoy runs.
 *
 * The page is four files in the package (src/cli/dashboard/: the HTML, its
 * stylesheet, its script and an icon), with no build step, and a JSON API over
 * the read model. Every request opens the database read-only, queries and
 * closes it, so what the page shows is what the store holds now. The dashboard
 * this replaced ran an ETL once at startup into a temp directory and served that
 * snapshot for as long as it stayed up.
 *
 *   GET /api/runs                       runs, newest first, the event categories, and the overview of every run
 *   GET /api/runs/:id                   one run with its tasks, and what its events and side tables add
 *   GET /api/runs/:id/events?since=<n>  that run's events after cursor n (&limit, at most 2000)
 *   GET /api/sessions                   agent sessions: the engine's, one per task a convoy finished
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  convoyDbPath,
  eventCategories,
  findProjectRoot,
  readAllSessions,
  readEventsSince,
  readOverview,
  readRun,
  readRunInsights,
  readRuns,
} from './convoy/read-model.js'
import { openUrl } from './run/platform.js'
import { nearest } from './nearest.js'
import type { CliContext } from './types.js'

const DEFAULT_PORT = 4300
/** Ports tried after a busy one: 4300 through 4319. */
const PORT_ATTEMPTS = 20
const EVENTS_PAGE = 500
const EVENTS_MAX = 2000
/** The runs the list carries; the overview counts every run regardless. */
const RUNS_LISTED = 500

export interface DashboardOptions {
  projectRoot: string
  /** 0 asks the OS for a free port. Defaults to 4300, moving up while busy. */
  port?: number
  open?: boolean
}

export interface DashboardHandle {
  url: string
  close(): Promise<void>
}

/** The page's files, and the only paths served besides the API. */
export const PAGE_FILES: Readonly<Record<string, string>> = {
  'index.html': 'text/html; charset=utf-8',
  'dashboard.css': 'text/css; charset=utf-8',
  'dashboard.js': 'text/javascript; charset=utf-8',
  'icon-192.png': 'image/png',
}

/**
 * The page ships as files in the package. From the TypeScript source they sit
 * beside this module; from the compiled `dist/cli/dashboard.js` they are back
 * in `src/`, which `files` in package.json publishes.
 */
export function pageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'dashboard'), join(here, '..', '..', 'src', 'cli', 'dashboard')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  throw new Error('The dashboard page is missing from this installation (src/cli/dashboard/index.html).')
}

/**
 * Same-origin only: the page loads its own script and stylesheet and calls its
 * own API. Inline style attributes carry the chart widths, so styles allow them;
 * scripts do not.
 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}),
  })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

/**
 * Bound to 127.0.0.1, but a web page elsewhere can still reach it through DNS
 * rebinding: a name it controls re-pointed at 127.0.0.1. The Host header gives
 * that away, so only requests addressed to this machine by name or number are
 * answered.
 */
function localHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

function intParam(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  return /^\d+$/.test(raw) ? Number(raw) : null
}

function handler(projectRoot: string, dir: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      if (!localHost(req)) return send(res, 403, { error: 'Forbidden host' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Read-only' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      // Read on every request, so an edit to the page shows on the next reload.
      const file = path === '/' ? 'index.html' : path.slice(1)
      if (Object.hasOwn(PAGE_FILES, file)) return send(res, 200, readFileSync(join(dir, file)), PAGE_FILES[file])

      if (path === '/api/runs') {
        return send(res, 200, {
          project: basename(projectRoot),
          runs: readRuns(projectRoot, RUNS_LISTED),
          categories: eventCategories(),
          overview: readOverview(projectRoot),
        })
      }
      if (path === '/api/sessions') return send(res, 200, { sessions: readAllSessions(projectRoot, 50) })

      const m = /^\/api\/runs\/([^/]+)(\/events)?$/.exec(path)
      if (m) {
        const id = decodeURIComponent(m[1])
        if (m[2]) {
          const since = intParam(url, 'since', 0)
          if (since === null) return send(res, 400, { error: 'since must be a non-negative integer' })
          const limit = intParam(url, 'limit', EVENTS_PAGE)
          if (limit === null || limit < 1 || limit > EVENTS_MAX) return send(res, 400, { error: `limit must be a whole number from 1 to ${EVENTS_MAX}` })
          // One more than asked says whether there is more, without a second query.
          const read = readEventsSince(projectRoot, id, since, limit + 1)
          return send(res, 200, { events: read.slice(0, limit), more: read.length > limit })
        }
        const run = readRun(projectRoot, id)
        if (!run) return send(res, 404, { error: `No run "${id}" in this project` })
        return send(res, 200, { run, insights: readRunInsights(projectRoot, id) })
      }
      send(res, 404, { error: 'Not found' })
    } catch (err) {
      send(res, 500, { error: (err as Error).message })
    }
  }
}

/**
 * Listen on exactly one port and report the one actually bound.
 *
 * Both listeners are removed whichever fires. The old loop left each failed
 * attempt's `listening` callback registered, so after a busy port the first
 * stale callback resolved with the busy port's number, and the URL printed —
 * and opened — pointed at whatever else was listening there.
 */
function listenOnce(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolvePort((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function listen(server: Server, port: number): Promise<number> {
  const last = port === 0 ? 0 : Math.min(65535, port + PORT_ATTEMPTS - 1)
  for (let p = port; ; p++) {
    try {
      return await listenOnce(server, p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || p >= last) throw err
    }
  }
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise((done) => {
      // The page polls with keep-alive; without this, close() waits for those sockets to time out.
      server.closeAllConnections()
      server.close(() => done())
    })
}

/** Start the dashboard for one project. Resolves once it is listening. */
export async function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const server = createServer(handler(opts.projectRoot, pageDir()))
  const port = await listen(server, opts.port ?? DEFAULT_PORT)
  const url = `http://127.0.0.1:${port}`
  if (opts.open) openUrl(url)
  return { url, close: closer(server) }
}

// ── command ───────────────────────────────────────────────────────────────────

const HELP = `
  npx opencastle convoy dashboard [options]

  Open the Observability dashboard: a live, read-only view of this project's
  convoy runs. Totals across every run; and for each run its tasks and what
  they wait for, tokens and cost, reviews, checks, retries, failure reasons
  and the event timeline. Every figure is read from .opencastle/convoy.db.

  Options:
    --port <n>      Port to listen on (default ${DEFAULT_PORT}, moving up while busy; 0 picks a free one)
    --no-open       Print the URL without opening a browser
    --help, -h      Show this help
`

const FLAGS = ['--port', '--no-open', '--help', '-h']

export function parseDashboardArgs(args: string[]): { port: number; open: boolean; help: boolean } | { error: string } {
  let port = DEFAULT_PORT
  let open = true
  let help = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--no-open') open = false
    else if (arg === '--port') {
      const raw = args[++i]
      if (raw === undefined || raw.startsWith('-')) return { error: '--port needs a number, e.g. --port 4300' }
      port = Number(raw)
      if (!/^\d+$/.test(raw) || port > 65535) return { error: `--port must be a whole number from 0 to 65535, not "${raw}"` }
    } else if (arg.startsWith('-')) {
      const near = nearest(arg, FLAGS)
      return { error: `Unknown option ${arg}. ${near ? `Did you mean ${near}?` : `It accepts ${FLAGS.join(', ')}.`}` }
    } else {
      return { error: `Unexpected argument "${arg}". The dashboard shows every run; pick one on the page.` }
    }
  }
  return { port, open, help }
}

export default async function dashboard({ args }: CliContext): Promise<void> {
  const parsed = parseDashboardArgs(args)
  if ('error' in parsed) {
    console.error(`  ✗ ${parsed.error}`)
    console.error('  Run "npx opencastle convoy dashboard --help" for usage.')
    process.exit(1)
  }
  if (parsed.help) {
    console.log(HELP)
    return
  }

  const found = findProjectRoot(process.cwd())
  const projectRoot = found ?? process.cwd()
  let dash: DashboardHandle
  try {
    dash = await startDashboard({ projectRoot, port: parsed.port, open: parsed.open })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const why = e.code === 'EADDRINUSE' ? `ports ${parsed.port}–${parsed.port + PORT_ATTEMPTS - 1} are all in use; try --port 0` : e.message
    console.error(`  ✗ Could not start the dashboard: ${why}`)
    process.exit(1)
  }

  console.log('')
  console.log(`  Dashboard: ${dash.url}`)
  console.log(`  Project: ${projectRoot}`)
  if (!found) console.log('  No .opencastle/ here or above; showing this directory, which has no runs.')
  else if (!existsSync(convoyDbPath(projectRoot))) console.log('  No convoy runs yet. They appear on the page as they start.')
  console.log('')
  console.log('  Press Ctrl+C to stop')
  console.log('')

  await new Promise<void>((done) => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      void dash.close().then(done)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  console.log('  Dashboard stopped.')
}
