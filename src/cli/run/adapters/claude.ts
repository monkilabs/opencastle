import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../convoy/spec-types.js'
import { commandExists } from '../platform.js'
import { runAgent, stopTask, promptOf, interruptedMessage, OUTPUT_LIMIT } from './agent-process.js'

/**
 * Claude Code, run headless: `claude -p --output-format json`.
 *
 * The prompt goes on stdin — `claude -p` reads it from there when no prompt
 * argument is given — so its size is not bounded by the command line.
 * The JSON result carries the runtime's own token counts, its cost in USD and,
 * in `modelUsage`, the model that did the work; all three are recorded as
 * reported, never estimated.
 */

export const name = 'claude'

export function supportsSessionContinuity(): boolean { return false }

/**
 * Claude Code's model aliases, which always name the current model of each
 * family. A convoy worker is headless, so without one it runs on the account's
 * default — usually the largest model — for a docs edit as much as for a
 * security review.
 */
export const tierModels = { premium: 'opus', standard: 'sonnet', economy: 'haiku' } as const

export async function isAvailable(): Promise<boolean> {
  return commandExists('claude')
}

export interface ParsedClaude {
  text?: string
  isError?: boolean
  /** The `errors` of an error result. */
  errors?: string[]
  usage?: TokenUsage
  costUsd?: number
  model?: string
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The final `result` object: the whole of stdout for `json`, the last `result` line for `stream-json`. */
function resultObject(stdout: string): Record<string, unknown> | null {
  try {
    const whole = JSON.parse(stdout) as unknown
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole as Record<string, unknown>
  } catch { /* not a single object */ }
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type === 'result') return obj
    } catch { /* not JSON */ }
  }
  return null
}

function toUsage(input?: number, output?: number, cacheRead?: number, cacheWrite?: number): TokenUsage | undefined {
  if (input === undefined && output === undefined) return undefined
  const prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    prompt_tokens: prompt,
    completion_tokens: output ?? 0,
    total_tokens: prompt + (output ?? 0),
    ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
  }
}

/**
 * Read what Claude Code reported.
 *
 * Tokens come from `modelUsage`, summed over its models, when it is there:
 * Claude Code documents the top-level `usage` as the main agent loop only,
 * while `total_cost_usd` also covers subagents, and the two should describe
 * the same work. `usage` is the fallback. Claude Code counts input tokens
 * apart from cache reads and writes; `prompt_tokens` here counts every input
 * token, so the cache figures are added in and also kept apart. The model is
 * the `modelUsage` entry that cost the most — a session can call a small model
 * for housekeeping beside the one doing the work.
 */
export function parseClaudeOutput(stdout: string): ParsedClaude {
  const obj = resultObject(stdout)
  if (!obj) return {}
  const parsed: ParsedClaude = {}
  if (typeof obj.result === 'string') parsed.text = obj.result
  if (obj.is_error === true) parsed.isError = true
  if (Array.isArray(obj.errors)) {
    const errors = obj.errors.filter((e): e is string => typeof e === 'string' && e.length > 0)
    if (errors.length) parsed.errors = errors
  }

  const models = obj.modelUsage as Record<string, Record<string, unknown>> | undefined
  const entries = models && typeof models === 'object' ? Object.entries(models).filter(([, m]) => m && typeof m === 'object') : []
  if (entries.length) {
    const sum = (key: string): number | undefined => {
      const values = entries.map(([, m]) => num(m[key])).filter((v): v is number => v !== undefined)
      return values.length ? values.reduce((a, b) => a + b, 0) : undefined
    }
    parsed.usage = toUsage(sum('inputTokens'), sum('outputTokens'), sum('cacheReadInputTokens'), sum('cacheCreationInputTokens'))
    let best: { name: string; cost: number; out: number } | undefined
    for (const [model, m] of entries) {
      const c = num(m.costUSD) ?? 0
      const o = num(m.outputTokens) ?? 0
      if (!best || c > best.cost || (c === best.cost && o > best.out)) best = { name: model, cost: c, out: o }
    }
    if (best) parsed.model = best.name
  }
  const u = obj.usage as Record<string, unknown> | undefined
  if (!parsed.usage && u && typeof u === 'object') {
    parsed.usage = toUsage(num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens))
  }
  if (!parsed.usage) delete parsed.usage

  const cost = num(obj.total_cost_usd)
  if (cost !== undefined) parsed.costUsd = cost
  return parsed
}

/**
 * How a permission mode is spelled for `claude -p`.
 *
 * Read-only (`plan`) is not passed as Claude Code's plan mode: plan mode
 * replaces a small model with a larger one, so a review asked to run on
 * `haiku` ran on `sonnet` at four times the cost. Default mode with the edit
 * tools taken away is just as read-only — a headless session refuses whatever
 * it would have asked about — and keeps the model it was given.
 */
export function claudePermissionArgs(mode: ExecuteOptions['permissionMode']): string[] {
  if (mode === 'plan') return ['--permission-mode', 'default', '--disallowedTools', 'Edit,Write,NotebookEdit']
  return ['--permission-mode', mode ?? 'acceptEdits']
}

export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  // A worker has no terminal, so a permission prompt is a refusal it cannot
  // answer: without a mode it tries to write, is denied, and exits 0 having
  // written nothing. `acceptEdits` is the least that lets it do the work.
  const args = ['-p', '--output-format', 'json', ...claudePermissionArgs(options.permissionMode)]
  if (options.model) args.push('--model', options.model)
  // No --max-turns: the task's timeout bounds a session, and a turn cap only
  // cut long tasks short with a result that looked like an ordinary failure.

  const exit = await runAgent(task, {
    command: 'claude',
    args,
    input: promptOf(task),
    cwd: options.cwd ?? process.cwd(),
    verbose: options.verbose,
  })

  const parsed = parseClaudeOutput(exit.stdout)
  const interrupted = interruptedMessage('claude', task, exit)
  const success = !interrupted && exit.code === 0 && !parsed.isError
  const raw = [exit.stdout, exit.stderr].filter(Boolean).join('\n')
  const output = success
    ? parsed.text ?? raw
    : [interrupted, parsed.text, ...(parsed.errors ?? []), parsed.text || parsed.errors ? exit.stderr : raw].filter(Boolean).join('\n')
  return {
    success,
    output: output.slice(0, OUTPUT_LIMIT),
    exitCode: exit.code,
    ...(exit.timedOut ? { _timedOut: true } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
  }
}

export function kill(task: Task): void {
  stopTask(task)
}
