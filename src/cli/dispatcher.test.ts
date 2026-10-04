/**
 * Tests for the CLI surface contract in bin/cli.mjs.
 *
 * The restructure cut 19 top-level commands to 6 visible ones, so these cases
 * guard the shape users actually see: what help advertises, that removed
 * commands explain themselves instead of saying "unknown", that agent-facing
 * commands stay reachable but hidden, and that every advertised command resolves.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const cliPath = resolve(import.meta.dirname, '..', '..', 'bin', 'cli.mjs')
const source = readFileSync(cliPath, 'utf8')

/** Pull the keys of an object literal declared as `const NAME = { ... }`. */
function extractKeys(name: string): string[] {
  const start = source.indexOf(`const ${name} = {`)
  expect(start, `${name} not found in bin/cli.mjs`).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  return [...body.matchAll(/^\s{2}(?:'([^']+)'|([a-zA-Z_][\w-]*)):/gm)].map((m) => m[1] ?? m[2])
}

const VISIBLE = extractKeys('VISIBLE')
const HIDDEN = extractKeys('HIDDEN')
const REPLACED = extractKeys('REPLACED')

describe('visible command surface', () => {
  it('exposes the six product commands, the seven team commands, and the convoy namespace', () => {
    expect(new Set(VISIBLE)).toEqual(
      new Set(['init', 'sync', 'add', 'doctor', 'remove', 'explain', 'review', 'ci', 'baseline', 'plugin', 'promote', 'fleet', 'convoy']),
    )
  })

  it('advertises every visible command in help', () => {
    const help = source.slice(source.indexOf('const HELP = `'), source.indexOf('`\n\n/**'))
    for (const cmd of VISIBLE) {
      expect(help, `${cmd} missing from help text`).toContain(cmd)
    }
  })

  it('resolves each visible command to a module that exists', () => {
    for (const cmd of VISIBLE) {
      const match = source.match(new RegExp(`${cmd}: \\(\\) => import\\('\\.\\./dist/cli/([\\w-]+)\\.js'\\)`))
      expect(match, `${cmd} has no import in VISIBLE`).toBeTruthy()
      const src = resolve(import.meta.dirname, `${match![1]}.ts`)
      expect(existsSync(src), `${match![1]}.ts does not exist`).toBe(true)
    }
  })
})

describe('hidden commands', () => {
  it('keeps the agent-invoked commands reachable', () => {
    // Generated instructions call it; removing it would break installs.
    expect(HIDDEN).toContain('lesson')
  })

  it('answers log, which agents no longer call, as removed', () => {
    expect(HIDDEN).not.toContain('log')
    expect(source).toMatch(/\n  log: null,\n/)
  })

  it('keeps update working as the previous name for sync', () => {
    expect(HIDDEN).toContain('update')
    expect(source).toMatch(/update: \(\) => import\('\.\.\/dist\/cli\/sync\.js'\)/)
  })

  it('does not advertise hidden commands in help', () => {
    const help = source.slice(source.indexOf('const HELP = `'), source.indexOf('`\n\n/**'))
    for (const cmd of HIDDEN) {
      expect(help).not.toMatch(new RegExp(`^\\s+${cmd}\\s`, 'm'))
    }
  })
})

describe('removed commands', () => {
  it('covers every command that used to exist', () => {
    // The pre-refactor dispatcher's full command list.
    const previously = [
      'init', 'update', 'eject', 'destroy', 'run', 'plan', 'start', 'dashboard',
      'doctor', 'log', 'lesson', 'agents', 'dispute', 'baselines', 'validate',
      'artifacts', 'insights', 'skills', 'package',
    ]
    const accountedFor = new Set([...VISIBLE, ...HIDDEN, ...REPLACED])
    for (const cmd of previously) {
      expect(accountedFor.has(cmd), `${cmd} is neither available nor explained`).toBe(true)
    }
  })

  it('maps the destructive commands to their replacement flags', () => {
    expect(source).toContain("eject: 'npx opencastle remove --keep-files'")
    expect(source).toContain("destroy: 'npx opencastle remove --all'")
  })

  it('routes convoy execution commands into the namespace', () => {
    for (const cmd of ['run', 'plan', 'start', 'dashboard', 'validate']) {
      expect(REPLACED).toContain(cmd)
    }
  })

  it('never lists a removed command as available', () => {
    for (const cmd of REPLACED) {
      expect(VISIBLE).not.toContain(cmd)
      expect(HIDDEN).not.toContain(cmd)
    }
  })
})

describe('global behavior', () => {
  it('treats no arguments as the status command', () => {
    expect(source).toMatch(/if \(!command \|\| command\.startsWith\('-'\)\)[\s\S]*status\.js/)
  })

  it('routes the flags status documents to status, not to "unknown command"', () => {
    // `opencastle --json` is documented in this file's own help text, in
    // status's help, and on the website, and answered "Unknown command".
    expect(source).toMatch(/bare = \['--json'/)
  })

  it('silences only the sqlite experimental warning', () => {
    expect(source).toMatch(/removeAllListeners\('warning'\)/)
    expect(source).toMatch(/ExperimentalWarning' && \/SQLite\/i/)
    // Everything else must still reach the user.
    expect(source).toMatch(/console\.error\(`\$\{warning\.name\}: \$\{warning\.message\}`\)/)
  })

  it('stops quietly when the reader closes the pipe early', () => {
    // `opencastle init | head` printed an EPIPE stack trace after the lines that
    // were wanted. Whether a run reaches that write depends on timing, so the
    // handler is asserted here rather than raced in a test.
    expect(source).toMatch(/stream\.on\('error'[\s\S]{0,80}err\.code === 'EPIPE'\) process\.exit\(0\)/)
  })
})

describe('--version', () => {
  // Run from a scratch directory: if a command were ever run by mistake here,
  // it must not touch this repository.
  const run = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const cwd = mkdtempSync(join(tmpdir(), 'oc-version-'))
    try {
      const stdout = execFileSync('node', [cliPath, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { code: e.status, stdout: String(e.stdout), stderr: String(e.stderr) }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it('prints the version as the first argument', () => {
    const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'))
    expect(run(['--version']).stdout.trim()).toBe(version)
    expect(run(['-v']).stdout.trim()).toBe(version)
  })

  it('is not read after a command, where -v can be a value or a word', () => {
    // `opencastle log --task -v` printed the version and recorded nothing.
    // A command with a closed flag set refuses it instead of running without it.
    const r = run(['init', '--version'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Unknown option for "init": --version')
    expect(r.stderr).toContain('put it first: opencastle --version')
  })
})
