import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { forgetHelpText } from '../platform.js'

/**
 * A stand-in agent CLI for adapter tests: a POSIX shell script put on a
 * scratch PATH under the real command's name. It records the arguments it was
 * given, the directory it ran in and what arrived on stdin, prints canned
 * output, and exits with a chosen code. No real agent session is ever started.
 */

const SCRIPT = `#!/bin/sh
# The adapters read --help to learn which flags this version has. It is
# answered here and not recorded, so argv is still the session's.
if [ "$1" = "--help" ]; then printf '%s\\n' "$STUB_HELP"; exit 0; fi
log="$STUB_LOG"
pwd > "$log/cwd"
: > "$log/argv"
for a in "$@"; do printf '%s\\n' "$a" >> "$log/argv"; done
cat > "$log/stdin"
if [ -n "$STUB_SLEEP" ]; then sleep "$STUB_SLEEP"; fi
if [ -n "$STUB_LAST_MESSAGE" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-o" ] || [ "$prev" = "--output-last-message" ]; then printf '%s' "$STUB_LAST_MESSAGE" > "$a"; fi
    prev="$a"
  done
fi
if [ -f "$log/stdout.txt" ]; then cat "$log/stdout.txt"; fi
if [ -f "$log/stderr.txt" ]; then cat "$log/stderr.txt" >&2; fi
exit "\${STUB_EXIT:-0}"
`

export interface StubCli {
  /** Directory on PATH holding the stub(s). */
  bin: string
  /** Directory the stub writes its records into. */
  log: string
  /** A scratch directory to run the agent in. */
  work: string
  /** What the stub prints on stdout (and stderr) next time it runs. */
  respond(stdout: string, stderr?: string): void
  /** What it prints for `--help`; nothing until set. */
  help(text: string): void
  argv(): string[]
  cwd(): string
  stdin(): string
  /** Restore PATH and remove the scratch directories. */
  restore(): void
}

/**
 * Put stub CLIs named `names` on a PATH of their own, replacing the real one
 * so a real CLI can never be reached. `sh`, `cat` and `pwd` are still found
 * through /bin and /usr/bin.
 */
export function installStubCli(...names: string[]): StubCli {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-stub-')))
  const bin = join(root, 'bin')
  const log = join(root, 'log')
  const work = join(root, 'work')
  for (const d of [bin, log, work]) mkdirSync(d)
  for (const name of names) {
    writeFileSync(join(bin, name), SCRIPT)
    chmodSync(join(bin, name), 0o755)
  }
  const saved = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG, STUB_HELP: process.env.STUB_HELP }
  delete process.env.STUB_HELP
  forgetHelpText()
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter)
  process.env.STUB_LOG = log
  const read = (f: string) => (existsSync(join(log, f)) ? readFileSync(join(log, f), 'utf8') : '')
  return {
    bin,
    log,
    work,
    help(text) {
      process.env.STUB_HELP = text
      forgetHelpText()
    },
    respond(stdout, stderr) {
      writeFileSync(join(log, 'stdout.txt'), stdout)
      if (stderr !== undefined) writeFileSync(join(log, 'stderr.txt'), stderr)
    },
    argv: () => read('argv').split('\n').slice(0, -1),
    cwd: () => read('cwd').trim(),
    stdin: () => read('stdin'),
    restore() {
      process.env.PATH = saved.PATH
      if (saved.STUB_LOG === undefined) delete process.env.STUB_LOG
      else process.env.STUB_LOG = saved.STUB_LOG
      if (saved.STUB_HELP === undefined) delete process.env.STUB_HELP
      else process.env.STUB_HELP = saved.STUB_HELP
      forgetHelpText()
      delete process.env.STUB_EXIT
      delete process.env.STUB_LAST_MESSAGE
      delete process.env.STUB_SLEEP
      rmSync(root, { recursive: true, force: true })
    },
  }
}

