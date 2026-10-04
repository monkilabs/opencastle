/**
 * `opencastle convoy` with no task: where the last run stands, and the one
 * thing to do next — read through the read model, never a store that migrates.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import convoy, { readLastRun } from './convoy-cmd.js'
import { createConvoyStore } from './convoy/store.js'

let root: string
let out: string[]
let savedNoColor: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-convoy-')))
  mkdirSync(join(root, '.opencastle'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  out = []
  const capture = (...a: unknown[]): void => void out.push(a.join(' '))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as typeof process.exit)
  savedNoColor = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = savedNoColor
  rmSync(root, { recursive: true, force: true })
})

const text = (): string => out.join('\n')
const dbPath = (): string => join(root, '.opencastle', 'convoy.db')

function seed(runs: Array<{ id: string; status: string; tasks: string[]; created: string }>): void {
  const store = createConvoyStore(dbPath())
  for (const run of runs) {
    store.insertConvoy({ id: run.id, name: `Run ${run.id}`, spec_hash: 'h', status: 'pending', branch: `convoy/${run.id}`, created_at: run.created, spec_yaml: 'x' })
    run.tasks.forEach((status, i) => {
      const id = `t${i}`
      store.insertTask({
        id, convoy_id: run.id, phase: 0, prompt: 'p', agent: 'developer', adapter: null, model: null, timeout_ms: 1000,
        status: 'pending', retries: 0, max_retries: 0, files: null, depends_on: null, gates: null,
      })
      if (status !== 'pending') store.updateTaskStatus(id, run.id, status as 'done')
    })
    store.updateConvoyStatus(run.id, run.status as 'done', {})
  }
  store.close()
}

function holdLock(): void {
  const db = new DatabaseSync(dbPath())
  db.prepare('INSERT OR REPLACE INTO engine_lock (id, pid, hostname, started_at, last_heartbeat) VALUES (1, ?, ?, ?, ?)')
    .run(process.pid, hostname(), '2026-01-01T00:00:00Z', new Date().toISOString())
  db.close()
}

describe('readLastRun', () => {
  it('is null for a project that has never run a convoy', () => {
    expect(readLastRun(root)).toBeNull()
  })

  it('counts every failed status as failed', () => {
    seed([{ id: 'a', status: 'failed', created: '2026-10-01T00:00:00Z', tasks: ['done', 'failed', 'gate-failed', 'timed-out', 'review-blocked', 'disputed', 'hook-failed'] }])
    expect(readLastRun(root)).toMatchObject({ total: 7, done: 1, failed: 6, next: 'npx opencastle convoy resume' })
  })

  it('does not call a run finished while a task was skipped, even when it says "done"', () => {
    seed([{ id: 'a', status: 'done', created: '2026-10-01T00:00:00Z', tasks: ['done', 'skipped'] }])
    expect(readLastRun(root)).toMatchObject({ done: 1, skipped: 1, failed: 0, next: 'npx opencastle convoy resume' })
  })

  it('treats a running task in a dead run as not done', () => {
    seed([{ id: 'a', status: 'running', created: '2026-10-01T00:00:00Z', tasks: ['done', 'running'] }])
    expect(readLastRun(root)).toMatchObject({ running: 1, alive: false, next: 'npx opencastle convoy resume' })
  })

  it('points at the live view while a process is working on the run', () => {
    seed([{ id: 'a', status: 'running', created: new Date().toISOString(), tasks: ['running', 'pending'] }])
    holdLock()
    expect(readLastRun(root)).toMatchObject({ alive: true, next: 'npx opencastle convoy dashboard' })
  })

  it('offers a new run when every task is done, and names an older run with work left', () => {
    seed([
      { id: 'old', status: 'interrupted', created: '2026-10-01T00:00:00Z', tasks: ['pending'] },
      { id: 'new', status: 'done', created: '2026-10-02T00:00:00Z', tasks: ['done', 'done'] },
    ])
    expect(readLastRun(root)).toMatchObject({
      id: 'new', done: 2, total: 2, next: 'npx opencastle convoy "<task>"', older_unfinished: { id: 'old', name: 'Run old' },
    })
  })

  it('reads without writing to the database', () => {
    seed([{ id: 'a', status: 'failed', created: '2026-10-01T00:00:00Z', tasks: ['failed'] }])
    const before = statSync(dbPath()).mtimeMs
    readLastRun(root)
    expect(statSync(dbPath()).mtimeMs).toBe(before)
  })
})

describe('opencastle convoy (status)', () => {
  it('never reports a run as finished while a task is not done', async () => {
    seed([{ id: 'a', status: 'done', created: '2026-10-01T00:00:00Z', tasks: ['done', 'skipped'] }])
    await convoy({ args: [], pkgRoot: root })
    expect(text()).toMatch(/1\/2 done, 1 skipped/)
    expect(text()).toContain('Next: npx opencastle convoy resume')
    expect(text()).not.toMatch(/every task is done|Nothing outstanding/)
  })

  it('prints JSON with --json', async () => {
    seed([{ id: 'a', status: 'done', created: '2026-10-01T00:00:00Z', tasks: ['done'] }])
    await convoy({ args: ['--json'], pkgRoot: root })
    expect(JSON.parse(text())).toMatchObject({ id: 'a', done: 1, total: 1, next: 'npx opencastle convoy "<task>"' })
  })

  it('says how to start when there are no runs', async () => {
    await convoy({ args: [], pkgRoot: root })
    expect(text()).toContain('No runs yet.')
  })
})

describe('opencastle convoy (what it refuses before planning anything)', () => {
  const refused = async (args: string[]): Promise<string> => {
    await expect(convoy({ args, pkgRoot: root })).rejects.toThrow('exit 1')
    return text()
  }

  it('reads a mistyped subcommand as a typo, not a task', async () => {
    expect(await refused(['resum'])).toContain('Did you mean npx opencastle convoy resume?')
  })

  it('does not plan a one-word task such as "status"', async () => {
    const said = await refused(['status'])
    expect(said).toContain('"status" is one word')
    expect(said).toContain('For the last run: npx opencastle convoy')
  })

  it('names what replaced a removed flag', async () => {
    expect(await refused(['--retry-failed'])).toContain('--retry-failed was removed. Use: npx opencastle convoy resume')
    expect(await refused(['add', 'rate', 'limiting', '--status'])).toContain('--status was removed')
  })

  it('suggests the nearest flag a task takes', async () => {
    expect(await refused(['add', 'rate', 'limiting', '--yse'])).toContain('Did you mean --yes?')
  })

  it('says a task flag needs a task', async () => {
    expect(await refused(['--yes'])).toContain('--yes goes with a task')
  })

  it('sends a subcommand flag to its subcommand', async () => {
    expect(await refused(['-f', 'spec.yml'])).toContain('-f belongs to `npx opencastle convoy run`')
  })
})
