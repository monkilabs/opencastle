
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CopilotClient as CopilotClientType, CopilotSession, PermissionHandler, SessionConfig } from '@github/copilot-sdk'
import { parseTimeout } from '../schema.js'
import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../types.js'

// Adapter name
export const name = 'copilot'

export function supportsSessionContinuity(): boolean { return true }
// --- Unified adapter: SDK first, fallback to CLI ---
let mode: 'sdk' | 'cli' | null = null

// SDK check
async function sdkAvailable(): Promise<boolean> {
  try {
    await import('@github/copilot-sdk')
    return true
  } catch {
    return false
  }
}

// CLI check
async function cliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['copilot'], { stdio: 'pipe' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

export async function isAvailable(): Promise<boolean> {
  if (await sdkAvailable()) {
    mode = 'sdk'
    return true
  }
  if (await cliAvailable()) {
    mode = 'cli'
    return true
  }
  return false
}

// --- SDK implementation (existing logic) ---
let clientPromise: Promise<CopilotClientType> | null = null
let cachedApproveAll: PermissionHandler | null = null
const activeSessions = new Map<string, CopilotSession>()

async function getClient(): Promise<CopilotClientType> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { CopilotClient, approveAll } = await import('@github/copilot-sdk')
      cachedApproveAll = approveAll
      const client = new CopilotClient({
        autoStart: false,
        logLevel: 'error',
      })
      await client.start()
      return client
    })()
  }
  return clientPromise
}

async function executeViaSdk(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  // NOTE: The Copilot SDK CopilotClient is a shared singleton. Per-task cwd
  // isolation requires SDK support for per-session workingDirectory, which is
  // not yet available. When running in convoy mode with worktrees, prefer
  // subprocess-based adapters (cli mode) that support options.cwd natively.
  let prompt = `You are a ${task.agent}. ${task.prompt}`
  if (task.files && task.files.length > 0) {
    prompt += `\n\nOnly modify files under: ${task.files.join(', ')}`
  }
  const client = await getClient()
  const session = await client.createSession({
    onPermissionRequest: cachedApproveAll!,
    systemMessage: {
      content: [
        `You are a ${task.agent}.`,
        'Work autonomously without asking questions.',
        'Follow all instructions precisely.',
      ].join(' '),
    },
    infiniteSessions: { enabled: false },
    ...(options.verbose ? { streaming: true } : {}),
    // mcpServers is forward-compatible: field will be recognised by future SDK versions
    ...(options.mcpServers?.length ? { mcpServers: options.mcpServers } : {}),
  } as SessionConfig)
  activeSessions.set(task.id, session)
  if (options.verbose) {
    session.on('assistant.message_delta', (event: { data: { deltaContent: string } }) => {
      process.stdout.write(event.data.deltaContent)
    })
  }
  try {
    const timeoutMs = parseTimeout(task.timeout)
    const response = await session.sendAndWait({ prompt }, timeoutMs)
    const output = response?.data?.content ?? ''
    const rawUsage = (response?.data as Record<string, unknown> | undefined)?.usage ?? (response as Record<string, unknown> | undefined)?.usage
    const u = rawUsage as Record<string, number> | undefined
    const usageResult = u ? {
      prompt_tokens: u.prompt_tokens ?? u.promptTokens,
      completion_tokens: u.completion_tokens ?? u.completionTokens,
      total_tokens: u.total_tokens ?? u.totalTokens,
    } : undefined
    return {
      success: true,
      output: output.slice(0, 500_000),
      exitCode: 0,
      usage: usageResult,
    }
  } catch (err: unknown) {
    return {
      success: false,
      output: `Copilot SDK error: ${(err as Error).message}`,
      exitCode: 1,
    }
  } finally {
    activeSessions.delete(task.id)
    await session.destroy().catch(() => {})
  }
}

function killSdk(task: Task): void {
  const session = activeSessions.get(task.id)
  if (session) {
    session.abort().catch(() => {})
    session.destroy().catch(() => {})
    activeSessions.delete(task.id)
  }
}

// --- CLI implementation ---
async function executeViaCli(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  // CLI supports --output-format json and respects cwd
  let prompt = `You are a ${task.agent}. ${task.prompt}`
  if (task.files && task.files.length > 0) {
    prompt += `\n\nOnly modify files under: ${task.files.join(', ')}`
  }
  const args = [
    '-p',
    prompt,
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
    wroteJson = true
  }
  if (options.mcp_approve_all) {
    args.push('--approve-mcps')
  }
  try {
  return await new Promise<ExecuteResult>((resolve) => {
    const proc = spawn('copilot', args, {
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
      const output = [stdout, stderr].filter(Boolean).join('\n')
      let usage: TokenUsage | undefined
      try {
        const parsedJson = JSON.parse(stdout) as Record<string, unknown>
        const u = parsedJson?.usage as Record<string, number> | undefined
        if (u) {
          const promptTokens = (u.input_tokens ?? u.prompt_tokens) as number | undefined
          const completionTokens = (u.output_tokens ?? u.completion_tokens) as number | undefined
          const total = ((promptTokens ?? 0) + (completionTokens ?? 0)) || undefined
          usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total }
        }
      } catch { /* not JSON or no usage — graceful degradation */ }
      resolve({
        success: code === 0,
        output: output.slice(0, 500_000),
        exitCode: code ?? -1,
        usage,
      })
    })
    proc.on('error', (err) => {
      resolve({
        success: false,
        output: `Failed to spawn copilot: ${err.message}`,
        exitCode: -1,
      })
    })
    task._process = proc
  })
  } finally {
    if (wroteJson) {
      try { unlinkSync(mcpJsonPath) } catch { /* ignore */ }
    }
  }
}

function killCli(task: Task): void {
  if (task._process && !task._process.killed) {
    task._process.kill('SIGTERM')
    setTimeout(() => {
      if (task._process && !task._process.killed) {
        task._process.kill('SIGKILL')
      }
    }, 5000)
  }
}

// --- Unified interface ---
export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  if (!mode) await isAvailable()
  if (mode === 'sdk') return executeViaSdk(task, options)
  return executeViaCli(task, options)
}

export function kill(task: Task): void {
  if (mode === 'sdk') killSdk(task)
  else killCli(task)
}

export async function cleanup(): Promise<void> {
  if (clientPromise) {
    try {
      const client = await clientPromise
      await client.stop()
    } catch { /* ignore */ }
    clientPromise = null
  }
}
