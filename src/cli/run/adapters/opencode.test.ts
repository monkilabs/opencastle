import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../../convoy/spec-types.js'
import { installStubCli, type StubCli } from './stub-cli.test-helper.js'
import { execute, isAvailable, parseOpenCodeOutput } from './opencode.js'

const posix = process.platform !== 'win32'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task', agent: 'developer', prompt: 'Fix the bug in "src/a.ts"', files: [], timeout: '5m',
    depends_on: [], description: 'test task', max_retries: 0, ...overrides,
  }
}

/**
 * `opencode run --format json` stdout for a two-step run (a tool call, then
 * the answer), in the envelope `run` prints around each part. `step_finish`
 * tokens are per step: `input` excludes the cache, `output` excludes reasoning.
 */
const STREAM = [
  '{"type":"step_start","timestamp":1759490000123,"sessionID":"ses_6b1f","part":{"id":"prt_9a0","sessionID":"ses_6b1f","messageID":"msg_9a0","type":"step-start","snapshot":"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}}',
  '{"type":"text","timestamp":1759490001456,"sessionID":"ses_6b1f","part":{"id":"prt_9a1","sessionID":"ses_6b1f","messageID":"msg_9a0","type":"text","text":"Listing files first.","time":{"start":1759490001000,"end":1759490001450}}}',
  '{"type":"tool_use","timestamp":1759490002789,"sessionID":"ses_6b1f","part":{"id":"prt_9a2","sessionID":"ses_6b1f","messageID":"msg_9a0","type":"tool","callID":"call_abc","tool":"bash","state":{"status":"completed","input":{"command":"ls","description":"List files"},"output":"README.md\\nsrc\\n","title":"ls","metadata":{},"time":{"start":1759490002000,"end":1759490002700}}}}',
  '{"type":"step_finish","timestamp":1759490002800,"sessionID":"ses_6b1f","part":{"id":"prt_9a3","sessionID":"ses_6b1f","messageID":"msg_9a0","type":"step-finish","reason":"tool-calls","cost":0.0123,"tokens":{"total":12000,"input":1500,"output":200,"reasoning":0,"cache":{"read":10300,"write":0}}}}',
  '{"type":"step_start","timestamp":1759490003000,"sessionID":"ses_6b1f","part":{"id":"prt_9b0","sessionID":"ses_6b1f","messageID":"msg_9b0","type":"step-start"}}',
  '{"type":"text","timestamp":1759490004000,"sessionID":"ses_6b1f","part":{"id":"prt_9b1","sessionID":"ses_6b1f","messageID":"msg_9b0","type":"text","text":"Fixed the off-by-one in src/a.ts.","time":{"start":1759490003500,"end":1759490003990}}}',
  '{"type":"step_finish","timestamp":1759490004100,"sessionID":"ses_6b1f","part":{"id":"prt_9b2","sessionID":"ses_6b1f","messageID":"msg_9b0","type":"step-finish","reason":"stop","cost":0.0045,"tokens":{"total":12500,"input":300,"output":150,"reasoning":50,"cache":{"read":11800,"write":200}}}}',
].join('\n')

describe('parseOpenCodeOutput', () => {
  it('sums the steps and takes the last step\'s text as the answer', () => {
    const parsed = parseOpenCodeOutput(STREAM)
    expect(parsed.text).toBe('Fixed the off-by-one in src/a.ts.')
    expect(parsed.usage).toEqual({
      prompt_tokens: 1500 + 10300 + 0 + 300 + 11800 + 200,
      completion_tokens: 200 + 0 + 150 + 50,
      total_tokens: 1500 + 10300 + 300 + 11800 + 200 + 200 + 150 + 50,
      cache_read_tokens: 10300 + 11800,
      cache_write_tokens: 200,
    })
    expect(parsed.costUsd).toBeCloseTo(0.0168, 10)
    expect(parsed.errors).toEqual([])
  })

  it('treats a zero cost as unknown: OpenCode reports 0 when it has no price', () => {
    const free = STREAM.replace('"cost":0.0123', '"cost":0').replace('"cost":0.0045', '"cost":0')
    expect(parseOpenCodeOutput(free).costUsd).toBeUndefined()
  })

  it('collects error events', () => {
    const err = '{"type":"error","timestamp":1759490003000,"sessionID":"ses_6b1f","error":{"name":"APIError","data":{"message":"Unauthorized","statusCode":401,"isRetryable":false}}}'
    expect(parseOpenCodeOutput(err).errors).toEqual(['Unauthorized'])
  })
})

describe.skipIf(!posix)('opencode adapter — against a stub `opencode`', () => {
  let stub: StubCli

  beforeEach(() => {
    stub = installStubCli('opencode')
    stub.respond(STREAM)
  })
  afterEach(() => stub.restore())

  it('is available only when `opencode` is on PATH', async () => {
    expect(await isAvailable()).toBe(true)
    stub.restore()
    stub = installStubCli()
    expect(await isAvailable()).toBe(false)
  })

  it('sends the message on stdin, where it is not re-quoted, and runs in the task directory', async () => {
    const task = makeTask()
    const result = await execute(task, { cwd: stub.work })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Fixed the off-by-one in src/a.ts.')
    expect(result.costUsd).toBeCloseTo(0.0168, 10)
    expect(stub.stdin()).toBe(task.prompt)
    expect(stub.cwd()).toBe(stub.work)
    expect(stub.argv()).toEqual(['run', '--format', 'json'])
  })

  it('passes --model only when one is set', async () => {
    await execute(makeTask(), { cwd: stub.work, model: 'anthropic/claude-sonnet-4-5' })
    expect(stub.argv()).toEqual(['run', '--format', 'json', '--model', 'anthropic/claude-sonnet-4-5'])
  })

  it('denies edits and commands for a read-only run, keeping the user\'s own rules', async () => {
    // Record the variable the stub sees.
    const script = join(stub.bin, 'opencode')
    writeFileSync(script, readFileSync(script, 'utf8').replace('pwd > "$log/cwd"', 'pwd > "$log/cwd"; printf %s "$OPENCODE_PERMISSION" > "$log/perm"'))
    chmodSync(script, 0o755)
    process.env.OPENCODE_PERMISSION = '{"webfetch":"deny"}'
    try {
      await execute(makeTask(), { cwd: stub.work, permissionMode: 'plan' })
    } finally {
      delete process.env.OPENCODE_PERMISSION
    }
    expect(JSON.parse(readFileSync(join(stub.log, 'perm'), 'utf8'))).toEqual({ webfetch: 'deny', edit: 'deny', bash: 'deny' })
  })

  it('approves everything only for bypassPermissions', async () => {
    await execute(makeTask(), { cwd: stub.work, permissionMode: 'bypassPermissions' })
    expect(stub.argv()).toContain('--auto')
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).not.toContain('--auto')
  })

  it('fails on an error event even when the exit code is 0', async () => {
    stub.respond('{"type":"error","timestamp":1,"sessionID":"s","error":{"name":"APIError","data":{"message":"Unauthorized"}}}\n')
    const result = await execute(makeTask(), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Unauthorized')
  })

  it('times out with success false', async () => {
    process.env.STUB_SLEEP = '30'
    const result = await execute(makeTask({ timeout: '300ms' }), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result._timedOut).toBe(true)
  })
})
