import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parseTimeout } from '../schema.js'
import type { Task, ExecuteOptions, ExecuteResult, TokenUsage } from '../../types.js'

// Adapter name
export const name = 'claude'

export function supportsSessionContinuity(): boolean { return false }
// Module-level state for mode selection
let mode: 'sdk' | 'cli' | null = null

// SDK dynamic import check
async function sdkAvailable(): Promise<boolean> {
  try {
    await import('@anthropic-ai/agent-sdk')
    return true
  } catch {
    return false
  }
}

// CLI check
async function cliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['claude'], { stdio: 'pipe' })
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

// --- SDK implementation (from claude-sdk.ts) ---
// Local type stubs for @anthropic-ai/agent-sdk
interface AgentSession {
  on(event: string, handler: (...args: unknown[]) => void): void
  sendAndWait(msg: { prompt: string }, timeoutMs: number): Promise<unknown>
  abort(): Promise<void>
  destroy(): Promise<void>
}
interface SessionCreateOptions {
  onPermissionRequest?: unknown
  cwd?: string
  systemMessage?: { content: string }
  infiniteSessions?: { enabled: boolean }
  streaming?: boolean
}
interface ClaudeAgentClient {
  start(): Promise<void>
  createSession(options: SessionCreateOptions): Promise<AgentSession>
}
let clientPromise: Promise<ClaudeAgentClient> | null = null
let cachedApproveAll: unknown = null
const activeSessions = new Map<string, AgentSession>()

async function getClient(): Promise<ClaudeAgentClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const sdk = await import('@anthropic-ai/agent-sdk') as Record<string, unknown>
      const { AgentClient, approveAll } = sdk as {
        AgentClient: new (opts: { autoStart: boolean; logLevel: string }) => ClaudeAgentClient
        approveAll: unknown
      }
      cachedApproveAll = approveAll
      const client = new AgentClient({
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
  let prompt = `You are a ${task.agent}. ${task.prompt}`
  if (task.files && task.files.length > 0) {
    prompt += `\n\nOnly modify files under: ${task.files.join(', ')}`
  }
  const client = await getClient()
  const session = await client.createSession({
    onPermissionRequest: cachedApproveAll!,
    cwd: options.cwd ?? process.cwd(),
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
  })
  activeSessions.set(task.id, session)
  if (options.verbose) {
    session.on('assistant.message_delta', (...args: unknown[]) => {
      const event = args[0] as { data: { deltaContent: string } }
      process.stdout.write(event.data.deltaContent)
    })
  }
  interface SdkResponse {
    data?: {
      content?: string
      usage?: Record<string, number>
    }
    usage?: Record<string, number>
  }

  try {
    const timeoutMs = parseTimeout(task.timeout)
    const response = await session.sendAndWait({ prompt }, timeoutMs)
    const typed = response as SdkResponse
    const data = typed?.data
    const output = (data?.content as string | undefined) ?? ''
    const rawUsage = data?.usage ?? typed?.usage
    const u = rawUsage as Record<string, number> | undefined
    const usageResult = u
      ? {
          prompt_tokens: u.prompt_tokens ?? u.promptTokens,
          completion_tokens: u.completion_tokens ?? u.completionTokens,
          total_tokens: u.total_tokens ?? u.totalTokens,
        }
      : undefined
    return {
      success: true,
      output: output.slice(0, 500_000),
      exitCode: 0,
      usage: usageResult,
    }
  } catch (err: unknown) {
    return {
      success: false,
      output: `Claude Agent SDK error: ${(err as Error).message}`,
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

// --- CLI implementation (from claude-code.ts) ---
export async function executeViaCli(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  let prompt = `You are a ${task.agent}. ${task.prompt}`
  if (task.files && task.files.length > 0) {
    prompt += `\n\nOnly modify files under: ${task.files.join(', ')}`
  }
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--max-turns',
    '50',
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
    const proc = spawn('claude', args, {
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
        // Try single JSON object first (claude CLI)
        const parsedJson = JSON.parse(stdout) as Record<string, unknown>
        if (typeof parsedJson.result === 'string') {
          textOutput = parsedJson.result
        }
        const u = parsedJson?.usage as Record<string, number> | undefined
        if (u) {
          const promptTokens = (u.input_tokens ?? u.prompt_tokens) as number | undefined
          const completionTokens = (u.output_tokens ?? u.completion_tokens) as number | undefined
          const total = ((promptTokens ?? 0) + (completionTokens ?? 0)) || undefined
          usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total }
        }
      } catch {
        // Fallback: parse JSONL (one JSON object per line)
        // Claude CLI uses {"result": "text"}, Copilot CLI uses
        // {"type":"assistant.message","data":{"content":"text"}} for the AI
        // response and a separate {"type":"result"} line for session metadata.
        const lines = stdout.split('\n')
        let lastAssistantContent: string | undefined
        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            // Claude-style: result text in the result line
            if (typeof parsed.result === 'string' && parsed.result) {
              textOutput = parsed.result
              const u = parsed?.usage as Record<string, number> | undefined
              if (u) {
                const promptTokens = (u.input_tokens ?? u.prompt_tokens) as number | undefined
                const completionTokens = (u.output_tokens ?? u.completion_tokens) as number | undefined
                const total = ((promptTokens ?? 0) + (completionTokens ?? 0)) || undefined
                usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: total }
              }
              lastAssistantContent = undefined // prefer explicit result field
              break
            }
            // Copilot-style: AI response in assistant.message events
            if (parsed.type === 'assistant.message') {
              const data = parsed.data as Record<string, unknown> | undefined
              if (data && typeof data.content === 'string') {
                lastAssistantContent = data.content
              }
            }
          } catch { /* skip non-JSON lines */ }
        }
        if (lastAssistantContent !== undefined) {
          textOutput = lastAssistantContent
        }
      }
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
        output: `Failed to spawn claude: ${err.message}`,
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