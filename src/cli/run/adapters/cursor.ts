import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../types.js'

/** Adapter name */
export const name = 'cursor'

export function supportsSessionContinuity(): boolean { return false }
/**
 * Check if the Cursor CLI (`agent`) is available on the system PATH.
 */
export async function isAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['agent'], { stdio: 'pipe' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

/**
 * Execute a task by invoking the Cursor CLI in non-interactive print mode.
 */
export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  let prompt = `You are a ${task.agent}. ${task.prompt}`

  if (task.files && task.files.length > 0) {
    prompt += `\n\nOnly modify files under: ${task.files.join(', ')}`
  }

  const args = [
    '-p',
    prompt,
    '--force',
    '--output-format',
    'json',
  ]

  const cwd = options?.cwd ?? process.cwd()
  const mcpJsonPath = join(cwd, 'mcp.json')
  let wroteJson = false

  if (options.mcpServers?.length) {
    const mcpJson: Record<string, Record<string, unknown>> = {}
    for (const server of options.mcpServers) {
      const entry: Record<string, unknown> = {}
      if (server.command) entry.command = server.command
      if (server.args) entry.args = server.args
      if (server.url) entry.url = server.url
      if (server.config) Object.assign(entry, server.config)
      mcpJson[server.name] = entry
    }
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: mcpJson }, null, 2), 'utf8')
    args.push('--mcp-config', mcpJsonPath)
    wroteJson = true
  }

  if (options.mcp_approve_all) {
    args.push('--approve-mcps')
  }

  try {
  return await new Promise<ExecuteResult>((resolve) => {
    const proc = spawn('agent', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (options.verbose) {
        process.stdout.write(chunk)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (options.verbose) {
        process.stderr.write(chunk)
      }
    })

    proc.on('close', (code) => {
      let textOutput = [stdout, stderr].filter(Boolean).join('\n')
      let usage: TokenUsage | undefined
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>

        // Extract the actual AI text response from the JSON envelope
        const result = parsed.result as string | undefined
        if (typeof result === 'string') {
          textOutput = result
        }

        const u = parsed?.usage as Record<string, number> | undefined
        if (u) {
          const promptTokens = (u.input_tokens ?? u.prompt_tokens) as number | undefined
          const completionTokens = (u.output_tokens ?? u.completion_tokens) as number | undefined
          const total = ((promptTokens ?? 0) + (completionTokens ?? 0)) || undefined
          usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total }
        }
      } catch { /* not JSON or no usage — graceful degradation */ }
      resolve({
        success: code === 0,
        output: textOutput.slice(0, 500_000),
        exitCode: code ?? -1,
        usage,
      })
    })

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: `Failed to spawn cursor agent CLI: ${err.message}`,
        exitCode: -1,
      })
    })

    // Store process ref for potential timeout kill
    task._process = proc
  })
  } finally {
    if (wroteJson) {
      try { unlinkSync(mcpJsonPath) } catch { /* ignore */ }
    }
  }
}

/**
 * Kill the process associated with a task (used by timeout enforcement).
 */
export function kill(task: Task): void {
  if (task._process && !task._process.killed) {
    task._process.kill('SIGTERM')
    setTimeout(() => {
      if (task._process && !task._process.killed) {
        task._process.kill('SIGKILL')
      }
    }, 5000)
  }
}
