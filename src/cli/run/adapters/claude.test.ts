import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../../convoy/spec-types.js'
import { installStubCli, type StubCli } from './stub-cli.test-helper.js'
import { execute, isAvailable, kill, parseClaudeOutput } from './claude.js'

const posix = process.platform !== 'win32'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    agent: 'developer',
    prompt: '## Shared context\n\nDo something',
    files: ['src/a.ts'],
    timeout: '5m',
    depends_on: [],
    description: 'test task',
    max_retries: 0,
    ...overrides,
  }
}

/**
 * `claude -p --output-format json` from Claude Code 2.x, for a session in
 * which a small model did housekeeping beside the one doing the work. The
 * per-model costs add up to `total_cost_usd`; `usage` is the main model's.
 */
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 15312,
  duration_api_ms: 14873,
  num_turns: 4,
  result: 'Added a `slugify` helper in src/util/slug.ts and a test.',
  stop_reason: 'end_turn',
  session_id: '6f3b1c2e-8a4d-4f0e-9b7a-2c1d5e8f9a01',
  total_cost_usd: 0.0754636,
  usage: {
    input_tokens: 17,
    cache_creation_input_tokens: 11268,
    cache_read_input_tokens: 52842,
    output_tokens: 1032,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 11268 },
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': {
      inputTokens: 1520, outputTokens: 61, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0.001825, contextWindow: 200000, maxOutputTokens: 64000,
    },
    'claude-sonnet-4-5-20250929': {
      inputTokens: 17, outputTokens: 1032, cacheReadInputTokens: 52842, cacheCreationInputTokens: 11268,
      webSearchRequests: 0, costUSD: 0.0736386, contextWindow: 200000, maxOutputTokens: 64000,
    },
  },
  permission_denials: [],
  uuid: 'd1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6',
})

describe('parseClaudeOutput', () => {
  it('records the tokens, cost and model Claude Code reported', () => {
    const parsed = parseClaudeOutput(RESULT)
    expect(parsed.text).toBe('Added a `slugify` helper in src/util/slug.ts and a test.')
    // Summed over modelUsage, which covers every model the cost covers; input
    // tokens exclude the cache, and prompt_tokens counts every input token.
    expect(parsed.usage).toEqual({
      prompt_tokens: 1520 + 17 + 52842 + 11268,
      completion_tokens: 61 + 1032,
      total_tokens: 1520 + 17 + 52842 + 11268 + 61 + 1032,
      cache_read_tokens: 52842,
      cache_write_tokens: 11268,
    })
    expect(parsed.costUsd).toBe(0.0754636)
    // The model that did the work, not the one that did housekeeping.
    expect(parsed.model).toBe('claude-sonnet-4-5-20250929')
    expect(parsed.isError).toBeUndefined()
  })

  it('falls back to the top-level usage when there is no modelUsage', () => {
    const parsed = parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01,
      usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 40 },
    }))
    expect(parsed.usage).toEqual({
      prompt_tokens: 240, completion_tokens: 40, total_tokens: 280, cache_read_tokens: 200, cache_write_tokens: 30,
    })
    expect(parsed.model).toBeUndefined()
  })

  it('reads the result line of a stream-json transcript', () => {
    const stream = [
      '{"type":"system","subtype":"init","model":"claude-sonnet-4-5-20250929","session_id":"s"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
      RESULT,
    ].join('\n')
    expect(parseClaudeOutput(stream).costUsd).toBe(0.0754636)
  })

  it('marks an error result even when there is no result text, and keeps its errors', () => {
    const parsed = parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.002,
      usage: { input_tokens: 5, output_tokens: 0 }, errors: ['API Error: 529 overloaded'],
    }))
    expect(parsed.isError).toBe(true)
    expect(parsed.text).toBeUndefined()
    expect(parsed.errors).toEqual(['API Error: 529 overloaded'])
    expect(parsed.costUsd).toBe(0.002)
  })

  it('reports nothing it was not given: no estimate', () => {
    expect(parseClaudeOutput('plain text, not JSON')).toEqual({})
    expect(parseClaudeOutput(JSON.stringify({ type: 'result', result: 'ok' }))).toEqual({ text: 'ok' })
  })
})

describe.skipIf(!posix)('claude adapter — against a stub `claude`', () => {
  let stub: StubCli

  beforeEach(() => {
    stub = installStubCli('claude')
    stub.respond(RESULT)
  })
  afterEach(() => stub.restore())

  it('is available only when `claude` is on PATH', async () => {
    expect(await isAvailable()).toBe(true)
    stub.restore()
    stub = installStubCli()
    expect(await isAvailable()).toBe(false)
  })

  it('sends the prompt verbatim on stdin and runs in the task directory', async () => {
    const task = makeTask()
    const result = await execute(task, { cwd: stub.work })
    expect(result.success).toBe(true)
    expect(stub.stdin()).toBe(task.prompt)
    expect(stub.cwd()).toBe(stub.work)
    expect(stub.argv()).not.toContain(task.prompt)
    expect(stub.argv().slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
  })

  it('returns what the runtime reported', async () => {
    const result = await execute(makeTask(), { cwd: stub.work })
    expect(result.output).toBe('Added a `slugify` helper in src/util/slug.ts and a test.')
    expect(result.costUsd).toBe(0.0754636)
    expect(result.model).toBe('claude-sonnet-4-5-20250929')
    expect(result.usage?.cache_read_tokens).toBe(52842)
  })

  it('passes --model only when one is set, so the runtime default applies otherwise', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).not.toContain('--model')
    await execute(makeTask(), { cwd: stub.work, model: 'opus' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus')
  })

  /**
   * A worker with no terminal cannot answer a permission prompt, so a spawn
   * without a permission mode is a worker that tries Write, is refused, and
   * exits 0 having written nothing.
   */
  it('lets the worker edit by default and passes any other mode through', async () => {
    const modeOf = () => { const a = stub.argv(); return a[a.indexOf('--permission-mode') + 1] }
    await execute(makeTask(), { cwd: stub.work })
    expect(modeOf()).toBe('acceptEdits')
    await execute(makeTask(), { cwd: stub.work, permissionMode: 'bypassPermissions' })
    expect(modeOf()).toBe('bypassPermissions')
  })

  it('runs read-only as default mode with the edit tools denied, keeping the model it was given', async () => {
    // Plan mode swaps a small model for a larger one: a review asked to run on
    // haiku ran on sonnet, at four times the cost.
    await execute(makeTask(), { cwd: stub.work, permissionMode: 'plan', model: 'haiku' })
    const argv = stub.argv()
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default')
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit')
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku')
    expect(argv).not.toContain('plan')
  })

  it('does not cap turns: the timeout bounds a session', async () => {
    await execute(makeTask(), { cwd: stub.work })
    expect(stub.argv()).not.toContain('--max-turns')
  })

  it('never writes or deletes an mcp.json, and ignores mcpServers', async () => {
    // The adapter used to write <cwd>/mcp.json and unlink it afterwards,
    // deleting a committed one and dropping its env.
    const committed = '{"mcpServers":{"db":{"command":"db-mcp","env":{"DB_URL":"x"}}}}'
    writeFileSync(join(stub.work, 'mcp.json'), committed)
    await execute(makeTask(), {
      cwd: stub.work,
      mcpServers: [{ name: 'other', type: 'stdio', command: 'node', args: ['s.js'] }],
      mcp_approve_all: true,
    })
    expect(readFileSync(join(stub.work, 'mcp.json'), 'utf8')).toBe(committed)
    expect(readdirSync(stub.work)).toEqual(['mcp.json'])
    expect(stub.argv()).not.toContain('--mcp-config')
    expect(stub.argv()).not.toContain('--approve-mcps')
  })

  it('fails on a non-zero exit, and on an error result even with exit 0', async () => {
    process.env.STUB_EXIT = '1'
    stub.respond('', 'Error: not logged in')
    let result = await execute(makeTask(), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result.output).toContain('not logged in')

    process.env.STUB_EXIT = '0'
    stub.respond(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1 }), '')
    result = await execute(makeTask(), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result.costUsd).toBe(1)
  })

  it('times out with success false', async () => {
    process.env.STUB_SLEEP = '30'
    const result = await execute(makeTask({ timeout: '300ms' }), { cwd: stub.work })
    expect(result.success).toBe(false)
    expect(result._timedOut).toBe(true)
    expect(result.output).toContain('timed out')
  })

  it('is stopped by kill(task) and then reports failure, whatever the exit code', async () => {
    process.env.STUB_SLEEP = '30'
    const task = makeTask()
    const running = execute(task, { cwd: stub.work })
    await new Promise((r) => setTimeout(r, 300))
    kill({ ...task })
    const result = await running
    expect(result.success).toBe(false)
    expect(result.output).toContain('stopped')
    expect(existsSync(join(stub.work, 'mcp.json'))).toBe(false)
  })
})
