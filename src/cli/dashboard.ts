/**
 * `opencastle convoy dashboard` — a small, read-only, live view of convoy runs.
 *
 * One HTML page (src/cli/viewer/index.html, no build step) and four JSON
 * endpoints over the read model. Every request opens the database read-only,
 * queries and closes it, so what the page shows is what the store holds now —
 * the dashboard this replaces ran an ETL once at startup into a temp directory
 * and served that snapshot for as long as it stayed up.
 *
 *   GET /api/runs                       runs, newest first, plus the event categories
 *   GET /api/runs/:id                   one run with its tasks
 *   GET /api/runs/:id/events?since=<n>  that run's events after cursor n
 *   GET /api/sessions                   agent sessions recorded with `opencastle log`
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
  readEventsSince,
  readRun,
  readRuns,
  readSessions,
} from './convoy/read-model.js'
import { openUrl } from './run/platform.js'
import type { CliContext } from './types.js'

const DEFAULT_PORT = 4300
/** Ports tried after a busy one: 4300 through 4319. */
const PORT_ATTEMPTS = 20
const EVENTS_PAGE = 500

export interface ViewerOptions {
  projectRoot: string
  /** 0 asks the OS for a free port. Defaults to 4300, moving up while busy. */
  port?: number
  open?: boolean
}

export interface ViewerHandle {
  url: string
  close(): Promise<void>
}

/**
 * The page ships as a file in the package. From the TypeScript source it sits
 * beside this module; from the compiled `dist/cli/dashboard.js` it is back in
 * `src/`, which `files` in package.json publishes.
 */
function viewerPage(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'viewer', 'index.html'), join(here, '..', '..', 'src', 'cli', 'viewer', 'index.html')]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  throw new Error('The viewer page is missing from this installation (src/cli/viewer/index.html).')
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
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

function handler(projectRoot: string, page: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      if (!localHost(req)) return send(res, 403, { error: 'Forbidden host' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Read-only' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (path === '/' || path === '/index.html') return send(res, 200, page, 'text/html; charset=utf-8')
      if (path === '/api/runs') {
        return send(res, 200, { project: basename(projectRoot), runs: readRuns(projectRoot), categories: eventCategories() })
      }
      if (path === '/api/sessions') return send(res, 200, { sessions: readSessions(projectRoot) })

      const m = /^\/api\/runs\/([^/]+)(\/events)?$/.exec(path)
      if (m) {
        const id = decodeURIComponent(m[1])
        if (m[2]) {
          const since = Number(url.searchParams.get('since') ?? 0)
          if (!Number.isInteger(since) || since < 0) return send(res, 400, { error: 'since must be a non-negative integer' })
          const events = readEventsSince(projectRoot, id, since, EVENTS_PAGE)
          return send(res, 200, { events, more: events.length === EVENTS_PAGE })
        }
        const run = readRun(projectRoot, id)
        return run ? send(res, 200, { run }) : send(res, 404, { error: `No run "${id}" in this project` })
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

async function serve(opts: ViewerOptions): Promise<{ server: Server; url: string }> {
  const server = createServer(handler(opts.projectRoot, viewerPage()))
  const port = await listen(server, opts.port ?? DEFAULT_PORT)
  const url = `http://127.0.0.1:${port}`
  if (opts.open) openUrl(url)
  return { server, url }
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise((done) => {
      // The page polls with keep-alive; without this, close() waits for those sockets to time out.
      server.closeAllConnections()
      server.close(() => done())
    })
}

/** Start the viewer for one project. Resolves once it is listening. */
export async function startViewer(opts: ViewerOptions): Promise<ViewerHandle> {
  const { server, url } = await serve(opts)
  return { url, close: closer(server) }
}

/**
 * @deprecated For the five call sites in run.ts until they move to `startViewer`.
 * Same server; the project root is found from the working directory.
 */
export async function startDashboardServer(options: {
  port?: number
  openBrowser?: boolean
  pkgRoot?: string
  convoyId?: string
}): Promise<{ server: Server; port: number; url: string }> {
  const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd()
  const { server, url } = await serve({ projectRoot, port: options.port, open: options.openBrowser })
  return { server, port: (server.address() as AddressInfo).port, url }
}

// ── command ───────────────────────────────────────────────────────────────────

const HELP = `
  opencastle convoy dashboard [options]

  Open a live, read-only view of this project's convoy runs: tasks, their
  dependencies, status, tokens and cost, failure reasons, and the event feed.

  Options:
    --port <n>      Port to listen on (default ${DEFAULT_PORT}, moving up while busy; 0 picks a free one)
    --no-open       Print the URL without opening a browser
    --help, -h      Show this help
`

const FLAGS = ['--port', '--no-open', '--help', '-h']

function nearest(flag: string): string {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]
      row[0] = i
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j]
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = cur
      }
    }
    return row[b.length]
  }
  return FLAGS.reduce((best, f) => (distance(flag, f) < distance(flag, best) ? f : best))
}

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
      return { error: `Unknown option ${arg}. Did you mean ${nearest(arg)}?` }
    } else {
      return { error: `Unexpected argument "${arg}". The viewer shows every run; pick one on the page.` }
    }
  }
  return { port, open, help }
}

export default async function dashboard({ args }: CliContext): Promise<void> {
  const parsed = parseDashboardArgs(args)
  if ('error' in parsed) {
    console.error(`  ✗ ${parsed.error}`)
    console.error('  Run "opencastle convoy dashboard --help" for usage.')
    process.exit(1)
  }
  if (parsed.help) {
    console.log(HELP)
    return
  }

  const found = findProjectRoot(process.cwd())
  const projectRoot = found ?? process.cwd()
  let viewer: ViewerHandle
  try {
    viewer = await startViewer({ projectRoot, port: parsed.port, open: parsed.open })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const why = e.code === 'EADDRINUSE' ? `ports ${parsed.port}–${parsed.port + PORT_ATTEMPTS - 1} are all in use; try --port 0` : e.message
    console.error(`  ✗ Could not start the viewer: ${why}`)
    process.exit(1)
  }

  console.log('')
  console.log(`  Convoy viewer: ${viewer.url}`)
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
      void viewer.close().then(done)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  console.log('  Viewer stopped.')
}
