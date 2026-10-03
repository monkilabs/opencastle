import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { resolveCommand, commandExists, quoteForCmd, runShell, spawnCommand, killTree } from './platform.js'

const posix = process.platform !== 'win32'

describe('finding a command without `which`', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it.skipIf(!posix)('finds an executable on PATH and ignores a file that is not one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-path-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'fake-agent'), '#!/bin/sh\necho hi\n')
    chmodSync(join(dir, 'fake-agent'), 0o755)
    writeFileSync(join(dir, 'not-executable'), 'x')
    const env = { PATH: dir }
    expect(resolveCommand('fake-agent', env)).toBe(join(dir, 'fake-agent'))
    expect(await commandExists('fake-agent', env)).toBe(true)
    expect(await commandExists('not-executable', env)).toBe(false)
    expect(await commandExists('nowhere-to-be-found', env)).toBe(false)
  })
})

describe('quoting for cmd.exe', () => {
  // The same output cross-spawn produces for these inputs.
  it('quotes and caret-escapes metacharacters', () => {
    expect(quoteForCmd('hello world')).toBe('^"hello^ world^"')
    expect(quoteForCmd('a&b')).toBe('^"a^&b^"')
  })

  it('escapes a double quote with a backslash, then the quote itself', () => {
    expect(quoteForCmd('say "hi"')).toBe('^"say^ \\^"hi\\^"^"')
  })

  it('escapes twice for a .cmd shim, which re-parses its arguments', () => {
    expect(quoteForCmd('a&b', true)).toBe('^^^"a^^^&b^^^"')
  })
})

describe.skipIf(!posix)('running a gate through the platform shell', () => {
  it('reports the exit code and both streams', async () => {
    const r = await runShell('echo out && echo err 1>&2 && exit 3', { cwd: tmpdir() })
    expect(r.code).toBe(3)
    expect(r.stdout.trim()).toBe('out')
    expect(r.stderr.trim()).toBe('err')
    expect(r.timedOut).toBe(false)
  })

  it('stops a command that runs past its timeout', async () => {
    const started = Date.now()
    const r = await runShell('sleep 30', { cwd: tmpdir(), timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe.skipIf(!posix)('stopping a process tree', () => {
  it('reaches the children of the process, not only the process', async () => {
    // A shell that starts a child and waits on it: killing only the shell left the child running.
    const child = spawnCommand('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 200))
    const closed = new Promise<void>((r) => child.on('close', () => r()))
    killTree(child.pid)
    await closed
    let groupAlive = true
    try {
      process.kill(-child.pid!, 0)
    } catch {
      groupAlive = false
    }
    expect(groupAlive).toBe(false)
  })

  it('kills at once with a grace of 0, for a process that cannot wait to escalate', async () => {
    // A shell that ignores SIGTERM: only SIGKILL ends it, and here it comes first.
    const child = spawnCommand('sh', ['-c', "trap '' TERM; echo ready; while true; do sleep 1; done"], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((r) => child.stdout!.once('data', () => r()))
    const started = Date.now()
    const closed = new Promise<NodeJS.Signals | null>((r) => child.on('close', (_code, signal) => r(signal)))
    killTree(child.pid, 0)
    expect(await closed).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('does nothing for a process that is already gone', () => {
    expect(() => killTree(2 ** 22 + 12345)).not.toThrow()
    expect(() => killTree(undefined)).not.toThrow()
  })
})
