import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, isAbsolute } from 'node:path'

/**
 * Process handling that works the same on macOS, Linux and Windows.
 *
 * Convoy drives other CLIs and runs the project's own commands, and every one of
 * those calls used to assume a POSIX box: `which` to find a binary (Windows has
 * none, so no runtime was ever found there), `sh -c` for gates, a bare `spawn`
 * of npm-installed CLIs (Node refuses `.cmd` shims without a shell since
 * 18.20.2 / 20.12.2), and a SIGTERM to one pid that left the agent's own
 * children running.
 */

const isWindows = process.platform === 'win32'

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (isWindows) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The full path a command name resolves to on PATH, or null. PATHEXT is honoured on Windows. */
export function resolveCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = isWindows
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : ['']
  const candidatesFor = (base: string) => exts.map((ext) => base + ext)
  if (isAbsolute(name) || name.includes('/') || (isWindows && name.includes('\\'))) {
    return candidatesFor(name).find(isExecutableFile) ?? null
  }
  // Windows spells it Path; Node exposes both, but a copied env object may carry only one.
  const pathVar = env.PATH ?? env.Path ?? ''
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const candidate of candidatesFor(join(dir, name))) {
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** Whether a command resolves on PATH. No `which`, so it answers on Windows too. */
export async function commandExists(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return resolveCommand(name, env) !== null
}

// cmd.exe metacharacters, escaped with a caret. A `.cmd` shim passes its
// arguments through cmd.exe a second time, so they are escaped twice — the
// same rule cross-spawn applies.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** One argument quoted for cmd.exe. */
export function quoteForCmd(arg: string, doubleEscape = false): string {
  let quoted = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')
  quoted = `"${quoted}"`.replace(CMD_META, '^$1')
  if (doubleEscape) quoted = quoted.replace(CMD_META, '^$1')
  return quoted
}

/**
 * Spawn a CLI by name, the way a shell would find it.
 *
 * On POSIX the child leads its own process group, so `killTree` reaches
 * everything it starts. On Windows a `.cmd`/`.bat` shim — how npm installs
 * every Node CLI — is run through cmd.exe with each argument quoted, because
 * Node no longer spawns one without a shell. Long input belongs on stdin:
 * Windows caps a command line near 32K characters.
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (!isWindows) {
    return spawn(command, args, { detached: true, ...options })
  }
  const resolved = resolveCommand(command, (options.env as NodeJS.ProcessEnv | undefined) ?? process.env) ?? command
  if (/\.(cmd|bat)$/i.test(resolved)) {
    // The command is caret-escaped, not quoted; each argument is quoted and,
    // because a shim re-parses it, escaped twice. Node wraps the whole line in
    // `cmd /d /s /c "…"` itself when `shell` is true.
    const line = [resolved.replace(CMD_META, '^$1'), ...args.map((a) => quoteForCmd(a, true))].join(' ')
    return spawn(line, { ...options, shell: true, windowsHide: true, windowsVerbatimArguments: true })
  }
  return spawn(resolved, args, { ...options, windowsHide: true })
}

/**
 * Stop a process and everything it started.
 *
 * SIGTERM first, SIGKILL five seconds later if anything is still there. The
 * escalation used to test `proc.killed`, which is already true once SIGTERM is
 * *sent*, so it never fired and an agent that ignored SIGTERM ran on.
 *
 * A `graceMs` of 0 sends SIGKILL at once: for a process that is itself about
 * to exit, which cannot wait to escalate.
 */
export function killTree(pid: number | undefined, graceMs = 5000): void {
  if (!pid) return
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } catch { /* already gone */ }
    return
  }
  // The whole group when the process leads one (spawnCommand makes it), the
  // process alone otherwise. The escalation goes to the same target: falling
  // back to the bare pid once the group is gone could reach an unrelated
  // process that has since been given that pid.
  let target: number
  try {
    process.kill(-pid, graceMs <= 0 ? 'SIGKILL' : 'SIGTERM')
    target = -pid
  } catch {
    try {
      process.kill(pid, graceMs <= 0 ? 'SIGKILL' : 'SIGTERM')
      target = pid
    } catch {
      return // already gone
    }
  }
  if (graceMs <= 0) return
  const timer = setTimeout(() => {
    try { process.kill(target, 'SIGKILL') } catch { /* it went on SIGTERM */ }
  }, graceMs)
  timer.unref()
}

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const OUTPUT_CAP = 256 * 1024

/** Keep the end of a stream: a failing test run's verdict is at the bottom. */
function appendCapped(current: string, chunk: string): string {
  const next = current + chunk
  return next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next
}

/**
 * Run a project command — a gate such as `npm test` — through the platform's
 * own shell (`/bin/sh` or cmd.exe). Gates were run with `sh -c`, which does not
 * exist on Windows.
 *
 * Aborting `signal` kills the command and everything it started. A gate runs in
 * a process group of its own, so the terminal's Ctrl+C never reaches it: without
 * this, an interrupted run waited for a ten-minute test suite to finish.
 */
export function runShell(
  command: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    if (opts.signal?.aborted) {
      resolvePromise({ code: 130, stdout: '', stderr: 'Interrupted before it started', timedOut: false })
      return
    }
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killTree(child.pid)
        }, opts.timeoutMs)
      : null
    const onAbort = (): void => killTree(child.pid)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d) => (stdout = appendCapped(stdout, String(d))))
    child.stderr?.on('data', (d) => (stderr = appendCapped(stderr, String(d))))
    const finish = (code: number) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code, stdout, stderr, timedOut })
    }
    child.on('error', (err) => {
      stderr = appendCapped(stderr, err.message)
      finish(127)
    })
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)))
  })
}

/** Open a URL in the default browser. Never throws: a headless box simply has none. */
export function openUrl(url: string): void {
  try {
    const child = isWindows
      ? // `start` is a cmd.exe builtin, not a program; the empty string is its window title.
        spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* no browser */ }
}
