import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../convoy/spec-types.js'
import { commandExists } from '../platform.js'
import { opencodePermission } from './permission-modes.js'
import { runAgent, stopTask, promptOf, interruptedMessage, OUTPUT_LIMIT } from './agent-process.js'

/**
 * OpenCode, run headless: `opencode run --format json`.
 *
 * With no message argument `opencode run` reads the message from stdin. That
 * is also the only safe way to pass it: a message given as arguments is
 * re-joined with quotes added around any that contain a space, so the agent
 * received `"Fix the bug"`, quotes and all. Each `step_finish` event carries
 * that step's tokens and cost, which are summed. OpenCode prices the step
 * itself from its model table — that figure is what is recorded. The stream
 * does not name the model.
 */

export const name = 'opencode'

export function supportsSessionContinuity(): boolean { return false }

export async function isAvailable(): Promise<boolean> {
  return commandExists('opencode')
}

export interface ParsedOpenCode {
  /** The text of the last step that produced any: the agent's final answer. */
  text?: string
  usage?: TokenUsage
  costUsd?: number
  errors: string[]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Read `opencode run --format json` output.
 *
 * Step tokens are per step, so they add up. OpenCode's `input` excludes the
 * cache reads and writes, and its `output` excludes reasoning; both are added
 * back so `prompt_tokens` and `completion_tokens` count everything.
 */
export function parseOpenCodeOutput(stdout: string): ParsedOpenCode {
  const parsed: ParsedOpenCode = { errors: [] }
  let stepText: string[] = []
  let lastText: string[] = []
  let prompt = 0
  let completion = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let sawTokens = false
  let sawCost = false

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const part = ev.part as Record<string, unknown> | undefined
    switch (ev.type) {
      case 'step_start':
        stepText = []
        break
      case 'text':
        if (typeof part?.text === 'string' && part.text) stepText.push(part.text)
        break
      case 'step_finish': {
        if (stepText.length) lastText = stepText
        stepText = []
        const tokens = part?.tokens as Record<string, unknown> | undefined
        if (tokens) {
          const cache = (tokens.cache ?? {}) as Record<string, unknown>
          const read = num(cache.read) ?? 0
          const write = num(cache.write) ?? 0
          prompt += (num(tokens.input) ?? 0) + read + write
          completion += (num(tokens.output) ?? 0) + (num(tokens.reasoning) ?? 0)
          cacheRead += read
          cacheWrite += write
          sawTokens = true
        }
        const c = num(part?.cost)
        if (c !== undefined) {
          cost += c
          sawCost = true
        }
        break
      }
      case 'error': {
        const err = ev.error as Record<string, unknown> | undefined
        const data = err?.data as Record<string, unknown> | undefined
        const message = data?.message ?? err?.message ?? err?.name
        if (typeof message === 'string') parsed.errors.push(message)
        break
      }
    }
  }
  if (stepText.length) lastText = stepText
  if (lastText.length) parsed.text = lastText.join('\n')
  if (sawTokens) {
    parsed.usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    }
  }
  // OpenCode reports 0 when it has no price for the model; that is "unknown", not free.
  if (sawCost && cost > 0) parsed.costUsd = cost
  return parsed
}

/** OpenCode's permission JSON, merged over any the user already set in the environment. */
function permissionEnv(permission: Record<string, string>): Record<string, string> {
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(process.env.OPENCODE_PERMISSION ?? '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
  } catch { /* not JSON: OpenCode ignores it too */ }
  return { OPENCODE_PERMISSION: JSON.stringify({ ...existing, ...permission }) }
}

export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const permission = opencodePermission(options.permissionMode)
  const args = ['run', '--format', 'json', ...permission.args]
  if (options.model) args.push('--model', options.model) // provider/model

  const exit = await runAgent(task, {
    command: 'opencode',
    args,
    input: promptOf(task),
    cwd: options.cwd ?? process.cwd(),
    ...(permission.permission ? { env: permissionEnv(permission.permission) } : {}),
    verbose: options.verbose,
  })

  const parsed = parseOpenCodeOutput(exit.stdout)
  const interrupted = interruptedMessage('opencode', task, exit)
  // An `error` event is a session error or a rejected prompt: the run failed, whatever the exit code says.
  const success = !interrupted && exit.code === 0 && parsed.errors.length === 0
  const output = success
    ? parsed.text ?? exit.stdout
    : [interrupted, parsed.text, ...parsed.errors, exit.stderr.trim()].filter(Boolean).join('\n')
  return {
    success,
    output: output.slice(0, OUTPUT_LIMIT),
    exitCode: exit.code,
    ...(exit.timedOut ? { _timedOut: true } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
  }
}

export function kill(task: Task): void {
  stopTask(task)
}
