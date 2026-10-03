import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import type { Task } from '../../convoy/spec-types.js'
import { runAgent, stopTask, liveAgentCount, timeoutMsOf, promptOf } from './agent-process.js'

const posix = process.platform !== 'win32'

function task(id: string, timeout = '5m', prompt = 'p'): Task {
  return { id, prompt, agent: 'developer', timeout, depends_on: [], files: [], description: '', max_retries: 0 }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

describe('timeoutMsOf', () => {
  it('reads the units a spec and the engine use, including ms', () => {
    expect(timeoutMsOf('30s')).toBe(30_000)
    expect(timeoutMsOf('10m')).toBe(600_000)
    expect(timeoutMsOf('2h')).toBe(7_200_000)
    // The engine hands a step its timeout as `<n>ms`, which the spec parser does not read.
    expect(timeoutMsOf('1500ms')).toBe(1500)
  })

  it('means no timeout for anything else', () => {
    expect(timeoutMsOf(undefined)).toBeUndefined()
    expect(timeoutMsOf('')).toBeUndefined()
    expect(timeoutMsOf('soon')).toBeUndefined()
    expect(timeoutMsOf('0s')).toBeUndefined()
  })
})

describe('promptOf', () => {
  it('sends the prompt exactly as written, so tasks can share a cached prefix', () => {
    const t = { ...task('a'), agent: 'developer', files: ['src/a.ts'], prompt: '## Shared context\n\nDo a.' }
    expect(promptOf(t)).toBe('## Shared context\n\nDo a.')
  })
})

describe.skipIf(!posix)('running an agent CLI', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function scratch(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'oc-agent-')))
    dirs.push(d)
    return d
  }

  function script(dir: string, body: string): string {
    const path = join(dir, 'fake-agent')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('sends the prompt on stdin, runs in the given directory, and collects both streams', async () => {
    const dir = scratch()
    const work = scratch()
    const cmd = script(dir, `pwd > "${dir}/cwd"; cat > "${dir}/stdin"; echo out; echo err >&2; exit 3`)
    // Larger than Windows' ~32K command line and Linux's 128 KiB single-argument limit.
    const prompt = 'x'.repeat(300_000)
    const exit = await runAgent(task('io'), { command: cmd, args: [], input: prompt, cwd: work })
    expect(exit.code).toBe(3)
    expect(exit.stdout.trim()).toBe('out')
    expect(exit.stderr.trim()).toBe('err')
    expect(exit.stopped).toBe(false)
    expect(exit.timedOut).toBe(false)
    expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(work)
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe(prompt)
  })

  it('keeps a multi-byte character whole when it arrives split across two writes', async () => {
    const dir = scratch()
    // "é" is 0xC3 0xA9; the two bytes are written separately.
    const cmd = script(dir, `printf '\\303'; sleep 0.2; printf '\\251\\n'`)
    const exit = await runAgent(task('utf8'), { command: cmd, args: [], cwd: dir })
    expect(exit.stdout).toBe('é\n')
  })

  it('reports a CLI that cannot be started instead of throwing', async () => {
    const exit = await runAgent(task('missing'), { command: join(scratch(), 'no-such-agent'), args: [], cwd: tmpdir() })
    expect(exit.code).toBe(-1)
    expect(exit.spawnError).toBeTruthy()
  })

  it('stops a step that runs under a copy of the task, and what it started', async () => {
    // The engine stops the task object it holds; a step runs under a copy with
    // the same id. The old adapters tracked the process on the copy, so the
    // step was never stopped.
    const dir = scratch()
    const cmd = script(dir, `sleep 30 & echo $! > "${dir}/child"; wait`)
    const stepTask = task('t-1')
    const running = runAgent(stepTask, { command: cmd, args: [], cwd: dir })
    expect(await waitFor(() => existsSync(join(dir, 'child')) && readFileSync(join(dir, 'child'), 'utf8').trim() !== '')).toBe(true)
    const childPid = Number(readFileSync(join(dir, 'child'), 'utf8').trim())
    expect(liveAgentCount()).toBe(1)

    stopTask(task('t-1')) // a different object, the same id
    const exit = await running
    expect(exit.stopped).toBe(true)
    expect(await waitFor(() => !alive(childPid))).toBe(true)
    expect(liveAgentCount()).toBe(0)
  })

  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    // The old escalation tested `proc.killed`, which is true once SIGTERM is
    // sent, so an agent that ignored SIGTERM ran on and `execute` reported
    // whatever it exited with.
    const dir = scratch()
    const cmd = script(dir, `trap '' TERM; echo $$ > "${dir}/pid"; while true; do sleep 1; done`)
    const running = runAgent(task('stubborn'), { command: cmd, args: [], cwd: dir })
    // Stop it only once the trap is set; before that SIGTERM alone would do.
    expect(await waitFor(() => existsSync(join(dir, 'pid')) && readFileSync(join(dir, 'pid'), 'utf8').trim() !== '')).toBe(true)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim())
    const started = Date.now()
    stopTask(task('stubborn'))
    const exit = await running
    expect(exit.stopped).toBe(true)
    const took = Date.now() - started
    // SIGTERM was ignored, SIGKILL followed at 5 s — not the 8 s settle deadline.
    expect(took).toBeGreaterThanOrEqual(4_500)
    expect(took).toBeLessThan(7_500)
    expect(alive(pid)).toBe(false)
  }, 15_000)

  it('stops an agent that outlives its timeout and says it timed out', async () => {
    const dir = scratch()
    const cmd = script(dir, 'sleep 30')
    const exit = await runAgent(task('slow', '200ms'), { command: cmd, args: [], cwd: dir })
    expect(exit.timedOut).toBe(true)
    expect(exit.stopped).toBe(true)
  })

  it('leaves a finished task alone: nothing stale is signalled', async () => {
    const dir = scratch()
    const cmd = script(dir, 'exit 0')
    const t = task('done-already')
    const exit = await runAgent(t, { command: cmd, args: [], cwd: dir })
    expect(exit.code).toBe(0)
    expect(t._process).toBeUndefined()
    expect(() => stopTask(t)).not.toThrow()
    expect(liveAgentCount()).toBe(0)
  })

  it('settles when the agent exits but something it started still holds stdout open', async () => {
    const dir = scratch()
    const cmd = script(dir, `sleep 30 & echo $! > "${dir}/child"; echo done; exit 0`)
    const started = Date.now()
    const exit = await runAgent(task('holder'), { command: cmd, args: [], cwd: dir })
    expect(exit.code).toBe(0)
    expect(exit.stdout).toContain('done')
    expect(Date.now() - started).toBeLessThan(6_000)
    const childPid = Number(readFileSync(join(dir, 'child'), 'utf8').trim())
    expect(await waitFor(() => !alive(childPid))).toBe(true)
  })
})
