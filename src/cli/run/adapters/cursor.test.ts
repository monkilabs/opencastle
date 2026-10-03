import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, symlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../../convoy/spec-types.js'
import { installStubCli, type StubCli } from './stub-cli.test-helper.js'
import { execute, isAvailable, cursorCommand, parseCursorOutput } from './cursor.js'

const posix = process.platform !== 'win32'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task', agent: 'developer', prompt: 'Do something', files: [], timeout: '5m',
    depends_on: [], description: 'test task', max_retries: 0, ...overrides,
  }
}

/** The terminal object from Cursor's output-format docs, verbatim. */
const DOCS_RESULT = '{"type":"result","subtype":"success","duration_ms":5234,"duration_api_ms":5234,"is_error":false,"result":"I\'ll read the README.md fileBased on the README, I\'ll create a summaryDone! I\'ve created the summary in summary.txt","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","request_id":"10e11780-df2f-45dc-a1ff-4540af32e9c0"}'

/** The same, as recent releases print it: with `usage` summed over turns, input excluding the cache. */
const RESULT_WITH_USAGE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 5234, duration_api_ms: 5234,
  result: 'Done.', session_id: 'c6b62c6f-7ead-4fd6-9922-e952131177ff', request_id: '10e11780-df2f-45dc-a1ff-4540af32e9c0',
  usage: { inputTokens: 812, outputTokens: 240, cacheReadTokens: 15360, cacheWriteTokens: 1024 },
})

describe('parseCursorOutput', () => {
  it('reads the result text, and no usage when there is none', () => {
    const parsed = parseCursorOutput(DOCS_RESULT)
    expect(parsed.text).toContain('created the summary in summary.txt')
    expect(parsed.usage).toBeUndefined()
    expect(parsed.isError).toBeUndefined()
  })

  it('reads usage when the result carries it', () => {
    expect(parseCursorOutput(RESULT_WITH_USAGE).usage).toEqual({
      prompt_tokens: 812 + 15360 + 1024,
      completion_tokens: 240,
      total_tokens: 812 + 15360 + 1024 + 240,
      cache_read_tokens: 15360,
      cache_write_tokens: 1024,
    })
  })

  it('finds the result line in a stream-json transcript', () => {
    const stream = '{"type":"system","subtype":"init","model":"Claude 4 Sonnet"}\n' + DOCS_RESULT
    expect(parseCursorOutput(stream).text).toContain('summary.txt')
  })
})

describe.skipIf(!posix)('finding Cursor\'s agent CLI', () => {
  let stub: StubCli
  afterEach(() => stub.restore())

  it('prefers `cursor-agent`', () => {
    stub = installStubCli('cursor-agent', 'agent')
    expect(cursorCommand()).toBe('cursor-agent')
  })

  it('does not take an unrelated `agent` for Cursor', async () => {
    stub = installStubCli('agent')
    expect(cursorCommand()).toBeNull()
    expect(await isAvailable()).toBe(false)
  })

  it('accepts a lone `agent` that resolves into Cursor\'s install', async () => {
    stub = installStubCli('agent')
    // The installer's layout: ~/.local/bin/agent -> ~/.local/share/cursor-agent/versions/<v>/cursor-agent
    const versions = join(stub.log, 'share', 'cursor-agent', 'versions', '2026.10.01')
    mkdirSync(versions, { recursive: true })
    renameSync(join(stub.bin, 'agent'), join(versions, 'cursor-agent'))
    symlinkSync(join(versions, 'cursor-agent'), join(stub.bin, 'agent'))
    expect(cursorCommand()).toBe('agent')
    expect(await isAvailable()).toBe(true)
  })
})

describe.skipIf(!posix)('cursor adapter — against a stub `cursor-agent`', () => {
  let stub: StubCli

  beforeEach(() => {
    stub = installStubCli('cursor-agent')
    stub.respond(RESULT_WITH_USAGE)
  })
  afterEach(() => stub.restore())

  it('sends the prompt on stdin and runs in the task directory', async () => {
    const task = makeTask()
    const result = await execute(task, { cwd: stub.work })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Done.')
    expect(result.usage?.cache_read_tokens).toBe(15360)
    expect(result.costUsd).toBeUndefined()
    expect(stub.stdin()).toBe(task.prompt)
    expect(stub.cwd()).toBe(stub.work)
    expect(stub.argv().slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    expect(stub.argv()).not.toContain(task.prompt)
  })

  it('applies edits with --force by default, and stays read-only in plan', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).toContain('--force')

    await execute(makeTask(), { cwd: stub.work, permissionMode: 'plan' })
    const argv = stub.argv()
    expect(argv).not.toContain('--force')
    expect(argv[argv.indexOf('--mode') + 1]).toBe('ask')
    // A headless run in an untrusted workspace — a new worktree — exits at once without it.
    expect(argv).toContain('--trust')
  })

  it('passes --model only when one is set, and never an MCP flag', async () => {
    await execute(makeTask(), { cwd: stub.work, mcpServers: [{ name: 'x', type: 'stdio', command: 'x' }], mcp_approve_all: true })
    expect(stub.argv()).not.toContain('--model')
    expect(stub.argv()).not.toContain('--mcp-config')
    expect(stub.argv()).not.toContain('--approve-mcps')
    await execute(makeTask(), { cwd: stub.work, model: 'sonnet-4.5' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet-4.5')
  })

  it('reports stderr when Cursor fails, as it prints no JSON then', async () => {
    process.env.STUB_EXIT = '1'
    stub.respond('', 'Workspace Trust Required')
    const result = await execute(makeTask(), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Workspace Trust Required')
  })

  it('times out with success false', async () => {
    process.env.STUB_SLEEP = '30'
    const result = await execute(makeTask({ timeout: '300ms' }), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result._timedOut).toBe(true)
  })
})
