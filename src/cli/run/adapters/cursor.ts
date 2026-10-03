import { realpathSync } from 'node:fs'
import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../convoy/spec-types.js'
import { resolveCommand } from '../platform.js'
import { cursorPermissionArgs } from './permission-modes.js'
import { runAgent, stopTask, promptOf, interruptedMessage, OUTPUT_LIMIT } from './agent-process.js'

/**
 * Cursor Agent CLI, run headless: `cursor-agent -p --output-format json`.
 *
 * With `-p` and no prompt argument the agent reads its prompt from stdin.
 * The JSON result has no cost and does not name the model; recent releases add
 * a `usage` object, which is read when it is there.
 */

export const name = 'cursor'

export function supportsSessionContinuity(): boolean { return false }

/**
 * The Cursor Agent command on PATH.
 *
 * Cursor's installer puts both `agent` and `cursor-agent` on PATH, and its
 * docs now lead with `agent`. `agent` is a name any tool could have, so it was
 * mistaken for Cursor: `cursor-agent` is preferred, and a lone `agent` counts
 * only when it resolves into Cursor's own install
 * (`~/.local/share/cursor-agent/…`, `%LOCALAPPDATA%\cursor-agent\agent.cmd`).
 */
export function cursorCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  if (resolveCommand('cursor-agent', env)) return 'cursor-agent'
  const agent = resolveCommand('agent', env)
  if (!agent) return null
  let real = agent
  try {
    real = realpathSync(agent)
  } catch { /* keep the PATH entry */ }
  return /cursor/i.test(real) ? 'agent' : null
}

export async function isAvailable(): Promise<boolean> {
  return cursorCommand() !== null
}

export interface ParsedCursor {
  text?: string
  isError?: boolean
  usage?: TokenUsage
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Read `cursor-agent -p --output-format json` output: one `result` object.
 * Its `usage.inputTokens` excludes the cache reads and writes, which are added
 * to `prompt_tokens` and also kept apart.
 */
export function parseCursorOutput(stdout: string): ParsedCursor {
  let obj: Record<string, unknown> | null = null
  try {
    obj = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    // stream-json, or noise before the result: take the last result line.
    for (const line of stdout.split('\n').reverse()) {
      if (!line.trim().startsWith('{')) continue
      try {
        const candidate = JSON.parse(line) as Record<string, unknown>
        if (candidate.type === 'result') {
          obj = candidate
          break
        }
      } catch { /* not JSON */ }
    }
  }
  if (!obj || typeof obj !== 'object') return {}
  const parsed: ParsedCursor = {}
  if (typeof obj.result === 'string') parsed.text = obj.result
  if (obj.is_error === true) parsed.isError = true
  const u = obj.usage as Record<string, unknown> | undefined
  if (u && typeof u === 'object') {
    const input = num(u.inputTokens)
    const output = num(u.outputTokens)
    if (input !== undefined || output !== undefined) {
      const cacheRead = num(u.cacheReadTokens)
      const cacheWrite = num(u.cacheWriteTokens)
      const prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      parsed.usage = {
        prompt_tokens: prompt,
        completion_tokens: output ?? 0,
        total_tokens: prompt + (output ?? 0),
        ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
      }
    }
  }
  return parsed
}

export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const command = cursorCommand() ?? 'cursor-agent'
  const args = ['-p', '--output-format', 'json', ...cursorPermissionArgs(options.permissionMode)]
  if (options.model) args.push('--model', options.model)

  const exit = await runAgent(task, {
    command,
    args,
    input: promptOf(task),
    cwd: options.cwd ?? process.cwd(),
    verbose: options.verbose,
  })

  const parsed = parseCursorOutput(exit.stdout)
  const interrupted = interruptedMessage(command, task, exit)
  const success = !interrupted && exit.code === 0 && !parsed.isError
  // On failure Cursor prints no JSON, only a message on stderr.
  const output = success
    ? parsed.text ?? exit.stdout
    : [interrupted, parsed.text, exit.stderr.trim() || exit.stdout.trim()].filter(Boolean).join('\n')
  return {
    success,
    output: output.slice(0, OUTPUT_LIMIT),
    exitCode: exit.code,
    ...(exit.timedOut ? { _timedOut: true } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  }
}

export function kill(task: Task): void {
  stopTask(task)
}
