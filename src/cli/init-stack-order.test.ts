/**
 * Re-running `init` keeps the order the manifest already lists its tools in.
 *
 * The compiled agents name their MCP tools in that order. `init --customize`,
 * run to add Claude Code to a project compiled for VS Code, rebuilt the lists
 * in detection order instead: the same tools, re-sorted, and six VS Code agents
 * rewritten in a pull request that was only meant to add a target.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')
const cliBuilt = existsSync(join(repoRoot, 'dist', 'cli', 'init.js'))

describe.skipIf(!cliBuilt)('init over an existing install', () => {
  let projectRoot: string
  const run = (...args: string[]): void => {
    execFileSync('node', [cli, ...args], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const manifest = (): { stack: { techTools: string[] } } & Record<string, unknown> =>
    JSON.parse(readFileSync(join(projectRoot, '.opencastle', 'manifest.json'), 'utf8'))
  const agents = (): Record<string, string> => {
    const dir = join(projectRoot, '.github', 'agents')
    return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oc-stack-order-'))
    execFileSync('git', ['init', '-q'], { cwd: projectRoot })
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'demo-app',
        scripts: { test: 'vitest run' },
        dependencies: { next: '15.0.0', resend: '4.0.0' },
        devDependencies: { vitest: '3.0.0', '@playwright/test': '1.50.0' },
      }),
    )
  })
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }))

  it('keeps the tools in the order the manifest has, so no agent is rewritten', () => {
    run('init', '--yes')
    const first = manifest()
    expect(first.stack.techTools.length).toBeGreaterThan(1)

    // The order an older release, or an older detection, wrote.
    const reversed = [...first.stack.techTools].reverse()
    writeFileSync(join(projectRoot, '.opencastle', 'manifest.json'), `${JSON.stringify({ ...first, stack: { ...first.stack, techTools: reversed } }, null, 2)}\n`)
    run('sync', '--yes')
    const before = agents()

    run('init', '--yes')
    expect(manifest().stack.techTools).toEqual(reversed)
    expect(agents()).toEqual(before)
  })
})
