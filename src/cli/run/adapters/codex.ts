import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Task, ExecuteOptions, ExecuteResult } from '../../convoy/spec-types.js'

/** Adapter name */
export const name = 'codex'

export function supportsSessionContinuity(): boolean { return false }

export async function isAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['codex'], { stdio: 'pipe' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

export async function execute(task: Task, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  let prompt = `You are a ${task.agent}. ${task.prompt}`

  if (task.files && task.files.length > 0) {
    prompt += `\n\nOnly modify files under: ${task.files.join(', ')}`
  }

  const cwd = options.cwd ?? process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'opencastle-codex-'))
  const lastMessagePath = join(tempDir, 'last-message.txt')

  const args = [
    '-a',
    'never',
    'exec',
    '-s',
    'workspace-write',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    cwd,
    '-o',
    lastMessagePath,
    prompt,
  ]

  // Codex CLI currently relies on project/global MCP configuration rather than a per-run config flag.
  void options.mcpServers
  void options.mcp_approve_all

  try {
    return await new Promise<ExecuteResult>((resolve) => {
      const proc = spawn('codex', args, {
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
        const lastMessage = existsSync(lastMessagePath)
          ? readFileSync(lastMessagePath, 'utf8').trimEnd()
          : ''
        const output = code === 0
          ? (lastMessage || stdout.trim() || stderr.trim())
          : [lastMessage, stdout, stderr].filter(Boolean).join('\n')

        resolve({
          success: code === 0,
          output: output.slice(0, 500_000),
          exitCode: code ?? -1,
        })
      })

      proc.on('error', (err) => {
        resolve({
          success: false,
          output: `Failed to spawn codex: ${err.message}`,
          exitCode: -1,
        })
      })

      task._process = proc
    })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

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
