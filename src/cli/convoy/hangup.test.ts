/**
 * `convoy run` when its terminal closes or its SSH session drops: SIGHUP.
 *
 * The engine stopped on SIGINT and SIGTERM only. SIGHUP's default action ended
 * it on the spot, and every agent kept running: each leads its own process
 * group, so the hangup never reached them. The next `convoy resume` then
 * deleted the worktrees those agents were still writing to.
 *
 * This drives the real command in a child process, with a stand-in `claude`
 * on PATH that runs until it is killed.
 */
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const posix = process.platform !== 'win32'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

const STUB_CLAUDE = `#!/bin/sh
if [ "$1" = "--help" ] || [ "$1" = "--version" ]; then echo "claude 2.0.0"; exit 0; fi
cat > /dev/null
sleep 60 &
echo $! > "$STUB_LOG/child.pid"
echo $$ > "$STUB_LOG/agent.pid"
wait
`

const SPEC = `name: hangup
adapter: claude
on_failure: continue
defaults:
  review: none
tasks:
  - id: a
    prompt: Write a.txt
    agent: developer
    files: [a.txt]
    timeout: 5m
    max_retries: 0
`

describe.skipIf(!posix)('convoy run when the terminal closes', () => {
  let root: string
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('stops every agent, records the run as interrupted and lets go of the lock', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-hangup-')))
    const bin = join(root, 'bin')
    const log = join(root, 'log')
    const repo = join(root, 'repo')
    for (const d of [bin, log, repo]) mkdirSync(d)
    writeFileSync(join(bin, 'claude'), STUB_CLAUDE)
    chmodSync(join(bin, 'claude'), 0o755)
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(repo, 'README.md'), '# p\n')
    writeFileSync(join(repo, '.gitignore'), '.opencastle/\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'spec.yml'), SPEC)

    const runModule = pathToFileURL(join(import.meta.dirname, '..', 'run.ts')).href
    const driver = join(root, 'driver.mjs')
    writeFileSync(driver, [
      `const { default: run } = await import(${JSON.stringify(runModule)})`,
      `await run({ args: ['spec.yml', '--adapter', 'claude'], pkgRoot: ${JSON.stringify(join(import.meta.dirname, '..', '..', '..'))} })`,
    ].join('\n'))
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const child = spawn(process.execPath, ['--import', tsx, driver], {
      cwd: repo,
      // The stand-in comes first, so no real agent CLI can be reached.
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log },
      stdio: 'ignore',
    })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))

    const started = await waitFor(() => existsSync(join(log, 'agent.pid')) && existsSync(join(log, 'child.pid')), 20_000)
    expect(started).toBe(true)
    const agentPid = Number(readFileSync(join(log, 'agent.pid'), 'utf8').trim())
    const childPid = Number(readFileSync(join(log, 'child.pid'), 'utf8').trim())

    try {
      child.kill('SIGHUP')
      expect(await exited).toBe(130)
      expect(await waitFor(() => !alive(agentPid) && !alive(childPid), 3_000)).toBe(true)

      const db = new DatabaseSync(join(repo, '.opencastle', 'convoy.db'), { readOnly: true })
      try {
        expect((db.prepare('SELECT status FROM convoy').get() as { status: string }).status).toBe('interrupted')
        expect((db.prepare("SELECT status FROM task WHERE id = 'a'").get() as { status: string }).status).toBe('pending')
        expect(db.prepare('SELECT * FROM engine_lock').all()).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      try { process.kill(-agentPid, 'SIGKILL') } catch { /* gone */ }
      child.kill('SIGKILL')
    }
  }, 60_000)
})
