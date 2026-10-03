import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConvoyStore } from './convoy/store.js'
import { parseDashboardArgs, startViewer } from './dashboard.js'
import type { ViewerHandle } from './dashboard.js'

let root: string
const open: ViewerHandle[] = []
const blockers: Server[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'viewer-')))
  mkdirSync(join(root, '.opencastle'), { recursive: true })
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((v) => v.close()))
  await Promise.all(blockers.splice(0).map((s) => new Promise((done) => s.close(done))))
  rmSync(root, { recursive: true, force: true })
})

async function viewer(port = 0): Promise<ViewerHandle> {
  const v = await startViewer({ projectRoot: root, port, open: false })
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

describe('startViewer', () => {
  it('binds 127.0.0.1 and reports the port the OS gave it', async () => {
    const v = await viewer(0)
    expect(v.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(portOf(v.url)).toBeGreaterThan(0)
    const res = await fetch(v.url)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('name="opencastle-viewer" content="live"')
  })

  it('moves past a busy port and reports the one it actually bound', async () => {
    const busy = await occupy()
    const v = await viewer(busy)
    expect(portOf(v.url)).toBe(busy + 1)
    expect(await (await fetch(v.url)).text()).toContain('opencastle-viewer')
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
    const v = await viewer(first)
    expect(portOf(v.url)).toBe(second + 1)
  })

  it('serves runs, one run, events after a cursor, and sessions', async () => {
    seed()
    mkdirSync(join(root, '.opencastle', 'logs'), { recursive: true })
    writeFileSync(
      join(root, '.opencastle', 'logs', 'events.ndjson'),
      JSON.stringify({ type: 'session', timestamp: '2026-10-01T10:00:00.000Z', agent: 'Developer', task: 't', outcome: 'success' }) + '\n',
    )
    const v = await viewer()

    const runs = await json(`${v.url}/api/runs`)
    expect(runs.status).toBe(200)
    expect(runs.body.project).toBe(root.split(/[\\/]/).pop())
    expect((runs.body.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(['convoy-1'])
    expect((runs.body.categories as Record<string, string[]>).task).toContain('task_failed')

    const run = await json(`${v.url}/api/runs/convoy-1`)
    expect(run.body.run).toMatchObject({ id: 'convoy-1', name: 'Demo', alive: false, tasks_total: 1 })

    const all = await json(`${v.url}/api/runs/convoy-1/events?since=0`)
    const events = all.body.events as Array<{ id: number; type: string }>
    expect(events.map((e) => e.type)).toEqual(['convoy_started', 'task_started', 'task_done', 'convoy_finished'])
    expect(all.body.more).toBe(false)
    const newer = await json(`${v.url}/api/runs/convoy-1/events?since=${events[1].id}`)
    expect((newer.body.events as Array<{ type: string }>).map((e) => e.type)).toEqual(['task_done', 'convoy_finished'])

    const sessions = await json(`${v.url}/api/sessions`)
    expect(sessions.body.sessions).toMatchObject([{ agent: 'Developer', outcome: 'success' }])
  })

  it('answers unknown runs and paths with 404, and a bad cursor with 400', async () => {
    seed()
    const v = await viewer()
    expect((await json(`${v.url}/api/runs/nope`)).status).toBe(404)
    expect((await json(`${v.url}/api/nothing`)).status).toBe(404)
    expect((await json(`${v.url}/api/runs/convoy-1/events?since=-1`)).status).toBe(400)
    expect((await json(`${v.url}/api/runs/convoy-1/events?since=abc`)).status).toBe(400)
  })

  it('is read-only', async () => {
    const v = await viewer()
    expect((await fetch(`${v.url}/api/runs`, { method: 'POST' })).status).toBe(405)
  })

  it('shows an empty project without creating a database', async () => {
    const v = await viewer()
    expect((await json(`${v.url}/api/runs`)).body.runs).toEqual([])
    expect(readdirSync(join(root, '.opencastle'))).toEqual([])
  })

  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const v = await viewer()
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
    const v = await startViewer({ projectRoot: root, port: 0, open: false })
    await fetch(`${v.url}/api/runs`) // leaves a pooled keep-alive socket behind
    const started = Date.now()
    await v.close()
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(fetch(`${v.url}/api/runs`)).rejects.toThrow()
  })
})

const repoRoot = join(import.meta.dirname, '..', '..')
const exporter = join(repoRoot, 'tools', 'viewer-demo', 'export.mjs')
const snapshot = join(repoRoot, 'tools', 'viewer-demo', 'snapshot')
const built = existsSync(join(repoRoot, 'dist', 'cli', 'convoy', 'read-model.js'))

// The exporter reads through the compiled read model, as it does when run by hand.
describe.skipIf(!built)('the static export', () => {
  it('writes the page in static mode and every file it reads', () => {
    seed()
    const out = join(root, 'out')
    execFileSync(process.execPath, [exporter, root, out], { stdio: 'pipe' })
    const page = readFileSync(join(out, 'index.html'), 'utf8')
    expect(page).toContain('name="opencastle-viewer" content="static"')
    expect(page).not.toContain('content="live"')
    const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(out, 'data', rel), 'utf8'))
    expect(read('runs.json').runs).toMatchObject([{ id: 'convoy-1', alive: false }])
    expect(read('runs/convoy-1.json').run).toMatchObject({ id: 'convoy-1', tasks: [{ id: 'a' }] })
    expect((read('events/convoy-1.json').events as unknown[]).length).toBe(4)
    expect(read('sessions.json').sessions).toEqual([])
  })
})

describe('the committed demo snapshot', () => {
  it('is the viewer in static mode, with a file for every run it lists', () => {
    expect(readFileSync(join(snapshot, 'index.html'), 'utf8')).toContain('name="opencastle-viewer" content="static"')
    const runs = JSON.parse(readFileSync(join(snapshot, 'data', 'runs.json'), 'utf8')) as { runs: Array<{ id: string; alive: boolean }> }
    expect(runs.runs.length).toBeGreaterThan(0)
    for (const r of runs.runs) {
      expect(r.alive).toBe(false)
      const file = r.id.replace(/[^\w.-]/g, '_')
      const detail = JSON.parse(readFileSync(join(snapshot, 'data', 'runs', `${file}.json`), 'utf8')) as { run: { tasks: unknown[] } }
      expect(Array.isArray(detail.run.tasks)).toBe(true)
      expect(existsSync(join(snapshot, 'data', 'events', `${file}.json`))).toBe(true)
    }
    expect(existsSync(join(snapshot, 'data', 'sessions.json'))).toBe(true)
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
