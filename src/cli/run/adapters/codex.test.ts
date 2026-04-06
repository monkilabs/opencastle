import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import type { Task } from '../../types.js'

function makeTask(): Task {
  return {
    id: 'test-task',
    agent: 'developer',
    prompt: 'Do something',
    files: [],
    timeout: '5m',
    depends_on: [],
    description: 'test task',
    max_retries: 0,
  } as unknown as Task
}

function makeMockProc(exitCode = 0, stdoutData = '', stderrData = '') {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = vi.fn()
  process.nextTick(() => {
    if (stdoutData) proc.stdout.emit('data', Buffer.from(stdoutData))
    if (stderrData) proc.stderr.emit('data', Buffer.from(stderrData))
    proc.emit('close', exitCode)
  })
  return proc
}

describe('codex adapter', () => {
  let mockSpawn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockSpawn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0)
      return makeMockProc(0)
    })
    vi.doMock('node:child_process', () => ({ spawn: mockSpawn }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads through the runtime adapter registry', async () => {
    const { getAdapter } = await import('./index.js')
    const adapter = await getAdapter('codex')
    expect(adapter.name).toBe('codex')
  })

  it('reports availability when codex is on PATH', async () => {
    const { isAvailable } = await import('./codex.js')
    await expect(isAvailable()).resolves.toBe(true)
  })

  it('returns the final agent message written via --output-last-message', async () => {
    const capturedArgs: string[] = []

    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') return makeMockProc(0)
      capturedArgs.push(...args)
      const outputIdx = args.indexOf('-o')
      const outputPath = args[outputIdx + 1]
      if (outputPath) {
        writeFileSync(outputPath, 'I did the task\n', 'utf8')
      }
      return makeMockProc(0, '', 'progress')
    })

    const { execute } = await import('./codex.js')
    const result = await execute(makeTask(), { cwd: process.cwd() })

    expect(result.success).toBe(true)
    expect(result.output).toBe('I did the task')
    expect(capturedArgs).toContain('exec')
    expect(capturedArgs).toContain('-a')
    expect(capturedArgs).toContain('never')
    expect(capturedArgs).toContain('-s')
    expect(capturedArgs).toContain('workspace-write')
    expect(capturedArgs).toContain('--ephemeral')
    expect(capturedArgs).toContain('-C')
    expect(capturedArgs).toContain(process.cwd())
  })

  it('falls back to combined stdout and stderr when execution fails', async () => {
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0)
      return makeMockProc(1, 'stdout failure', 'stderr failure')
    })

    const { execute } = await import('./codex.js')
    const result = await execute(makeTask(), { cwd: process.cwd() })

    expect(result.success).toBe(false)
    expect(result.output).toContain('stdout failure')
    expect(result.output).toContain('stderr failure')
  })

  it('cleans up the temporary output file after execution', async () => {
    let outputPath = ''

    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') return makeMockProc(0)
      const outputIdx = args.indexOf('-o')
      outputPath = args[outputIdx + 1] ?? ''
      if (outputPath) {
        writeFileSync(outputPath, 'done\n', 'utf8')
      }
      return makeMockProc(0)
    })

    const { execute } = await import('./codex.js')
    await execute(makeTask(), { cwd: process.cwd() })

    expect(outputPath).not.toBe('')
    expect(existsSync(outputPath)).toBe(false)
    if (outputPath) {
      rmSync(outputPath, { force: true })
    }
  })
})
