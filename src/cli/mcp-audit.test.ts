import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { packageLaunch, isPinned, auditMcpConfig, checkMcpSupplyChain } from './mcp-audit.js'

describe('packageLaunch', () => {
  it('reads the package npx runs, past its own flags', () => {
    expect(packageLaunch('npx', ['-y', '@playwright/mcp@0.0.83'])).toMatchObject({
      name: '@playwright/mcp',
      version: '0.0.83',
      localOnly: false,
    })
  })

  it('separates a scope from a version', () => {
    expect(packageLaunch('npx', ['@sentry/mcp-server'])).toMatchObject({ name: '@sentry/mcp-server', version: null })
    expect(packageLaunch('npx', ['-y', 'convex@latest', 'mcp', 'start'])).toMatchObject({
      name: 'convex',
      version: 'latest',
    })
  })

  it('treats npx --no as the project’s own dependency', () => {
    const launch = packageLaunch('npx', ['--no', 'prisma', 'mcp'])!
    expect(launch.localOnly).toBe(true)
    expect(isPinned(launch)).toBe(true)
  })

  it('follows -p and --package', () => {
    expect(packageLaunch('npx', ['-y', '-p', 'foo@1.2.3', 'foo-mcp'])!.spec).toBe('foo@1.2.3')
    expect(packageLaunch('npx', ['--package=bar@2.0.0', 'bar'])!.spec).toBe('bar@2.0.0')
  })

  it('reads pnpm dlx and bunx, and a Windows shim', () => {
    expect(packageLaunch('pnpm', ['dlx', 'foo@1.0.0'])!.name).toBe('foo')
    expect(packageLaunch('bunx', ['foo'])!.version).toBeNull()
    expect(packageLaunch('C:\\tools\\npx.cmd', ['-y', 'foo@1.0.0'])!.name).toBe('foo')
  })

  it('ignores commands that fetch nothing, and specs that are not registry packages', () => {
    expect(packageLaunch('node', ['server.js'])).toBeNull()
    expect(packageLaunch('pnpm', ['exec', 'foo'])).toBeNull()
    expect(packageLaunch('npx', ['./local-server'])).toBeNull()
    expect(packageLaunch('npx', ['github:org/repo'])).toBeNull()
  })

  it('does not guess past an option it does not know', () => {
    expect(packageLaunch('npx', ['--registry', 'https://example.com', 'foo'])).toBeNull()
  })
})

describe('isPinned', () => {
  const pinned = (spec: string) => isPinned(packageLaunch('npx', ['-y', spec])!)
  it('accepts an exact version, including a prerelease', () => {
    expect(pinned('foo@1.2.3')).toBe(true)
    expect(pinned('@a/b@1.0.0-rc.1')).toBe(true)
  })
  it('rejects a tag, a range, or nothing', () => {
    expect(pinned('foo@latest')).toBe(false)
    expect(pinned('foo@^1.2.3')).toBe(false)
    expect(pinned('foo@1.x')).toBe(false)
    expect(pinned('foo')).toBe(false)
  })
})

describe('auditMcpConfig', () => {
  it('reads the VS Code dialect', () => {
    const findings = auditMcpConfig(
      { servers: { Playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
      'vscode',
    )
    expect(findings).toEqual([
      {
        server: 'Playwright',
        problem: 'unpinned',
        subject: '@playwright/mcp@latest',
        pluginKey: true,
        bySync: true,
        pkg: '@playwright/mcp',
      },
    ])
  })

  it('reads the OpenCode dialect, where command is an array', () => {
    const findings = auditMcpConfig({ mcp: { Mine: { type: 'local', command: ['npx', '-y', 'thing'] } } }, 'opencode')
    expect(findings).toMatchObject([{ server: 'Mine', problem: 'unpinned', pluginKey: false, bySync: false }])
  })

  it('names a package that does not exist on npm', () => {
    const findings = auditMcpConfig(
      { mcpServers: { Netlify: { command: 'npx', args: ['-y', 'netlify-mcp@latest'] } } },
      'cursor',
    )
    expect(findings).toMatchObject([{ server: 'Netlify', problem: 'nonexistent' }])
  })

  it('flags a remote server Claude Code would read as stdio, and only there', () => {
    const config = { mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } }
    expect(auditMcpConfig(config, 'claude-code')).toMatchObject([{ server: 'Supabase', problem: 'untyped-remote' }])
    expect(auditMcpConfig(config, 'cursor')).toEqual([])
    expect(auditMcpConfig({ mcpServers: { Supabase: { type: 'http', url: 'https://x' } } }, 'claude-code')).toEqual([])
  })

  it('passes pinned, project-local and remote servers', () => {
    const config = {
      mcpServers: {
        Playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] },
        Prisma: { command: 'npx', args: ['--no', 'prisma', 'mcp'] },
        Mine: { command: 'node', args: ['tools/mcp.js'] },
        Remote: { type: 'http', url: 'https://mcp.example.com' },
      },
    }
    expect(auditMcpConfig(config, 'claude-code')).toEqual([])
  })
})

describe('checkMcpSupplyChain', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-audit-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const write = (rel: string, value: unknown) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), JSON.stringify(value))
  }

  it('passes with no config at all', () => {
    expect(checkMcpSupplyChain(root, 'claude-code')).toMatchObject({ ok: true })
  })

  it('leaves an unparseable config to the check that owns it', () => {
    writeFileSync(join(root, '.mcp.json'), '{ nope')
    const r = checkMcpSupplyChain(root, 'claude-code')
    expect(r.ok).toBe(true)
    expect(r.warning).toBeUndefined()
  })

  it('warns on an unpinned server and points sync at the ones it owns', () => {
    write('.cursor/mcp.json', { mcpServers: { Playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } })
    const r = checkMcpSupplyChain(root, 'cursor')
    expect(r).toMatchObject({ ok: true, warning: true })
    expect(r.fix).toMatch(/^opencastle sync/)
  })

  it('does not send the user to sync for a server sync will not touch', () => {
    write('.cursor/mcp.json', { mcpServers: { Mine: { command: 'npx', args: ['-y', 'my-mcp'] } } })
    const r = checkMcpSupplyChain(root, 'cursor')
    expect(r.fix).toMatch(/^fix Mine by hand/)
  })

  it('tells an edited plugin entry apart from one sync still owns', () => {
    write('.cursor/mcp.json', {
      mcpServers: {
        Playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] },
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
      },
    })
    const r = checkMcpSupplyChain(root, 'cursor')
    expect(r.fix).toContain('opencastle sync fixes chrome-devtools')
    expect(r.fix).toContain('Playwright changed since OpenCastle wrote them')
  })

  it('fails on a server that cannot load', () => {
    write('.mcp.json', { mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } })
    const r = checkMcpSupplyChain(root, 'claude-code')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('Supabase')
  })

  it('fails on a package that is not on npm, and says why', () => {
    write('.vscode/mcp.json', { servers: { Figma: { type: 'stdio', command: 'npx', args: ['-y', '@anthropic/figma-mcp@latest'] } } })
    const r = checkMcpSupplyChain(root, 'vscode')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('never published')
  })
})
