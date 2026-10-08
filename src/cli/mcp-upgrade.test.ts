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
import { upgradeGeneratedServers, rebuildMcpConfig, scaffoldMcpConfig, teamEntryFor, getMcpConfigRelPath, containerKeyFor } from './mcp.js'
import { auditMcpConfig } from './mcp-audit.js'
import { parseMcpConfigText } from './mcp-file.js'
import type { IdeChoice, StackConfig } from './types.js'

describe('upgradeGeneratedServers', () => {
  it('adds the type Claude Code needs to a remote server we wrote without it', () => {
    const servers: Record<string, unknown> = { Supabase: { url: 'https://mcp.supabase.com/mcp' } }
    const upgraded = upgradeGeneratedServers(servers, 'claude-code', new Set(['Supabase']))
    expect(upgraded).toEqual(['Supabase'])
    expect(servers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
  })

  it('moves Antigravity entries to serverUrl, and drops a ${NAME} it would send as text', () => {
    // As every release before this one wrote them into .agents/mcp_config.json.
    const servers: Record<string, unknown> = {
      Supabase: { url: 'https://mcp.supabase.com/mcp' },
      Coolify: {
        command: 'npx',
        args: ['-y', '@masonator/coolify-mcp@3.7.0'],
        env: { COOLIFY_ACCESS_TOKEN: '${COOLIFY_ACCESS_TOKEN}', COOLIFY_BASE_URL: '${COOLIFY_BASE_URL}' },
      },
    }
    expect(upgradeGeneratedServers(servers, 'antigravity', new Set(['Supabase', 'Coolify'])).sort()).toEqual(['Coolify', 'Supabase'])
    expect(servers.Supabase).toEqual({ serverUrl: 'https://mcp.supabase.com/mcp' })
    expect(servers.Coolify).toEqual({ command: 'npx', args: ['-y', '@masonator/coolify-mcp@3.7.0'] })
  })

  it('writes a team server for Antigravity in its shape, and the audit names what it cannot expand', () => {
    const remote = teamEntryFor('docs', { url: 'https://docs.acme.example/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } }, 'antigravity').entry
    expect(remote).toEqual({ serverUrl: 'https://docs.acme.example/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } })
    const local = teamEntryFor('db', { command: 'npx', args: ['-y', 'db-mcp@1.0.0'], env: { DB_URL: '${DB_URL}', MODE: 'ro' } }, 'antigravity').entry
    expect(local).toEqual({ command: 'npx', args: ['-y', 'db-mcp@1.0.0'], env: { MODE: 'ro' } })
    const audit = auditMcpConfig({ mcpServers: { docs: remote } }, 'antigravity')
    expect(audit.findings.find((f) => f.problem === 'unexpanded-variable')?.subject).toContain('${DOCS_TOKEN} →')
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

    const { upgraded, removed } = await rebuildMcpConfig(root, 'claude-code', stack)
    expect(upgraded.sort()).toEqual(['Figma', 'Supabase'])
    expect(removed).toEqual([])

    const after = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
    expect(after.mcpServers.Supabase).toEqual({ type: 'http', url: 'https://mcp.supabase.com/mcp' })
    expect(after.mcpServers.Figma).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' })
    expect(after.mcpServers.Mine).toEqual({ command: 'node', args: ['tools/mcp.js'] })
  })

  it('changes nothing on a second run', async () => {
    await scaffoldMcpConfig(root, '.mcp.json', stack, undefined, 'claude-code')
    const first = readFileSync(join(root, '.mcp.json'), 'utf8')
    expect(await rebuildMcpConfig(root, 'claude-code', stack)).toEqual({ upgraded: [], removed: [], teamWritten: [], teamRemoved: [] })
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(first)
  })

  it('names a plugin server it removes because the stack dropped it', async () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { Linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }) + '\n',
    )
    const { removed } = await rebuildMcpConfig(root, 'claude-code', stack)
    expect(removed).toEqual(['Linear'])
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

/**
 * GitHub's server completes OAuth in VS Code and nowhere else. VS Code gets the
 * bare URL; every other target sends the token, in its own spelling of "this
 * environment variable" — a `${NAME}` Cursor or OpenCode does not expand would
 * reach GitHub as those characters.
 */
describe('a remote server only some targets sign in to with OAuth', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-token-auth-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const url = 'https://api.githubcopilot.com/mcp/'
  const written = async (ide: IdeChoice): Promise<unknown> => {
    const rel = getMcpConfigRelPath(ide)
    await scaffoldMcpConfig(root, rel, { ides: [ide], techTools: [], teamTools: ['github'] }, undefined, ide)
    const config = parseMcpConfigText(readFileSync(join(root, rel), 'utf8'), rel)
    return (config[containerKeyFor(ide)] as Record<string, unknown>).GitHub
  }

  it.each([
    ['vscode', { type: 'http', url }],
    ['claude-code', { type: 'http', url, headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } }],
    ['cursor', { url, headers: { Authorization: 'Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}' } }],
    ['windsurf', { url, headers: { Authorization: 'Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}' } }],
    ['opencode', { type: 'remote', url, headers: { Authorization: 'Bearer {env:GITHUB_PERSONAL_ACCESS_TOKEN}' } }],
    ['codex', { url, bearer_token_env_var: 'GITHUB_PERSONAL_ACCESS_TOKEN' }],
  ] as const)('%s', async (ide, entry) => {
    expect(await written(ide)).toEqual(entry)
  })

  it('writes nothing the audit objects to, and nothing a rebuild changes', async () => {
    const entry = await written('claude-code')
    expect(auditMcpConfig({ mcpServers: { GitHub: entry } }, 'claude-code').findings).toEqual([])
    const stack: StackConfig = { ides: ['claude-code'], techTools: [], teamTools: ['github'] }
    expect(await rebuildMcpConfig(root, 'claude-code', stack)).toEqual({ upgraded: [], removed: [], teamWritten: [], teamRemoved: [] })
  })
})
