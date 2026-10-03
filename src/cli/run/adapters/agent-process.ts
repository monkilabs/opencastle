import type { ChildProcess } from 'node:child_process'
import { spawnCommand, killTree } from '../platform.js'
import type { Task } from '../../convoy/spec-types.js'

/**
 * Starting and stopping an agent CLI, shared by every adapter.
 *
 * Each adapter used to carry its own copy of this, and each copy had the same
 * faults: the prompt went on argv (Windows caps a command line near 32K
 * characters, and planning prompts are larger), `kill` signalled one pid and
 * never escalated, and the process it signalled was whichever one was last
 * written to `task._process` — for a multi-step task, a different object from
 * the task the engine asked to stop.
 */

/** How much of an agent's final message a result carries. */
export const OUTPUT_LIMIT = 500_000

/** Raw stdout kept for parsing. A JSONL stream's usage events come last, so the tail is what is kept. */
const STREAM_LIMIT = 32 * 1024 * 1024

/** After the agent itself exits, how long its stdout may stay open (held by something it started). */
const EXIT_GRACE_MS = 2_000

/** After a stop, how long to wait for the process to go before giving up on it. killTree escalates to SIGKILL at 5 s. */
const STOP_DEADLINE_MS = 8_000

export interface AgentRun {
  /** The CLI to start, by the name it has on PATH. */
  command: string
  args: string[]
  /** Written to the CLI's stdin, which is then closed. Undefined leaves stdin closed from the start. */
  input?: string
  cwd: string
  /** Variables set for the CLI on top of this process's environment. */
  env?: Record<string, string>
  verbose?: boolean
}

export interface AgentExit {
  /** The exit code; -1 when there is none (it could not start, or a signal ended it). */
  code: number
  stdout: string
  stderr: string
  /** The task's own timeout ended it. */
  timedOut: boolean
  /** `kill(task)` or the timeout ended it — its exit code says nothing about the work. */
  stopped: boolean
  /** Why it could not be started, when it could not. */
  spawnError?: string
}

/** Every agent process still running, by task id. A task id can have more than one: a step and its retry overlap briefly. */
const live = new Map<string, Set<ChildProcess>>()
/** What each running process does when it is stopped: arm the deadline that keeps `runAgent` from hanging. */
const onStop = new WeakMap<ChildProcess, () => void>()
const stoppedProcs = new WeakSet<ChildProcess>()
let exitHookInstalled = false

function track(taskId: string, child: ChildProcess): void {
  let set = live.get(taskId)
  if (!set) live.set(taskId, (set = new Set()))
  set.add(child)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    // On POSIX each agent leads its own process group, so it does not get the
    // terminal's Ctrl+C. Anything still running when this process exits would
    // be orphaned, still editing a worktree nobody is watching. There is no
    // later to escalate in, so it is SIGKILL now.
    process.once('exit', () => {
      for (const s of live.values()) for (const c of s) killTree(c.pid, 0)
    })
  }
}

function untrack(taskId: string, child: ChildProcess): void {
  const set = live.get(taskId)
  if (!set) return
  set.delete(child)
  if (set.size === 0) live.delete(taskId)
}

function stop(child: ChildProcess): void {
  if (stoppedProcs.has(child)) return
  stoppedProcs.add(child)
  killTree(child.pid)
  onStop.get(child)?.()
}

/**
 * Stop every agent process running for this task, and everything each one
 * started. Every adapter's `kill` is this.
 *
 * Looked up by task id rather than by `task._process`, because the engine asks
 * to stop the task it holds while a step runs under a copy with the same id.
 * The old escalation tested `proc.killed`, which is true as soon as SIGTERM is
 * *sent*, so SIGKILL never followed; and it signalled the CLI alone, leaving
 * the shells and servers it had started. A task with nothing running is left
 * alone, so a stale pid is never signalled.
 */
export function stopTask(task: Pick<Task, 'id'>): void {
  for (const child of live.get(task.id) ?? []) stop(child)
}

/** Stop every agent process this process started. */
export function stopAllAgents(): void {
  for (const set of live.values()) for (const child of set) stop(child)
}

/** How many agent processes are running — for tests. */
export function liveAgentCount(): number {
  let n = 0
  for (const set of live.values()) n += set.size
  return n
}

/**
 * A task's timeout in milliseconds, or undefined for none.
 *
 * Accepts `ms` as well as `s`/`m`/`h`: the engine hands a step its timeout as
 * `<n>ms`, which the spec parser does not read.
 */
export function timeoutMsOf(timeout: string | undefined): number | undefined {
  const m = String(timeout ?? '').trim().match(/^(\d+)\s*(ms|s|m|h)$/)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h']
  return n > 0 ? n * unit : undefined
}

/**
 * The prompt as the engine or planner wrote it.
 *
 * Adapters used to prefix "You are a <agent>." and append the file partition.
 * The engine's preamble already states both, and a per-task first line made
 * every task's prompt differ from its first byte, so no two tasks could share
 * a prompt cache.
 */
export function promptOf(task: Pick<Task, 'prompt'>): string {
  return task.prompt
}

function appendTail(current: string, chunk: string, limit: number): string {
  const next = current + chunk
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * Run an agent CLI for a task and collect what it printed.
 *
 * - The child runs in `run.cwd` — the task's worktree — and nowhere else.
 * - `run.input` goes on stdin, so prompt size is not bounded by argv.
 * - The task's `timeout` is enforced here as well as by the engine: the
 *   planner calls adapters directly, and nothing else bounded its sessions.
 * - It never hangs: a stop that cannot end the process, or a process that
 *   exits while something it started holds stdout open, still settles.
 */
export function runAgent(task: Task, run: AgentRun): Promise<AgentExit> {
  return new Promise<AgentExit>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnCommand(run.command, run.args, {
        cwd: run.cwd,
        env: run.env ? { ...process.env, ...run.env } : process.env,
        stdio: [run.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, stopped: false, spawnError: (err as Error).message })
      return
    }

    track(task.id, child)
    task._process = child

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const finish = (code: number, spawnError?: string): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      untrack(task.id, child)
      if (task._process === child) task._process = undefined
      resolve({ code, stdout, stderr, timedOut, stopped: stoppedProcs.has(child), ...(spawnError ? { spawnError } : {}) })
    }

    onStop.set(child, () => {
      const t = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(child.exitCode ?? -1)
      }, STOP_DEADLINE_MS)
      t.unref?.()
      timers.push(t)
    })

    const timeoutMs = timeoutMsOf(task.timeout)
    if (timeoutMs) {
      timers.push(setTimeout(() => {
        timedOut = true
        stop(child)
      }, timeoutMs))
    }

    if (run.input !== undefined && child.stdin) {
      // A CLI that exits before reading its input closes the pipe under us.
      child.stdin.on('error', () => {})
      child.stdin.end(run.input)
    }

    // Decoded by the stream, so a character split across two chunks stays whole.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendTail(stdout, chunk, STREAM_LIMIT)
      if (run.verbose) process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendTail(stderr, chunk, STREAM_LIMIT)
      if (run.verbose) process.stderr.write(chunk)
    })

    child.on('error', (err) => finish(-1, err.message))
    child.on('exit', () => {
      // 'close' waits for stdout to close, and a process the agent started can
      // hold it open long after the agent is gone. Give it a moment, then end
      // what is left of the group and settle.
      const t = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
        }
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(child.exitCode ?? -1)
      }, EXIT_GRACE_MS)
      t.unref?.()
      timers.push(t)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** The message for a run that ended without the agent finishing, or null when it finished. */
export function interruptedMessage(cli: string, task: Task, exit: AgentExit): string | null {
  if (exit.spawnError) return `Failed to start ${cli}: ${exit.spawnError}`
  if (exit.timedOut) return `${cli} timed out after ${task.timeout} and was stopped`
  if (exit.stopped) return `${cli} was stopped before it finished`
  return null
}
