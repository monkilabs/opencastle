/**
 * Existing installs get corrected defaults without losing anyone's edits.
 *
 * `sync` leaves a server entry alone once it exists, because people tune them.
 * That is why the broken defaults — packages missing from npm, `@latest`, remote
 * servers in a shape Claude Code cannot load — would otherwise have stayed in
 * every config written before the fix. An entry still exactly as a release wrote
 * it is replaced; anything else is the user's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { upgradeGeneratedServers, rebuildMcpConfig, scaffoldMcpConfig } from './mcp.js'
import type { StackConfig } from './types.js'

describe('upgradeGeneratedServers', () => {
  it('adds the type Claude Code needs to a remote server we wrote without it', () => {
    const servers: Record<string, unknown> = { Supabase: { url: 'https://mcp.supabase.com/mcp' } }
    const upgraded = upgradeGeneratedServers(servers, 'claude-code', new Set(['Supabase']))
    expect(upgraded).toEqual(['Supabase'])
    expect(servers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
  })

  it('moves a retired default to the current one, env vars and all', () => {
    // What earlier releases wrote into .mcp.json for Figma: a package that was
    // never published, with the token they asked for spelled into `env`.
    const servers: Record<string, unknown> = {
      Figma: {
        command: 'npx',
        args: ['-y', '@anthropic/figma-mcp@latest'],
        env: { FIGMA_ACCESS_TOKEN: '${FIGMA_ACCESS_TOKEN}' },
      },
    }
    expect(upgradeGeneratedServers(servers, 'claude-code', new Set(['Figma']))).toEqual(['Figma'])
    expect(servers.Figma).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' })
  })

  it('pins an @latest we wrote, in the VS Code dialect', () => {
    const servers: Record<string, unknown> = {
      Playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    }
    expect(upgradeGeneratedServers(servers, 'vscode', new Set(['Playwright']))).toEqual(['Playwright'])
    expect((servers.Playwright as { args: string[] }).args).toEqual(['-y', '@playwright/mcp@0.0.83'])
  })

  it('leaves an entry the user changed, however slightly', () => {
    const edited = { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] }
    const servers: Record<string, unknown> = { Playwright: edited }
    expect(upgradeGeneratedServers(servers, 'vscode', new Set(['Playwright']))).toEqual([])
    expect(servers.Playwright).toBe(edited)
  })

  it('leaves an entry that is already current', () => {
    const servers: Record<string, unknown> = { Supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } }
    expect(upgradeGeneratedServers(servers, 'claude-code', new Set(['Supabase']))).toEqual([])
  })

  it('touches only servers the stack still includes, and never a user’s own', () => {
    const servers: Record<string, unknown> = {
      Supabase: { url: 'https://mcp.supabase.com/mcp' },
      Mine: { url: 'https://example.com/mcp' },
    }
    expect(upgradeGeneratedServers(servers, 'claude-code', new Set())).toEqual([])
    expect(servers.Mine).toEqual({ url: 'https://example.com/mcp' })
  })

  it('is key-order blind, like the JSON it reads', () => {
    const servers: Record<string, unknown> = {
      Playwright: { args: ['-y', '@playwright/mcp@latest'], command: 'npx', type: 'stdio' },
    }
    expect(upgradeGeneratedServers(servers, 'vscode', new Set(['Playwright']))).toEqual(['Playwright'])
  })
})

describe('rebuildMcpConfig on an install from before the fix', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-upgrade-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const stack: StackConfig = { ides: ['claude-code'], techTools: ['supabase', 'figma'], teamTools: [] }

  it('rewrites what we wrote, keeps what they wrote, and says which', async () => {
    const before = {
      mcpServers: {
        Supabase: { url: 'https://mcp.supabase.com/mcp' },
        Figma: {
          command: 'npx',
          args: ['-y', '@anthropic/figma-mcp@latest'],
          env: { FIGMA_ACCESS_TOKEN: '${FIGMA_ACCESS_TOKEN}' },
        },
        Mine: { command: 'node', args: ['tools/mcp.js'] },
      },
    }
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(before, null, 2) + '\n')

    const upgraded = await rebuildMcpConfig(root, 'claude-code', stack)
    expect(upgraded.sort()).toEqual(['Figma', 'Supabase'])

    const after = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
    expect(after.mcpServers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
    expect(after.mcpServers.Figma).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' })
    expect(after.mcpServers.Mine).toEqual({ command: 'node', args: ['tools/mcp.js'] })
  })

  it('changes nothing on a second run', async () => {
    await scaffoldMcpConfig(root, '.mcp.json', stack, undefined, 'claude-code')
    const first = readFileSync(join(root, '.mcp.json'), 'utf8')
    expect(await rebuildMcpConfig(root, 'claude-code', stack)).toEqual([])
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(first)
  })

  it('writes remote servers Claude Code can load on a fresh install', async () => {
    mkdirSync(root, { recursive: true })
    await scaffoldMcpConfig(root, '.mcp.json', stack, undefined, 'claude-code')
    const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
    for (const entry of Object.values(config.mcpServers) as Array<Record<string, unknown>>) {
      if ('url' in entry) expect(entry.type).toBe('http')
    }
  })
})
