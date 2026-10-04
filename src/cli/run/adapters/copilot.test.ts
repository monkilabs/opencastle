import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../../convoy/spec-types.js'
import { installStubCli, type StubCli } from './stub-cli.test-helper.js'
import { execute, isAvailable, parseCopilotOutput } from './copilot.js'

const posix = process.platform !== 'win32'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task', agent: 'developer', prompt: 'Do something', files: [], timeout: '5m',
    depends_on: [], description: 'test task', max_retries: 0, ...overrides,
  }
}

const ev = (id: string, type: string, data: Record<string, unknown>) =>
  JSON.stringify({ id, timestamp: '2026-10-03T11:00:00.000Z', parentId: null, type, data })

/**
 * `copilot --output-format json` stdout (Copilot CLI 1.0): session events, one
 * per line, then the `result` line the CLI writes itself. The JSON writer
 * drops `assistant.usage` and `session.shutdown`, so the only token figures
 * left are the output tokens on each assistant message.
 */
const STREAM = [
  ev('e1', 'session.start', {
    sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2', version: 1, producer: 'copilot-agent',
    copilotVersion: '1.0.22', startTime: '2026-10-03T11:00:00.000Z', selectedModel: 'claude-sonnet-4.5',
    context: { cwd: '/work' },
  }),
  ev('e2', 'session.tools_updated', { model: 'claude-sonnet-4.5' }),
  ev('e3', 'user.message', { content: 'Do something' }),
  ev('e4', 'assistant.turn_start', { turnId: '0' }),
  ev('e5', 'assistant.message', {
    messageId: 'm1', content: '', outputTokens: 48, interactionId: 'i1',
    toolRequests: [{ toolCallId: 'c1', name: 'task', arguments: { prompt: 'look around' } }],
  }),
  ev('e6', 'assistant.message', { messageId: 'm2', content: 'Sub-agent notes.', outputTokens: 30, parentToolCallId: 'c1' }),
  ev('e7', 'tool.execution_complete', { toolCallId: 'c1', success: true }),
  ev('e8', 'assistant.message', { messageId: 'm3', content: 'Updated src/a.ts to handle empty input.', outputTokens: 212, interactionId: 'i2' }),
  ev('e9', 'assistant.turn_end', { turnId: '0' }),
  JSON.stringify({
    type: 'result', timestamp: '2026-10-03T11:00:09.876Z', sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2', exitCode: 0,
    usage: { premiumRequests: 1, totalApiDurationMs: 8123, sessionDurationMs: 9876, codeChanges: { linesAdded: 4, linesRemoved: 1, filesModified: ['src/a.ts'] } },
  }),
].join('\n')

describe('parseCopilotOutput', () => {
  it('reads the answer, the model and the output tokens Copilot reported', () => {
    const parsed = parseCopilotOutput(STREAM)
    // The last top-level message, not a sub-agent's.
    expect(parsed.text).toBe('Updated src/a.ts to handle empty input.')
    expect(parsed.model).toBe('claude-sonnet-4.5')
    // Every message's output tokens, the sub-agent's included.
    expect(parsed.completionTokens).toBe(48 + 30 + 212)
    expect(parsed.resultExitCode).toBe(0)
  })

  it('collects session errors and the exit code the result recorded', () => {
    const failed = [
      ev('e1', 'session.error', { errorType: 'authentication', message: 'No authentication information found.' }),
      JSON.stringify({ type: 'result', timestamp: 't', sessionId: 's', exitCode: 1, usage: { premiumRequests: 0 } }),
    ].join('\n')
    const parsed = parseCopilotOutput(failed)
    expect(parsed.errors).toEqual(['No authentication information found.'])
    expect(parsed.resultExitCode).toBe(1)
    expect(parsed.completionTokens).toBeUndefined()
  })
})

describe.skipIf(!posix)('copilot adapter — against a stub `copilot`', () => {
  let stub: StubCli

  beforeEach(() => {
    stub = installStubCli('copilot')
    stub.respond(STREAM)
  })
  afterEach(() => stub.restore())

  it('is available only when the `copilot` CLI is on PATH — a bundled SDK does not count', async () => {
    expect(await isAvailable()).toBe(true)
    stub.restore()
    stub = installStubCli()
    expect(await isAvailable()).toBe(false)
  })

  it('sends the prompt on stdin, without -p, and runs in the task directory', async () => {
    // Copilot's SDK session worked in this process's directory, so tasks edited
    // the user's checkout; the CLI works where it is started.
    const task = makeTask()
    const result = await execute(task, { cwd: stub.work })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Updated src/a.ts to handle empty input.')
    expect(result.model).toBe('claude-sonnet-4.5')
    expect(result.usage).toEqual({ completion_tokens: 290 })
    expect(result.costUsd).toBeUndefined()
    expect(stub.stdin()).toBe(task.prompt)
    expect(stub.cwd()).toBe(stub.work)
    const argv = stub.argv()
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain(task.prompt)
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'json', '--no-ask-user']))
  })

  it('honours the permission mode instead of approving everything', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).toContain('--allow-tool=write')
    expect(stub.argv()).not.toContain('--allow-all')

    await execute(makeTask(), { cwd: stub.work, permissionMode: 'plan' })
    expect(stub.argv()).toEqual(expect.arrayContaining(['--deny-tool=write', '--deny-tool=shell']))
    expect(stub.argv()).not.toContain('--allow-tool=write')

    await execute(makeTask(), { cwd: stub.work, permissionMode: 'bypassPermissions' })
    expect(stub.argv()).toContain('--allow-all')
  })

  it('passes --model only when one is set', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).not.toContain('--model')
    await execute(makeTask(), { cwd: stub.work, model: 'gpt-5.2' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5.2')
  })

  it('asks for less effort only when this version has --effort', async () => {
    stub.help('  --effort, --reasoning-effort <level>  Set the reasoning effort level')
    await execute(makeTask(), { cwd: stub.work, effort: 'low' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low')

    stub.help('  --model <model>  Set the AI model to use')
    await execute(makeTask(), { cwd: stub.work, effort: 'low' })
    expect(stub.argv()).not.toContain('--effort')
  })

  it('lets Copilot load the project\'s MCP config from an untrusted worktree', async () => {
    const script = join(stub.bin, 'copilot')
    writeFileSync(script, readFileSync(script, 'utf8').replace('pwd > "$log/cwd"', 'pwd > "$log/cwd"; printf %s "$GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP" > "$log/mcp"'))
    chmodSync(script, 0o755)
    await execute(makeTask(), { cwd: stub.work, mcpServers: [{ name: 'x', type: 'stdio', command: 'x' }] })
    expect(readFileSync(join(stub.log, 'mcp'), 'utf8')).toBe('true')
    expect(stub.argv().join(' ')).not.toMatch(/mcp/i)
  })

  it('fails when the result records a failure', async () => {
    process.env.STUB_EXIT = '1'
    stub.respond(ev('e1', 'session.error', { errorType: 'quota', message: 'Quota exceeded' }) + '\n', 'Error: quota')
    const result = await execute(makeTask(), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Quota exceeded')
  })

  it('times out with success false', async () => {
    process.env.STUB_SLEEP = '30'
    const result = await execute(makeTask({ timeout: '300ms' }), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result._timedOut).toBe(true)
  })
})
