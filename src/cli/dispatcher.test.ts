/**
 * Tests for the CLI surface contract in bin/cli.mjs.
 *
 * The restructure cut 19 top-level commands to 6 visible ones, so these cases
 * guard the shape users actually see: what help advertises, that removed
 * commands explain themselves instead of saying "unknown", that agent-facing
 * commands stay reachable but hidden, and that every advertised command resolves.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
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
  it('exposes exactly the six product commands plus the convoy namespace', () => {
    expect(new Set(VISIBLE)).toEqual(
      new Set(['init', 'sync', 'add', 'doctor', 'remove', 'convoy']),
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
    // Generated instructions call these; removing them would break installs.
    expect(HIDDEN).toContain('log')
    expect(HIDDEN).toContain('lesson')
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
    expect(source).toContain("eject: 'opencastle remove --keep-files'")
    expect(source).toContain("destroy: 'opencastle remove --all'")
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
    expect(source).toMatch(/if \(!command\) \{[\s\S]*status\.js/)
  })

  it('silences only the sqlite experimental warning', () => {
    expect(source).toMatch(/removeAllListeners\('warning'\)/)
    expect(source).toMatch(/ExperimentalWarning' && \/SQLite\/i/)
    // Everything else must still reach the user.
    expect(source).toMatch(/console\.error\(`\$\{warning\.name\}: \$\{warning\.message\}`\)/)
  })
})
