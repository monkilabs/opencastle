import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConvoyStore } from './convoy/store.js'
import { PAGE_FILES, pageDir, parseDashboardArgs, startDashboard } from './dashboard.js'
import type { DashboardHandle } from './dashboard.js'

let root: string
const open: DashboardHandle[] = []
const blockers: Server[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-')))
  mkdirSync(join(root, '.opencastle'), { recursive: true })
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((v) => v.close()))
  await Promise.all(blockers.splice(0).map((s) => new Promise((done) => s.close(done))))
  rmSync(root, { recursive: true, force: true })
})

async function dashboard(port = 0): Promise<DashboardHandle> {
  const v = await startDashboard({ projectRoot: root, port, open: false })
  open.push(v)
  return v
}

function portOf(url: string): number {
  return Number(new URL(url).port)
}

/** A server that is not ours, holding a port and answering with its own name. */
async function occupy(port = 0): Promise<number> {
  const s = createServer((_, res) => res.end('someone else'))
  blockers.push(s)
  await new Promise<void>((done) => s.listen(port, '127.0.0.1', done))
  return (s.address() as AddressInfo).port
}

function seed(): void {
  const store = createConvoyStore(join(root, '.opencastle', 'convoy.db'))
  const at = '2026-10-01T10:00:00.000Z'
  store.insertConvoy({ id: 'convoy-1', name: 'Demo', spec_hash: 'h', status: 'pending', branch: null, created_at: at, spec_yaml: 'x' })
  store.insertTask({
    id: 'a', convoy_id: 'convoy-1', phase: 0, prompt: 'p', agent: 'developer', adapter: null, model: null,
    timeout_ms: 1000, status: 'pending', retries: 0, max_retries: 0, files: null, depends_on: null, gates: null,
  })
  store.updateConvoyStatus('convoy-1', 'done', { started_at: at, finished_at: at })
  for (const type of ['convoy_started', 'task_started', 'task_done', 'convoy_finished']) {
    store.insertEvent({ convoy_id: 'convoy-1', task_id: null, worker_id: null, type, data: null, created_at: at })
  }
  store.close()
}

async function json(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('startDashboard', () => {
  it('binds 127.0.0.1 and reports the port the OS gave it', async () => {
    const v = await dashboard(0)
    expect(v.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(portOf(v.url)).toBeGreaterThan(0)
    const res = await fetch(v.url)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('name="opencastle-dashboard" content="live"')
  })

  it('serves the page, its stylesheet, script and icon from the package, and nothing else from disk', async () => {
    const v = await dashboard()
    const page = await fetch(`${v.url}/`)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    const html = await page.text()
    for (const file of ['dashboard.css', 'dashboard.js', 'icon-192.png']) {
      expect(html).toContain(file)
      const res = await fetch(`${v.url}/${file}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(PAGE_FILES[file])
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(pageDir(), file)))).toBe(true)
    }
    expect((await fetch(`${v.url}/index.html`)).status).toBe(200)
    for (const path of ['/dashboard.ts', '/../package.json', '/%2e%2e/package.json', '/data/runs.json', '/.opencastle/convoy.db']) {
      expect((await fetch(`${v.url}${path}`)).status).toBe(404)
    }
  })

  it('the page reads only data the API returns', () => {
    // No figure is made up in the browser: no seed data, no per-task token
    // guess, no tier inferred from a model name, no phase labels.
    const script = readFileSync(join(pageDir(), 'dashboard.js'), 'utf8')
    for (const banned of [/\*\s*5000\b/, /estTokens/, /\bderiveTier\b/, /PREMIUM_AGENTS|ECONOMY_AGENTS/, /Foundation|Integration|Validation|QA Gate/, /seed/i, /Math\.random/, /\bphase\b/]) {
      expect(script).not.toMatch(banned)
    }
  })

  it('moves past a busy port and reports the one it actually bound', async () => {
    const busy = await occupy()
    const v = await dashboard(busy)
    expect(portOf(v.url)).toBe(busy + 1)
    expect(await (await fetch(v.url)).text()).toContain('opencastle-dashboard')
    // The other process keeps its port and its answers.
    expect(await (await fetch(`http://127.0.0.1:${busy}`)).text()).toBe('someone else')
  })

  it('skips several busy ports in a row', async () => {
    const first = await occupy()
    let second: number
    try {
      second = await occupy(first + 1)
    } catch {
      return // the next port happened to be taken by something else; nothing to assert
    }
    const v = await dashboard(first)
    expect(portOf(v.url)).toBe(second + 1)
  })

  it('serves runs with the overview, one run with its insights, events after a cursor, and sessions', async () => {
    seed()
    mkdirSync(join(root, '.opencastle', 'logs'), { recursive: true })
    writeFileSync(
      join(root, '.opencastle', 'logs', 'events.ndjson'),
      JSON.stringify({ type: 'session', timestamp: '2026-10-01T10:00:00.000Z', agent: 'Developer', task: 't', outcome: 'success' }) + '\n',
    )
    const v = await dashboard()

    const runs = await json(`${v.url}/api/runs`)
    expect(runs.status).toBe(200)
    expect(runs.body.project).toBe(root.split(/[\\/]/).pop())
    expect((runs.body.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['convoy-1'])
    expect((runs.body.categories as Record<string, string[]>).task).toContain('task_failed')
    expect(runs.body.overview).toMatchObject({ runs: { total: 1, by_status: { done: 1 } }, tasks: { total: 1 }, tokens: { total: null } })

    const run = await json(`${v.url}/api/runs/convoy-1`)
    expect(run.body.run).toMatchObject({ id: 'convoy-1', name: 'Demo', alive: false, tasks_total: 1, display_status: 'done' })
    expect(run.body.insights).toMatchObject({ events_recorded: true, starts: {}, reviews: [], checks: [], dlq: [], artifacts: [] })

    const all = await json(`${v.url}/api/runs/convoy-1/events?since=0`)
    const events = all.body.events as Array<{ id: number; type: string }>
    expect(events.map((e) => e.type)).toEqual(['convoy_started', 'task_started', 'task_done', 'convoy_finished'])
    expect(all.body.more).toBe(false)
    const newer = await json(`${v.url}/api/runs/convoy-1/events?since=${events[1].id}`)
    expect((newer.body.events as Array<{ type: string }>).map((e) => e.type)).toEqual(['task_done', 'convoy_finished'])

    const page = await json(`${v.url}/api/runs/convoy-1/events?since=0&limit=3`)
    expect((page.body.events as unknown[]).length).toBe(3)
    expect(page.body.more).toBe(true)
    const rest = await json(`${v.url}/api/runs/convoy-1/events?since=${(page.body.events as Array<{ id: number }>)[2].id}&limit=3`)
    expect((rest.body.events as Array<{ type: string }>).map((e) => e.type)).toEqual(['convoy_finished'])
    expect(rest.body.more).toBe(false)

    const sessions = await json(`${v.url}/api/sessions`)
    expect(sessions.body.sessions).toMatchObject([{ source: 'log', agent: 'Developer', outcome: 'success' }])
  })

  it('answers unknown runs and paths with 404, and a bad cursor with 400', async () => {
    seed()
    const v = await dashboard()
    expect((await json(`${v.url}/api/runs/nope`)).status).toBe(404)
    expect((await json(`${v.url}/api/nothing`)).status).toBe(404)
    expect((await json(`${v.url}/api/runs/convoy-1/events?since=-1`)).status).toBe(400)
    expect((await json(`${v.url}/api/runs/convoy-1/events?since=abc`)).status).toBe(400)
    expect((await json(`${v.url}/api/runs/convoy-1/events?limit=0`)).status).toBe(400)
    expect((await json(`${v.url}/api/runs/convoy-1/events?limit=5000`)).status).toBe(400)
  })

  it('is read-only', async () => {
    const v = await dashboard()
    expect((await fetch(`${v.url}/api/runs`, { method: 'POST' })).status).toBe(405)
  })

  it('shows an empty project without creating a database', async () => {
    const v = await dashboard()
    expect((await json(`${v.url}/api/runs`)).body.runs).toEqual([])
    expect(readdirSync(join(root, '.opencastle'))).toEqual([])
  })

  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const v = await dashboard()
    const status = await new Promise<number>((done, fail) => {
      const req = request(`${v.url}/api/runs`, { headers: { Host: 'attacker.example' } }, (res) => {
        res.resume()
        done(res.statusCode ?? 0)
      })
      req.on('error', fail)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('closes promptly with a keep-alive connection open', async () => {
    const v = await startDashboard({ projectRoot: root, port: 0, open: false })
    await fetch(`${v.url}/api/runs`) // leaves a pooled keep-alive socket behind
    const started = Date.now()
    await v.close()
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(fetch(`${v.url}/api/runs`)).rejects.toThrow()
  })
})

const repoRoot = join(import.meta.dirname, '..', '..')
const exporter = join(repoRoot, 'tools', 'dashboard-demo', 'export.mjs')
const assembler = join(repoRoot, 'tools', 'dashboard-demo', 'assemble.mjs')

/** The static site assemble.mjs builds from a snapshot directory. */
function assemble(from: string, to: string): void {
  execFileSync(process.execPath, [assembler, from, to], { stdio: 'pipe' })
}

/** The site is the page the CLI serves, switched to static mode, beside the data. */
function expectStaticPage(site: string): void {
  expect(readFileSync(join(site, 'index.html'), 'utf8')).toBe(
    readFileSync(join(pageDir(), 'index.html'), 'utf8').replace('content="live"', 'content="static"'),
  )
  for (const file of ['dashboard.css', 'dashboard.js', 'icon-192.png']) {
    expect(readFileSync(join(site, file)).equals(readFileSync(join(pageDir(), file)))).toBe(true)
  }
}
const snapshot = join(repoRoot, 'tools', 'dashboard-demo', 'snapshot')
const built = existsSync(join(repoRoot, 'dist', 'cli', 'convoy', 'read-model.js'))

/** A second project beside `root`, with one run whose events mention where it lives. */
function secondProject(extra = ''): string {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-other-')))
  mkdirSync(join(other, '.opencastle'), { recursive: true })
  const store = createConvoyStore(join(other, '.opencastle', 'convoy.db'))
  const at = '2026-10-02T10:00:00.000Z'
  store.insertConvoy({ id: 'convoy-2', name: 'Other', spec_hash: 'h', status: 'pending', branch: null, created_at: at, spec_yaml: 'x' })
  store.updateConvoyStatus('convoy-2', 'running', { started_at: at })
  store.insertEvent({
    convoy_id: 'convoy-2', task_id: null, worker_id: null, type: 'merge_failed',
    data: JSON.stringify({ branch: 'b', error: `cannot lock ${other}/.git/HEAD${extra}` }), created_at: at,
  })
  store.close()
  return other
}

function run(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [exporter, ...args], { stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stderr: Buffer }
    return { status: e.status, stderr: String(e.stderr) }
  }
}

// The exporter reads through the compiled read model, as it does when run by hand.
describe.skipIf(!built)('the static export', () => {
  it('writes every file the page reads, and only data, combining projects', () => {
    seed()
    const other = secondProject()
    try {
      const out = join(root, 'out')
      expect(run(['--out', out, '--name', 'examples', root, other]).status).toBe(0)
      // No copy of the page: assemble.mjs puts the current one beside the data.
      expect(readdirSync(out)).toEqual(['data'])
      const site = join(root, 'site')
      assemble(out, site)
      expectStaticPage(site)
      const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(out, 'data', rel), 'utf8'))
      const runs = read('runs.json')
      expect(runs).toMatchObject({ project: 'examples', projects: 2 })
      // A snapshot is never live; the run left "running" reads as interrupted.
      expect(runs.runs).toMatchObject([
        { id: 'convoy-2', alive: false, status: 'running', display_status: 'interrupted' },
        { id: 'convoy-1', alive: false, display_status: 'done' },
      ])
      expect(runs.overview).toMatchObject({ runs: { total: 2, by_status: { done: 1, interrupted: 1 } } })
      expect(read('runs/convoy-1.json')).toMatchObject({ run: { id: 'convoy-1', tasks: [{ id: 'a' }] }, insights: { events_recorded: true } })
      expect((read('events/convoy-1.json').events as unknown[]).length).toBe(4)
      expect(read('sessions.json').sessions).toEqual([])
      // The project's own path is replaced before anything is written.
      const events = JSON.stringify(read('events/convoy-2.json'))
      expect(events).toContain('cannot lock <project>/.git/HEAD')
      expect(events).not.toContain(other)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('refuses to write a snapshot that still holds a local path', () => {
    seed()
    const other = secondProject(' (see /Users/someone/notes.txt)')
    try {
      const out = join(root, 'out')
      const res = run(['--out', out, root, other])
      expect(res.status).toBe(1)
      expect(res.stderr).toMatch(/Refusing to write/)
      expect(existsSync(join(out, 'data'))).toBe(false)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('refuses a project with no runs, and a run that two projects both hold', () => {
    const out = join(root, 'out')
    expect(run(['--out', out, root]).stderr).toMatch(/No convoy runs recorded/)
    seed()
    const twin = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-twin-')))
    try {
      mkdirSync(join(twin, '.opencastle'), { recursive: true })
      execFileSync('cp', [join(root, '.opencastle', 'convoy.db'), join(twin, '.opencastle', 'convoy.db')])
      expect(run(['--out', out, root, twin]).stderr).toMatch(/is in both/)
    } finally {
      rmSync(twin, { recursive: true, force: true })
    }
  })
})

describe('the committed demo snapshot', () => {
  const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(snapshot, rel), 'utf8'))

  it('holds data only, and assembles into the page the CLI serves, as the deploy does', () => {
    expect(readdirSync(snapshot)).toEqual(['data'])
    const site = mkdtempSync(join(tmpdir(), 'dashboard-site-'))
    try {
      assemble(snapshot, site)
      expectStaticPage(site)
      expect(existsSync(join(site, 'data', 'runs.json'))).toBe(true)
    } finally {
      rmSync(site, { recursive: true, force: true })
    }
  })

  it('has a file for every run it lists, and none is live', () => {
    const runs = read('data/runs.json') as { runs: Array<{ id: string; alive: boolean }>; overview: { runs: { total: number } } }
    expect(runs.runs.length).toBeGreaterThan(1)
    expect(runs.overview.runs.total).toBe(runs.runs.length)
    for (const r of runs.runs) {
      expect(r.alive).toBe(false)
      const file = r.id.replace(/[^\w.-]/g, '_')
      const detail = read(`data/runs/${file}.json`) as { run: { tasks: unknown[] }; insights: unknown }
      expect(Array.isArray(detail.run.tasks)).toBe(true)
      expect(detail.insights).toBeTruthy()
      expect(existsSync(join(snapshot, 'data', 'events', `${file}.json`))).toBe(true)
    }
    expect(existsSync(join(snapshot, 'data', 'sessions.json'))).toBe(true)
  })

  it('holds no local path', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    for (const file of walk(join(snapshot, 'data'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\/Users\/|\/home\/|\/private\/(tmp|var)|\/var\/folders|claude-501/)
    }
  })
})

describe('parseDashboardArgs', () => {
  it('defaults to port 4300 and opening a browser', () => {
    expect(parseDashboardArgs([])).toEqual({ port: 4300, open: true, help: false })
  })

  it('reads --port, including 0, and --no-open', () => {
    expect(parseDashboardArgs(['--port', '0', '--no-open'])).toEqual({ port: 0, open: false, help: false })
    expect(parseDashboardArgs(['--port', '5000'])).toMatchObject({ port: 5000 })
  })

  it('refuses a missing or invalid port instead of ignoring it', () => {
    expect(parseDashboardArgs(['--port'])).toHaveProperty('error')
    expect(parseDashboardArgs(['--port', '--no-open'])).toHaveProperty('error')
    expect(parseDashboardArgs(['--port', '70000'])).toHaveProperty('error')
    expect(parseDashboardArgs(['--port', 'abc'])).toHaveProperty('error')
  })

  it('names the nearest flag for a misspelled one', () => {
    expect(parseDashboardArgs(['--prot', '4400'])).toEqual({ error: 'Unknown option --prot. Did you mean --port?' })
    expect((parseDashboardArgs(['--seed']) as { error: string }).error).toMatch(/Unknown option --seed/)
  })
})

describe('a flag nowhere near one the dashboard takes', () => {
  it('lists what it accepts instead of guessing', () => {
    expect(parseDashboardArgs(['--json'])).toEqual({ error: 'Unknown option --json. It accepts --port, --no-open, --help, -h.' })
  })
})
