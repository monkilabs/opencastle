import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../convoy/spec-types.js'
import { commandExists } from '../platform.js'
import { codexSandboxFor } from './permission-modes.js'
import { runAgent, stopTask, promptOf, interruptedMessage, OUTPUT_LIMIT } from './agent-process.js'

/**
 * OpenAI Codex CLI, run headless: `codex exec --json … -`.
 *
 * `-` as the prompt makes `codex exec` read it from stdin. `--json` turns
 * stdout into an event stream whose `turn.completed` events carry the token
 * counts; the final message is written to the `-o` file. Codex reports no
 * cost and does not name its model in that stream, so neither is recorded.
 */

export const name = 'codex'

export function supportsSessionContinuity(): boolean { return false }

export async function isAvailable(): Promise<boolean> {
  return commandExists('codex')
}

export interface ParsedCodex {
  /** The last `agent_message`, for when the `-o` file was not written. */
  text?: string
  usage?: TokenUsage
  /** Messages from `turn.failed` and `error` events. */
  errors: string[]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Codex counts `input_tokens` with its cached share included, so it maps to
 * `prompt_tokens` as it is, and `cached_input_tokens` is the cache-read part.
 */
function toUsage(u: Record<string, unknown>): TokenUsage | undefined {
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  if (input === undefined && output === undefined) return undefined
  const cached = num(u.cached_input_tokens)
  const cacheWrite = num(u.cache_write_input_tokens)
  return {
    prompt_tokens: input ?? 0,
    completion_tokens: output ?? 0,
    total_tokens: num(u.total_tokens) ?? (input ?? 0) + (output ?? 0),
    ...(cached !== undefined ? { cache_read_tokens: cached } : {}),
    ...(cacheWrite ? { cache_write_tokens: cacheWrite } : {}),
  }
}

/**
 * Read `codex exec --json` output.
 *
 * The usage on `turn.completed` is the thread's running total, so the last
 * one is the run's. Older releases printed `token_count` events instead
 * (`msg.info.total_token_usage`, also a running total); those are read the
 * same way.
 */
export function parseCodexOutput(stdout: string): ParsedCodex {
  const parsed: ParsedCodex = { errors: [] }
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const msg = ev.msg as Record<string, unknown> | undefined
    switch (ev.type ?? msg?.type) {
      case 'turn.completed': {
        const usage = ev.usage && typeof ev.usage === 'object' ? toUsage(ev.usage as Record<string, unknown>) : undefined
        if (usage) parsed.usage = usage
        break
      }
      case 'token_count': {
        const info = msg?.info as Record<string, unknown> | undefined
        const total = (info?.total_token_usage ?? msg) as Record<string, unknown> | undefined
        const usage = total ? toUsage(total) : undefined
        if (usage) parsed.usage = usage
        break
      }
      case 'item.completed': {
        const item = ev.item as Record<string, unknown> | undefined
        if (item?.type === 'agent_message' && typeof item.text === 'string') parsed.text = item.text
        break
      }
      case 'turn.failed': {
        const message = (ev.error as Record<string, unknown> | undefined)?.message
        if (typeof message === 'string') parsed.errors.push(message)
        break
      }
      case 'error':
        if (typeof ev.message === 'string') parsed.errors.push(ev.message)
        break
    }
  }
  return parsed
}

export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const cwd = options.cwd ?? process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'opencastle-codex-'))
  const lastMessagePath = join(tempDir, 'last-message.txt')

  const args = [
    'exec',
    '--json',
    '-s', codexSandboxFor(options.permissionMode),
    '--color', 'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C', cwd,
    '-o', lastMessagePath,
  ]
  if (options.model) args.push('-m', options.model)
  // A config override, which every `codex exec` takes; the value is TOML, so
  // the string is quoted. No shell is involved, so the quotes reach codex.
  if (options.effort) args.push('-c', `model_reasoning_effort="${options.effort}"`)
  args.push('-') // the prompt, from stdin

  try {
    const exit = await runAgent(task, { command: 'codex', args, input: promptOf(task), cwd, verbose: options.verbose })
    const parsed = parseCodexOutput(exit.stdout)
    const lastMessage = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8').trimEnd() : ''
    const interrupted = interruptedMessage('codex', task, exit)
    const success = !interrupted && exit.code === 0
    const message = lastMessage || parsed.text || ''
    const output = success
      ? message || exit.stderr.trim()
      : [interrupted, message, ...parsed.errors, exit.stderr.trim()].filter(Boolean).join('\n')
    return {
      success,
      output: output.slice(0, OUTPUT_LIMIT),
      exitCode: exit.code,
      ...(exit.timedOut ? { _timedOut: true } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export function kill(task: Task): void {
  stopTask(task)
}
