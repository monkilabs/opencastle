import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { readFile, access } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, extname } from 'node:path'
import { execFile } from 'node:child_process'
import type { CliContext } from './types.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ndjson': 'application/x-ndjson',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const DATA_FILES = [
  'events.ndjson',
  'pipelines.ndjson',
  // Legacy individual files — kept for backwards compatibility
  'sessions.ndjson',
  'delegations.ndjson',
  'panels.ndjson',
  'reviews.ndjson',
  'disputes.ndjson',
]

interface DashboardArgs {
  port: number
  openBrowser: boolean
  seed: boolean
  convoyId?: string
  help: boolean
}

export interface DashboardServerOptions {
  port?: number
  openBrowser?: boolean
  seed?: boolean
  pkgRoot: string
  convoyId?: string
}

export interface DashboardServerResult {
  server: Server
  port: number
  url: string
}

const DASHBOARD_HELP = `
  opencastle dashboard [options]

  Start the observability dashboard server.

  Options:
    --port <number>    Port to listen on (default: 4300, auto-increments if busy)
    --no-open          Don't auto-open the browser
    --seed             Show demo data instead of project logs
    --convoy <id>      Filter dashboard to a specific convoy
    --help, -h         Show this help
`

function parseArgs(args: string[]): DashboardArgs {
  let port = 4300
  let openBrowser = true
  let seed = false
  let convoyId: string | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      help = true
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      if (isNaN(port)) { console.error('  ✗ --port requires a valid number'); process.exit(1) }
      i++
    } else if (args[i] === '--no-open') {
      openBrowser = false
    } else if (args[i] === '--seed') {
      seed = true
    } else if (args[i] === '--convoy' && args[i + 1]) {
      convoyId = args[i + 1]
      if (!convoyId.trim()) { console.error('  ✗ --convoy cannot be empty'); process.exit(1) }
      i++
    }
  }

  return { port, openBrowser, seed, convoyId, help }
}

function openUrl(url: string): void {
  const plat = process.platform
  const cmd =
    plat === 'darwin'
      ? 'open'
      : plat === 'win32'
        ? 'start'
        : 'xdg-open'
  execFile(cmd, [url])
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function tryListen(
  server: Server,
  port: number,
  maxAttempts = 10
): Promise<number> {
  return new Promise((res, rej) => {
    let attempt = 0

    function attemptListen(): void {
      const currentPort = port + attempt

      const onError = (err: Error & { code?: string }): void => {
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt++
          attemptListen()
        } else {
          rej(err)
        }
      }

      server.once('error', onError)
      server.listen(currentPort, '127.0.0.1', () => {
        server.removeListener('error', onError)
        res(currentPort)
      })
    }

    attemptListen()
  })
}

export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServerResult> {
  const port = options.port ?? 4300
  const seed = options.seed ?? false
  const { pkgRoot } = options

  const distDir = resolve(pkgRoot, 'src', 'dashboard', 'dist')
  const seedDir = resolve(pkgRoot, 'src', 'dashboard', 'seed-data')
  const projectRoot = process.cwd()
  const convoyLogsDir = resolve(projectRoot, '.opencastle', 'logs')

  const runtimeDataDir = seed ? null : mkdtempSync(join(tmpdir(), 'opencastle-dashboard-'))
  if (runtimeDataDir) {
    try {
      const { runEtl } = await import('../dashboard/scripts/etl.js')
      const dbPath = resolve(projectRoot, '.opencastle', 'convoy.db')
      await runEtl({ dbPath, outputDir: runtimeDataDir })
    } catch {
      // ETL failure should not block dashboard — it will serve empty data
    }
  }

  // Check if dist exists
  if (!(await fileExists(distDir))) {
    throw new Error(
      'Dashboard not built. Run "npm run dashboard:build" in the opencastle package first.'
    )
  }

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        let pathname = decodeURIComponent(url.pathname)

        // Serve index.html for root
        if (pathname === '/') {
          pathname = '/index.html'
        }

        // Handle refresh requests — re-run ETL on demand
        if (pathname === '/data/refresh' && runtimeDataDir) {
          try {
            const { runEtl } = await import('../dashboard/scripts/etl.js')
            const dbPath = resolve(projectRoot, '.opencastle', 'convoy.db')
            const result = await runEtl({ dbPath, outputDir: runtimeDataDir })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, convoyCount: result.convoyCount }))
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, convoyCount: 0 }))
          }
          return
        }

        // Handle active convoy resolution — queries DB directly (no ETL needed)
        if (pathname === '/data/active-convoy.json' && !seed) {
          try {
            const { createConvoyStore } = await import('./convoy/store.js')
            const dbPath = resolve(projectRoot, '.opencastle', 'convoy.db')
            const { existsSync } = await import('node:fs')
            if (!existsSync(dbPath)) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ convoy: null, pipeline: null }))
              return
            }
            const store = createConvoyStore(dbPath)
            try {
              // Find the running convoy, or fall back to the latest
              const allConvoys = store.getConvoyList(10, 0)
              const running = allConvoys.find(c => c.status === 'running')
              const pending = allConvoys.find(c => c.status === 'pending')
              const target = running ?? pending ?? (allConvoys.length > 0 ? allConvoys[0] : null)

              let pipelineConvoys: Array<{ id: string; name: string; status: string }> | null = null
              if (target?.pipeline_id) {
                const pipeConvoys = store.getConvoysByPipeline(target.pipeline_id)
                pipelineConvoys = pipeConvoys.map(c => ({ id: c.id, name: c.name, status: c.status }))
              }

              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                convoy: target ? { id: target.id, name: target.name, status: target.status, pipeline_id: target.pipeline_id ?? null } : null,
                pipeline: pipelineConvoys,
              }))
            } finally {
              store.close()
            }
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ convoy: null, pipeline: null }))
          }
          return
        }

        // Handle data file requests — proxy to project logs or dist
        const dataMatch = pathname.match(/^\/data\/(.+\.ndjson)$/)
        if (dataMatch && DATA_FILES.includes(dataMatch[1])) {
          const filename = dataMatch[1]

          if (seed) {
            const filePath = join(seedDir, filename)
            if (await fileExists(filePath)) {
              const content = await readFile(filePath)
              res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
              res.end(content)
            } else {
              res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
              res.end('')
            }
          } else {
            const convoyPath = join(convoyLogsDir, filename)
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
            res.end(await fileExists(convoyPath) ? await readFile(convoyPath) : '')
          }
          return
        }

        // Handle JSON data requests — serve from runtime ETL output or dist
        const jsonDataMatch = pathname.match(/^\/data\/(.+\.json)$/)
        if (jsonDataMatch) {
          const jsonFilename = jsonDataMatch[1]
          const dataSource = runtimeDataDir ?? resolve(distDir, 'data')
          const jsonPath = resolve(dataSource, jsonFilename)

          // Security: prevent path traversal
          if (!jsonPath.startsWith(dataSource)) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }

          if (await fileExists(jsonPath)) {
            const content = await readFile(jsonPath)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(content)
          } else {
            res.writeHead(404)
            res.end('Not Found')
          }
          return
        }

        // Serve static files from dist/
        const filePath = resolve(distDir, pathname.slice(1))

        // Security: prevent path traversal
        if (!filePath.startsWith(distDir)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        if (await fileExists(filePath)) {
          const ext = extname(filePath)
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
          const content = await readFile(filePath)
          res.writeHead(200, { 'Content-Type': contentType })
          res.end(content)
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      } catch {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    }
  )

  const actualPort = await tryListen(server, port)
  const resolvedUrl = `http://localhost:${actualPort}`

  if (options.openBrowser) {
    const fullUrl = options.convoyId ? `${resolvedUrl}/?convoy=${options.convoyId}` : resolvedUrl
    openUrl(fullUrl)
  }

  return { server, port: actualPort, url: resolvedUrl }
}

export default async function dashboard({
  pkgRoot,
  args,
}: CliContext): Promise<void> {
  const { port, openBrowser, seed, convoyId, help } = parseArgs(args)

  if (help) {
    console.log(DASHBOARD_HELP)
    return
  }

  // Check if any log files exist (for messaging)
  let hasLogs = false
  if (!seed) {
    const projectRoot = process.cwd()
    const convoyLogsDir2 = resolve(projectRoot, '.opencastle', 'logs')
    for (const f of ['events.ndjson', ...DATA_FILES]) {
      if (await fileExists(join(convoyLogsDir2, f))) {
        hasLogs = true
        break
      }
    }
  }

  const dashResult = await startDashboardServer({ port, seed, pkgRoot, convoyId, openBrowser })

  console.log('')
  console.log('  \u{1F3F0} OpenCastle Dashboard')
  console.log('')

  if (convoyId) {
    console.log(`  \u2192 ${dashResult.url}/?convoy=${convoyId}`)
    console.log(`  \u{1F4C2} Watching convoy: ${convoyId}`)
  } else {
    console.log(`  \u2192 ${dashResult.url}`)
    if (seed) {
      console.log(
        '  \u{1F4C2} Showing demo data (use without --seed to read project logs)'
      )
    } else if (hasLogs) {
      console.log('  \u{1F4C2} Reading logs from .opencastle/logs/')
    } else {
      console.log(
        '  \u{1F4A1} No agent logs found. Run agents with OpenCastle to generate data, or use --seed for demo data.'
      )
    }
  }

  console.log('')
  console.log('  Press Ctrl+C to stop')
  console.log('')

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n  Dashboard stopped.\n')
    dashResult.server.close()
    process.exit(0)
  })

  // Keep the process alive
  await new Promise<never>(() => {})
}
