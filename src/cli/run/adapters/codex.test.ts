import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import type { Task } from '../../convoy/spec-types.js'
import { installStubCli, type StubCli } from './stub-cli.test-helper.js'
import { execute, isAvailable, parseCodexOutput } from './codex.js'

const posix = process.platform !== 'win32'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task', agent: 'developer', prompt: 'Do something', files: [], timeout: '5m',
    depends_on: [], description: 'test task', max_retries: 0, ...overrides,
  }
}

/**
 * `codex exec --json` stdout: the sample from Codex's non-interactive docs,
 * with the fields the current event structs always serialize. `turn.completed`
 * carries the thread's running total; `input_tokens` includes the cached ones.
 */
const STREAM = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Inspecting repo layout**"}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\\nsdk\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"cache_write_input_tokens":0,"output_tokens":122,"reasoning_output_tokens":0}}',
].join('\n')

describe('parseCodexOutput', () => {
  it('reads the token counts from turn.completed and the final message', () => {
    const parsed = parseCodexOutput(STREAM)
    expect(parsed.usage).toEqual({
      prompt_tokens: 24763,
      completion_tokens: 122,
      total_tokens: 24885,
      cache_read_tokens: 24448,
    })
    expect(parsed.text).toBe('Repo contains docs, sdk, and examples directories.')
    expect(parsed.errors).toEqual([])
  })

  it('takes the last running total when there are several turns', () => {
    const two = STREAM + '\n' + '{"type":"turn.completed","usage":{"input_tokens":50000,"cached_input_tokens":40000,"output_tokens":300,"reasoning_output_tokens":10}}'
    expect(parseCodexOutput(two).usage?.prompt_tokens).toBe(50000)
  })

  it('reads the token_count events older releases printed', () => {
    const legacy = [
      '{"id":"0","msg":{"type":"task_started"}}',
      '{"id":"0","msg":{"type":"token_count","info":null}}',
      '{"id":"0","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3051,"cached_input_tokens":2944,"output_tokens":87,"reasoning_output_tokens":64,"total_tokens":3138},"last_token_usage":{"input_tokens":3051,"cached_input_tokens":2944,"output_tokens":87,"reasoning_output_tokens":64,"total_tokens":3138},"model_context_window":272000}}}',
    ].join('\n')
    expect(parseCodexOutput(legacy).usage).toEqual({
      prompt_tokens: 3051, completion_tokens: 87, total_tokens: 3138, cache_read_tokens: 2944,
    })
  })

  it('collects the failure messages and names no cost or model it was not given', () => {
    const failed = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"stream disconnected before completion"}',
      '{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}',
    ].join('\n')
    const parsed = parseCodexOutput(failed)
    expect(parsed.errors).toHaveLength(2)
    expect(parsed.usage).toBeUndefined()
    expect(Object.keys(parsed)).not.toContain('costUsd')
  })
})

describe.skipIf(!posix)('codex adapter — against a stub `codex`', () => {
  let stub: StubCli

  beforeEach(() => {
    stub = installStubCli('codex')
    stub.respond(STREAM, 'progress on stderr')
    process.env.STUB_LAST_MESSAGE = 'I did the task\n'
  })
  afterEach(() => stub.restore())

  it('is available only when `codex` is on PATH', async () => {
    expect(await isAvailable()).toBe(true)
    stub.restore()
    stub = installStubCli()
    expect(await isAvailable()).toBe(false)
  })

  it('reads the prompt from stdin, works in the task directory, and reports usage', async () => {
    const task = makeTask()
    const result = await execute(task, { cwd: stub.work })
    expect(result.success).toBe(true)
    expect(result.output).toBe('I did the task')
    expect(result.usage?.cache_read_tokens).toBe(24448)
    expect(result.costUsd).toBeUndefined()
    expect(stub.stdin()).toBe(task.prompt)
    expect(stub.cwd()).toBe(stub.work)
    const argv = stub.argv()
    expect(argv[0]).toBe('exec')
    expect(argv.at(-1)).toBe('-')
    expect(argv).toContain('--json')
    expect(argv[argv.indexOf('-C') + 1]).toBe(stub.work)
    expect(argv).not.toContain(task.prompt)
    // `-a` is not an exec option; before `exec` it was parsed and ignored.
    expect(argv).not.toContain('-a')
  })

  it('maps the permission mode onto the sandbox', async () => {
    const sandbox = () => { const a = stub.argv(); return a[a.indexOf('-s') + 1] }
    await execute(makeTask(), { cwd: stub.work })
    expect(sandbox()).toBe('workspace-write')
    await execute(makeTask(), { cwd: stub.work, permissionMode: 'plan' })
    expect(sandbox()).toBe('read-only')
    await execute(makeTask(), { cwd: stub.work, permissionMode: 'bypassPermissions' })
    expect(sandbox()).toBe('danger-full-access')
  })

  it('passes -m only when a model is set', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).not.toContain('-m')
    await execute(makeTask(), { cwd: stub.work, model: 'gpt-5.1-codex' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.1-codex')
  })

  it('sets the reasoning effort as a config override, quoted as TOML', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).not.toContain('-c')
    await execute(makeTask(), { cwd: stub.work, effort: 'medium' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"')
    expect(argv.at(-1)).toBe('-')
  })

  it('reports the failure messages on a non-zero exit', async () => {
    process.env.STUB_EXIT = '1'
    delete process.env.STUB_LAST_MESSAGE
    stub.respond('{"type":"turn.failed","error":{"message":"unauthorized"}}\n', 'stderr failure')
    const result = await execute(makeTask(), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result.output).toContain('unauthorized')
    expect(result.output).toContain('stderr failure')
  })

  it('removes its temporary output file', async () => {
    await execute(makeTask(), { cwd: stub.work })
    const argv = stub.argv()
    expect(existsSync(argv[argv.indexOf('-o') + 1])).toBe(false)
  })

  it('times out with success false', async () => {
    process.env.STUB_SLEEP = '30'
    const result = await execute(makeTask({ timeout: '300ms' }), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result._timedOut).toBe(true)
  })
})
