import type { Task, ExecuteOptions, ExecuteResult } from '../../convoy/spec-types.js'
import { commandExists } from '../platform.js'
import { copilotPermissionArgs } from './permission-modes.js'
import { runAgent, stopTask, promptOf, interruptedMessage, OUTPUT_LIMIT } from './agent-process.js'

/**
 * GitHub Copilot CLI, run headless: `copilot --output-format json`.
 *
 * This adapter used to prefer the Copilot SDK, which was a dependency of this
 * package. That made Copilot "available" on every machine, whether or not
 * anyone had installed or signed in to it, so it was detected ahead of the
 * runtime the user had actually configured. The SDK also worked in this
 * process's directory rather than the task's worktree, approved every tool
 * request whatever the permission mode said, and was handed MCP servers in a
 * shape it does not accept. It drives the same CLI anyway, so the CLI is used
 * directly:
 *
 * - With stdin and stdout not a terminal and no `-p`, Copilot runs one prompt
 *   read from stdin and exits.
 * - It works in, and is confined to, its working directory: the worktree.
 * - Tool rules come from the permission mode (`copilotPermissionArgs`);
 *   `--no-ask-user` removes the question tool a headless run cannot answer.
 * - `--output-format json` (Copilot CLI 1.0 or later) prints session events.
 *   They name the model and count output tokens per message. Input tokens and
 *   cost are not in that stream — Copilot bills in premium requests — so they
 *   are left unset.
 */

export const name = 'copilot'

export function supportsSessionContinuity(): boolean { return false }

/** Available when the `copilot` CLI is on PATH; nothing bundled counts. */
export async function isAvailable(): Promise<boolean> {
  return commandExists('copilot')
}

export interface ParsedCopilot {
  /** The last top-level assistant message with any text. */
  text?: string
  /** Output tokens, summed over every assistant message, sub-agents' included. */
  completionTokens?: number
  model?: string
  /** The exit code Copilot recorded in its final `result` event. */
  resultExitCode?: number
  errors: string[]
}

/** Read `copilot --output-format json` output: one session event per line, then a `result` line. */
export function parseCopilotOutput(stdout: string): ParsedCopilot {
  const parsed: ParsedCopilot = { errors: [] }
  let completion = 0
  let sawTokens = false
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const data = (ev.data ?? {}) as Record<string, unknown>
    switch (ev.type) {
      case 'session.start':
        if (typeof data.selectedModel === 'string' && !parsed.model) parsed.model = data.selectedModel
        break
      case 'session.tools_updated':
        // Sent whenever the toolset is rebuilt for a model, so the last one names the model in use.
        if (typeof data.model === 'string' && data.model) parsed.model = data.model
        break
      case 'assistant.message':
        if (typeof data.outputTokens === 'number') {
          completion += data.outputTokens
          sawTokens = true
        }
        if (typeof data.content === 'string' && data.content.trim() && !data.parentToolCallId) parsed.text = data.content
        break
      case 'session.error':
        if (typeof data.message === 'string') parsed.errors.push(data.message)
        break
      case 'result':
        if (typeof ev.exitCode === 'number') parsed.resultExitCode = ev.exitCode
        break
    }
  }
  if (sawTokens) parsed.completionTokens = completion
  return parsed
}

export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const args = ['--output-format', 'json', '--no-ask-user', '--no-auto-update']
  if (options.model) args.push('--model', options.model)
  args.push(...copilotPermissionArgs(options.permissionMode))

  const exit = await runAgent(task, {
    command: 'copilot',
    args,
    input: promptOf(task),
    cwd: options.cwd ?? process.cwd(),
    // In prompt mode Copilot loads the workspace's MCP config only from a folder
    // it already trusts, and a fresh worktree is not one. The project's config
    // is the one opencastle compiled; load it unless the user said otherwise.
    ...(process.env.GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP === undefined
      ? { env: { GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: 'true' } }
      : {}),
    verbose: options.verbose,
  })

  const parsed = parseCopilotOutput(exit.stdout)
  const interrupted = interruptedMessage('copilot', task, exit)
  const success = !interrupted && exit.code === 0 && (parsed.resultExitCode ?? 0) === 0
  const output = success
    ? parsed.text ?? exit.stdout
    : [interrupted, parsed.text, ...parsed.errors, exit.stderr.trim()].filter(Boolean).join('\n')
  return {
    success,
    output: output.slice(0, OUTPUT_LIMIT),
    exitCode: exit.code,
    ...(exit.timedOut ? { _timedOut: true } : {}),
    ...(parsed.completionTokens !== undefined ? { usage: { completion_tokens: parsed.completionTokens } } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
  }
}

export function kill(task: Task): void {
  stopTask(task)
}
