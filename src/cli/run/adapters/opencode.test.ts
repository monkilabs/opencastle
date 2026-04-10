import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Task } from '../../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeMockProc(exitCode = 0, stdoutData = '{"result":"ok"}') {
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
    proc.emit('close', exitCode)
  })
  return proc
}

// ── CLI mode ──────────────────────────────────────────────────────────────────

describe('opencode adapter — MCP support', () => {
  let tmpDir: string
  let mockSpawn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-test-')))

    mockSpawn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, '{"result":"ok"}')
    })
    vi.doMock('node:child_process', () => ({ spawn: mockSpawn }))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('writes mcp.json to cwd with correct format when mcpServers provided', async () => {
    let capturedContent: string | null = null
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      const mcpPath = join(tmpDir, 'mcp.json')
      if (existsSync(mcpPath)) {
        capturedContent = readFileSync(mcpPath, 'utf8')
      }
      return makeMockProc(0, '{}')
    })

    const { execute } = await import('./opencode.js')
    const mcpServers = [{ name: 'my-mcp', type: 'local', command: 'node', args: ['server.js'] }]
    await execute(makeTask(), { mcpServers, cwd: tmpDir })

    expect(capturedContent).not.toBeNull()
    expect(JSON.parse(capturedContent!)).toEqual({
      mcpServers: { 'my-mcp': { command: 'node', args: ['server.js'] } },
    })
  })

  it('passes --mcp-config flag pointing to mcp.json path', async () => {
    const capturedArgs: string[] = []
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') return makeMockProc(0, '')
      capturedArgs.push(...args)
      return makeMockProc(0, '{}')
    })
    const { execute } = await import('./opencode.js')
    const mcpServers = [{ name: 'my-mcp', type: 'local', command: 'node', args: ['server.js'] }]
    await execute(makeTask(), { mcpServers, cwd: tmpDir })

    const idx = capturedArgs.indexOf('--mcp-config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(capturedArgs[idx + 1]).toBe(join(tmpDir, 'mcp.json'))
  })

  it('cleans up mcp.json after successful execution', async () => {
    const { execute } = await import('./opencode.js')
    const mcpServers = [{ name: 'my-mcp', type: 'local', command: 'node', args: ['server.js'] }]
    await execute(makeTask(), { mcpServers, cwd: tmpDir })
    expect(existsSync(join(tmpDir, 'mcp.json'))).toBe(false)
  })

  it('cleans up mcp.json after failed execution (non-zero exit)', async () => {
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(1, '')
    })
    const { execute } = await import('./opencode.js')
    const mcpServers = [{ name: 'err-mcp', type: 'local', command: 'node', args: [] }]
    await execute(makeTask(), { mcpServers, cwd: tmpDir })
    expect(existsSync(join(tmpDir, 'mcp.json'))).toBe(false)
  })

  it('does NOT write mcp.json when mcpServers not configured', async () => {
    const { execute } = await import('./opencode.js')
    await execute(makeTask(), { cwd: tmpDir })
    expect(existsSync(join(tmpDir, 'mcp.json'))).toBe(false)
  })

  it('does NOT add --mcp-config when mcpServers not provided', async () => {
    const capturedArgs: string[] = []
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') return makeMockProc(0, '')
      capturedArgs.push(...args)
      return makeMockProc(0, '{}')
    })
    const { execute } = await import('./opencode.js')
    await execute(makeTask(), { cwd: tmpDir })
    expect(capturedArgs).toContain('run')
    expect(capturedArgs).not.toContain('--mcp-config')
  })

  it('passes --approve-mcps when mcp_approve_all is true', async () => {
    const capturedArgs: string[] = []
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') return makeMockProc(0, '')
      capturedArgs.push(...args)
      return makeMockProc(0, '{}')
    })
    const { execute } = await import('./opencode.js')
    await execute(makeTask(), { mcp_approve_all: true, cwd: tmpDir })
    expect(capturedArgs).toContain('--approve-mcps')
  })

  it('does NOT add --approve-mcps when mcp_approve_all is not set', async () => {
    const capturedArgs: string[] = []
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') return makeMockProc(0, '')
      capturedArgs.push(...args)
      return makeMockProc(0, '{}')
    })
    const { execute } = await import('./opencode.js')
    await execute(makeTask(), { cwd: tmpDir })
    expect(capturedArgs).not.toContain('--approve-mcps')
  })

  it('extracts result from single-line JSON output', async () => {
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, '{"result":"# My PRD\\n\\nThe actual content"}')
    })
    const { execute } = await import('./opencode.js')
    const result = await execute(makeTask(), { cwd: tmpDir })
    expect(result.output).toBe('# My PRD\n\nThe actual content')
  })

  it('extracts result from JSONL output (last line has result)', async () => {
    const jsonl = [
      '{"type":"progress","content":"thinking..."}',
      '{"type":"tool_use","tool":"read_file","args":{}}',
      '{"type":"result","result":"# My PRD\\n\\nThe actual markdown content","usage":{"input_tokens":500,"output_tokens":1000}}',
    ].join('\n')
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, jsonl)
    })
    const { execute } = await import('./opencode.js')
    const result = await execute(makeTask(), { cwd: tmpDir })
    expect(result.output).toBe('# My PRD\n\nThe actual markdown content')
    expect(result.usage?.prompt_tokens).toBe(500)
    expect(result.usage?.completion_tokens).toBe(1000)
  })

  it('scans JSONL and finds result line among non-result lines', async () => {
    const jsonl = [
      '{"type":"progress","content":"thinking..."}',
      '{"type":"tool_use","tool":"edit","args":{}}',
      '{"type":"result","result":"# Final Content","usage":{"input_tokens":100,"output_tokens":200}}',
      '{"type":"done"}',
    ].join('\n')
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, jsonl)
    })
    const { execute } = await import('./opencode.js')
    const result = await execute(makeTask(), { cwd: tmpDir })
    expect(result.output).toBe('# Final Content')
  })

  it('extracts content from Copilot-style assistant.message JSONL', async () => {
    const jsonl = [
      '{"type":"session.tools_updated","data":{"model":"claude-sonnet-4.6"}}',
      '{"type":"user.message","data":{"content":"Generate a PRD"}}',
      '{"type":"assistant.message","data":{"content":"# My PRD\\n\\nThe generated content","outputTokens":50}}',
      '{"type":"assistant.turn_end","data":{"turnId":"0"}}',
      '{"type":"result","sessionId":"abc","exitCode":0,"usage":{"premiumRequests":1}}',
    ].join('\n')
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, jsonl)
    })
    const { execute } = await import('./opencode.js')
    const result = await execute(makeTask(), { cwd: tmpDir })
    expect(result.output).toBe('# My PRD\n\nThe generated content')
  })

  it('uses last assistant.message when multiple turns exist', async () => {
    const jsonl = [
      '{"type":"assistant.message","data":{"content":"Let me check..."}}',
      '{"type":"assistant.message","data":{"content":"# Final PRD\\n\\nComplete document"}}',
      '{"type":"result","sessionId":"abc","exitCode":0}',
    ].join('\n')
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, jsonl)
    })
    const { execute } = await import('./opencode.js')
    const result = await execute(makeTask(), { cwd: tmpDir })
    expect(result.output).toBe('# Final PRD\n\nComplete document')
  })

  it('falls back to raw output when JSON has no result field', async () => {
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'which') return makeMockProc(0, '')
      return makeMockProc(0, '{"status":"ok","data":"something"}')
    })
    const { execute } = await import('./opencode.js')
    const result = await execute(makeTask(), { cwd: tmpDir })
    expect(result.output).toBe('{"status":"ok","data":"something"}')
  })
})
