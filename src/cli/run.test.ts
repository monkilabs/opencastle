/**
 * `convoy run <spec>` and `convoy resume`, from the command line inwards.
 *
 * The engine has its own tests; these check what this file adds: how the
 * arguments are read, that a dry run starts and records nothing, that resume
 * picks the run it says it picks, and that a real run against a stub `claude`
 * returns its exit code and leaves nothing behind to keep the process alive.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunArgs, resumeLast, runSpec, type RunArgs } from './run.js'
import { createConvoyStore } from './convoy/store.js'
import { readRun } from './convoy/read-model.js'
import { _resetAllowlistCache, _setAllowlistConfigPath } from './convoy/gates.js'

const args = (over: Partial<RunArgs> = {}): RunArgs => ({
  spec: null, dryRun: false, adapter: null, concurrency: null, verbose: false, help: false, ...over,
})

describe('parseRunArgs', () => {
  it('takes the spec as a positional argument', () => {
    expect(parseRunArgs(['my.convoy.yml', '--dry-run'], 'run')).toEqual(args({ spec: 'my.convoy.yml', dryRun: true }))
  })

  it('still reads -f and --file, which every older spec header names', () => {
    expect(parseRunArgs(['-f', 'a.yml'], 'run')).toMatchObject({ spec: 'a.yml' })
    expect(parseRunArgs(['--file', 'a.yml'], 'run')).toMatchObject({ spec: 'a.yml' })
  })

  it('refuses two specs', () => {
    expect(parseRunArgs(['a.yml', 'b.yml'], 'run')).toEqual({ error: 'Two specs given: a.yml and b.yml. Run one at a time.' })
    expect(parseRunArgs(['a.yml', '-f', 'b.yml'], 'run')).toHaveProperty('error')
  })

  it('reads the common flags', () => {
    expect(parseRunArgs(['s.yml', '-a', 'codex', '-c', '3', '--verbose'], 'run')).toEqual(
      args({ spec: 's.yml', adapter: 'codex', concurrency: 3, verbose: true }),
    )
  })

  it('refuses a concurrency that is not a whole number from 1 to 50', () => {
    for (const bad of ['0', '51', '2.5', 'many']) {
      expect(parseRunArgs(['s.yml', '-c', bad], 'run'), bad).toHaveProperty('error')
    }
    expect(parseRunArgs(['s.yml', '--concurrency'], 'run')).toEqual({ error: '--concurrency needs a value' })
  })

  it('names the nearest flag for a misspelled one', () => {
    expect(parseRunArgs(['s.yml', '--dryRun'], 'run')).toEqual({ error: 'Unknown option --dryRun. Did you mean --dry-run?' })
    expect(parseRunArgs(['s.yml', '--verbos'], 'run')).toEqual({ error: 'Unknown option --verbos. Did you mean --verbose?' })
  })

  it('lists what it accepts when nothing is close', () => {
    expect((parseRunArgs(['s.yml', '--json'], 'run') as { error: string }).error).toMatch(/It accepts --dry-run, --adapter/)
  })

  it('says what replaced a removed flag', () => {
    const removed: Array<[string, RegExp]> = [
      ['--resume', /opencastle convoy resume/],
      ['--retry-failed', /opencastle convoy resume/],
      ['--status', /opencastle convoy —/],
      ['--dlq-list', /opencastle convoy resume/],
      ['--formula', /Formulas are gone/],
      ['--watch', /Watch mode is gone/],
      ['--report-dir', /convoy\.db/],
      ['--permission-mode', /defaults\.permission_mode/],
    ]
    for (const [flag, why] of removed) {
      const parsed = parseRunArgs(['s.yml', flag], 'run') as { error: string }
      expect(parsed.error, flag).toMatch(new RegExp(`^${flag} was removed\\.`))
      expect(parsed.error, flag).toMatch(why)
    }
  })

  it('gives resume no spec, and says so for a stray word', () => {
    expect(parseRunArgs(['--dry-run'], 'resume')).toEqual(args({ dryRun: true }))
    expect((parseRunArgs(['task-1'], 'resume') as { error: string }).error).toMatch(/takes no name/)
    expect(parseRunArgs(['-f', 'a.yml'], 'resume')).toEqual({ error: '-f belongs to opencastle convoy run' })
  })
})

// ── Against a project on disk ─────────────────────────────────────────────────

/**
 * A stand-in for Claude Code. It prints the `--output-format json` result
 * shape, writes the files a prompt asks for with `WRITE <path> <text>` lines,
 * sleeps on `SLEEP <seconds>`, fails while the file named by `FAILIF <path>`
 * exists, and passes any review it is asked for.
 */
const STUB_CLAUDE = `#!/bin/sh
input=$(cat)
case "$input" in
  *"You are a code reviewer"*)
    printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"Fine. <!-- REVIEW_VERDICT { \\"verdict\\": \\"pass\\", \\"issues\\": [] } -->","total_cost_usd":0.001,"usage":{"input_tokens":50,"output_tokens":5}}'
    exit 0 ;;
esac
failif=$(printf '%s\\n' "$input" | sed -n 's/^ *FAILIF //p' | head -n 1)
if [ -n "$failif" ] && [ -e "$failif" ]; then
  printf '%s' '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["stub failure"],"total_cost_usd":0.002}'
  exit 1
fi
printf '%s\\n' "$input" | while read -r verb path rest; do
  case "$verb" in
    WRITE) mkdir -p "$(dirname "$path")"; printf '%s\\n' "$rest" > "$path" ;;
    SLEEP) sleep "$path" ;;
  esac
done
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":20},"modelUsage":{"claude-stub":{"inputTokens":100,"outputTokens":20,"costUSD":0.01}}}'
`

let root: string
let saved: { PATH?: string; HOME?: string; NO_COLOR?: string }
let out: string[]

function git(...a: string[]): string {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-run-')))
  const bin = join(root, '.bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), STUB_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  // Only the stub is reachable: a real agent CLI on this machine never is.
  saved = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: process.env.NO_COLOR }
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter)
  process.env.HOME = root
  process.env.NO_COLOR = '1'
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  out = []
  const capture = (...a: unknown[]): void => void out.push(a.join(' '))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write)
  _setAllowlistConfigPath('/nonexistent/secret-scan-config.yml')
  _resetAllowlistCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

const text = (): string => out.join('\n')

function writeSpec(name: string, body: string): string {
  writeFileSync(join(root, name), body)
  return name
}

const TWO_TASKS = `name: Two files
tasks:
  - id: one
    files: [one.txt]
    prompt: |
      WRITE one.txt first
  - id: two
    depends_on: [one]
    files: [two.txt]
    prompt: |
      WRITE two.txt second
`

describe('convoy run --dry-run', () => {
  it('shows the plan and the runtime, and records nothing', async () => {
    const spec = writeSpec('s.yml', TWO_TASKS)
    expect(await runSpec(args({ spec, dryRun: true }))).toBe(0)
    expect(text()).toMatch(/Convoy: Two files — 2 tasks, up to 4 at once/)
    expect(text()).toMatch(/two\s+developer\s+one\s+two\.txt/)
    expect(text()).toContain('Claude Code — found on PATH')
    expect(text()).toContain('nothing started, nothing recorded')
    expect(existsSync(join(root, '.opencastle'))).toBe(false)
  })

  it('refuses what a run would refuse: two tasks that could run together on one file', async () => {
    const spec = writeSpec('s.yml', `name: Clash
tasks:
  - id: a
    files: [same.txt]
    prompt: x
  - id: b
    files: [same.txt]
    prompt: y
`)
    expect(await runSpec(args({ spec, dryRun: true }))).toBe(1)
    expect(text()).toMatch(/File partition conflicts/)
    expect(existsSync(join(root, '.opencastle'))).toBe(false)
  })

  it('still shows the plan when no runtime is installed, then says why it would not run', async () => {
    process.env.PATH = ['/usr/bin', '/bin'].join(delimiter)
    const spec = writeSpec('s.yml', TWO_TASKS)
    expect(await runSpec(args({ spec, dryRun: true }))).toBe(1)
    expect(text()).toMatch(/Convoy: Two files/)
    expect(text()).toMatch(/No agent CLI found on PATH/)
  })
})

describe('convoy run', () => {
  it('names a missing spec, and a chained one, without starting anything', async () => {
    expect(await runSpec(args({ spec: 'nope.yml' }))).toBe(1)
    expect(text()).toContain('Spec not found: nope.yml')
    const chain = writeSpec('chain.yml', 'name: c\nversion: 2\ndepends_on_convoy: [a.yml]\n')
    expect(await runSpec(args({ spec: chain }))).toBe(1)
    expect(text()).toMatch(/no longer supported/)
    expect(await runSpec(args())).toBe(1)
    expect(text()).toContain('Name the spec to run')
  })

  it('runs to the end on a stub runtime, lands the work on a branch, and lets go', async () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(root, '.gitignore'), '.opencastle/\n.bin/\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    const spec = writeSpec('s.yml', TWO_TASKS)
    const listeners = process.listenerCount('SIGINT')

    expect(await runSpec(args({ spec }))).toBe(0)

    // The engine's summary, once.
    expect(text().match(/Convoy done/g)).toHaveLength(1)
    const branch = git('branch', '--list', 'convoy/*').replace('*', '').trim()
    expect(branch).toMatch(/^convoy\/two-files-/)
    expect(git('show', `${branch}:one.txt`)).toBe('first')
    expect(git('show', `${branch}:two.txt`)).toBe('second')
    // The user's checkout is untouched.
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(existsSync(join(root, 'one.txt'))).toBe(false)
    // Nothing left listening for Ctrl+C once the run is over.
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  }, 60_000)
})

// ── convoy resume ─────────────────────────────────────────────────────────────

describe('convoy run, then resume after a failure', () => {
  it('re-runs the failed task and the one it skipped, on the same branch, and ends done', async () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(root, '.gitignore'), '.opencastle/\n.bin/\nbroken\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    const flag = join(root, 'broken')
    writeFileSync(flag, '')
    const spec = writeSpec('s.yml', `name: Fails once
tasks:
  - id: one
    files: [one.txt]
    max_retries: 0
    prompt: |
      FAILIF ${flag}
      WRITE one.txt first
  - id: two
    depends_on: [one]
    files: [two.txt]
    prompt: |
      WRITE two.txt second
`)
    expect(await runSpec(args({ spec }))).toBe(1)
    expect(text()).toMatch(/Resume with: opencastle convoy resume/)

    rmSync(flag)
    out.length = 0
    expect(await resumeLast(args())).toBe(0)
    expect(text()).toContain('Resuming Fails once')
    expect(text()).toMatch(/Convoy done/)
    const branches = git('branch', '--list', 'convoy/*').split('\n').map((b) => b.replace('*', '').trim()).filter(Boolean)
    expect(branches).toHaveLength(1)
    expect(git('show', `${branches[0]}:one.txt`)).toBe('first')
    expect(git('show', `${branches[0]}:two.txt`)).toBe('second')
  }, 60_000)
})

function seedRuns(runs: Array<{ id: string; status: string; tasks: Array<[string, string]>; created: string }>): void {
  mkdirSync(join(root, '.opencastle'), { recursive: true })
  const store = createConvoyStore(join(root, '.opencastle', 'convoy.db'))
  for (const run of runs) {
    store.insertConvoy({ id: run.id, name: `Run ${run.id}`, spec_hash: 'h', status: 'pending', branch: null, created_at: run.created, spec_yaml: TWO_TASKS })
    for (const [id, status] of run.tasks) {
      store.insertTask({
        id, convoy_id: run.id, phase: 0, prompt: 'p', agent: 'developer', adapter: null, model: null, timeout_ms: 1000,
        status: 'pending', retries: 0, max_retries: 0, files: null, depends_on: null, gates: null,
      })
      if (status !== 'pending') store.updateTaskStatus(id, run.id, status as 'done')
    }
    store.updateConvoyStatus(run.id, run.status as 'done', {})
  }
  store.close()
}

describe('convoy resume', () => {
  it('says there is nothing to resume when there are no runs', async () => {
    expect(await resumeLast(args())).toBe(1)
    expect(text()).toContain('No convoy runs in this project yet')
  })

  it('says so and exits 0 when every run is done', async () => {
    seedRuns([{ id: 'a', status: 'done', tasks: [['one', 'done']], created: '2026-10-01T00:00:00Z' }])
    expect(await resumeLast(args())).toBe(0)
    expect(text()).toMatch(/Nothing to resume: the last run, Run a, finished/)
  })

  it('previews the newest run that is not done, listing what would run, and writes nothing', async () => {
    seedRuns([
      { id: 'old', status: 'failed', tasks: [['one', 'done'], ['two', 'failed'], ['three', 'skipped']], created: '2026-10-01T00:00:00Z' },
      { id: 'new', status: 'done', tasks: [['one', 'done']], created: '2026-10-02T00:00:00Z' },
    ])
    const db = join(root, '.opencastle', 'convoy.db')
    const before = statSync(db).mtimeMs
    expect(await resumeLast(args({ dryRun: true }))).toBe(0)
    expect(text()).toContain('Resuming Run old')
    expect(text()).toContain('The newest run, Run new, finished')
    expect(text()).toMatch(/Would run 2 of 3 task\(s\)/)
    expect(text()).toMatch(/two — developer \[failed\]/)
    expect(text()).toMatch(/three — developer \[skipped\]/)
    expect(text()).not.toMatch(/one — developer/)
    // Nothing was reset: the preview only read.
    expect(statSync(db).mtimeMs).toBe(before)
    expect(readRun(root, 'old')!.tasks.map((t) => t.status)).toEqual(['done', 'failed', 'skipped'])
  })

  it('counts a run "done" with a task skipped as not done', async () => {
    seedRuns([{ id: 'a', status: 'done', tasks: [['one', 'done'], ['two', 'skipped']], created: '2026-10-01T00:00:00Z' }])
    expect(await resumeLast(args({ dryRun: true }))).toBe(0)
    expect(text()).toMatch(/Would run 1 of 2/)
  })

  it('refuses a run another process is still working on', async () => {
    seedRuns([{ id: 'live', status: 'running', tasks: [['one', 'running']], created: new Date().toISOString() }])
    const db = new DatabaseSync(join(root, '.opencastle', 'convoy.db'))
    db.exec('CREATE TABLE IF NOT EXISTS engine_lock (id INTEGER PRIMARY KEY, pid INTEGER, hostname TEXT, started_at TEXT, last_heartbeat TEXT)')
    db.prepare('INSERT OR REPLACE INTO engine_lock VALUES (1, ?, ?, ?, ?)').run(process.pid, hostname(), '2026-01-01T00:00:00Z', new Date().toISOString())
    db.close()
    expect(await resumeLast(args())).toBe(1)
    expect(text()).toMatch(/is still running in another process/)
    expect(text()).toContain('opencastle convoy dashboard')
  })
})
