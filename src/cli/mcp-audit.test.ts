import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { packageLaunch, isPinned, auditMcpConfig, checkMcpSupplyChain, unwrapShell } from './mcp-audit.js'

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

  it('skips the value of an option it knows, and stops at one it does not', () => {
    expect(packageLaunch('npx', ['-y', '--registry', 'https://r.example.com', 'foo@1.0.0'])!.name).toBe('foo')
    expect(packageLaunch('npx', ['--registry=https://r.example.com', 'foo'])!.version).toBeNull()
    expect(packageLaunch('npx', ['--weird', 'x', 'foo'])).toBeNull()
  })

  it('reads only the runner’s flags — what follows the package is the server’s', () => {
    // `--no` after the package is an argument to the server, not to npx.
    expect(packageLaunch('npx', ['-y', 'foo@latest', '--no'])!.localOnly).toBe(false)
  })

  it('sees through the cmd /c wrapper Claude Code documents for Windows', () => {
    expect(unwrapShell('cmd', ['/c', 'npx', '-y', 'foo'])).toEqual({ command: 'npx', args: ['-y', 'foo'] })
    expect(packageLaunch('cmd', ['/c', 'npx', '-y', 'foo@latest'])).toMatchObject({ name: 'foo', version: 'latest' })
  })

  it('reads uvx, including --from and ==', () => {
    expect(packageLaunch('uvx', ['mcp-server-fetch'])).toMatchObject({ name: 'mcp-server-fetch', version: null })
    expect(packageLaunch('uvx', ['mcp-server-fetch==2025.4.7'])).toMatchObject({ version: '2025.4.7' })
    expect(packageLaunch('uvx', ['--from', 'pkg@1.2.3', 'pkg-mcp'])).toMatchObject({ name: 'pkg', version: '1.2.3' })
  })

  it('reads npm exec and pipx run', () => {
    expect(packageLaunch('npm', ['exec', '--yes', 'foo@latest'])).toMatchObject({ name: 'foo', version: 'latest' })
    expect(packageLaunch('pipx', ['run', 'pkg==1.2.3'])).toMatchObject({ name: 'pkg', version: '1.2.3' })
    expect(packageLaunch('pipx', ['run', '--spec', 'pkg==1.2.3', 'pkg-mcp'])).toMatchObject({ version: '1.2.3' })
  })

  it('names no package for a shell string', () => {
    expect(packageLaunch('npx', ['-c', 'echo hi'])).toBeNull()
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
    const { findings, outdated } = auditMcpConfig(
      { servers: { Playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } },
      'vscode',
    )
    expect(findings).toEqual([
      {
        server: 'Playwright',
        problem: 'unpinned',
        subject: '@playwright/mcp@latest',
        pkg: '@playwright/mcp',
        sync: 'replaces',
        plugin: 'playwright',
      },
    ])
    expect(outdated).toEqual(['Playwright'])
  })

  it('reads the OpenCode dialect, where command is an array', () => {
    const { findings } = auditMcpConfig({ mcp: { Mine: { type: 'local', command: ['npx', '-y', 'thing'] } } }, 'opencode')
    expect(findings).toMatchObject([{ server: 'Mine', problem: 'unpinned', sync: 'keeps' }])
    expect(findings[0].plugin).toBeUndefined()
  })

  it('names a package that does not exist on npm', () => {
    const { findings } = auditMcpConfig(
      { mcpServers: { Netlify: { command: 'npx', args: ['-y', 'netlify-mcp@latest'] } } },
      'cursor',
    )
    expect(findings).toMatchObject([{ server: 'Netlify', problem: 'nonexistent' }])
  })

  it('flags a remote server Claude Code would read as stdio, and only there', () => {
    const config = { mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } }
    expect(auditMcpConfig(config, 'claude-code').findings).toMatchObject([{ server: 'Supabase', problem: 'untyped-remote' }])
    expect(auditMcpConfig(config, 'cursor').findings).toEqual([])
    expect(auditMcpConfig({ mcpServers: { Supabase: { type: 'http', url: 'https://x' } } }, 'claude-code').findings).toEqual([])
  })

  it('passes pinned, project-local, remote and local servers, and counts them', () => {
    const config = {
      mcpServers: {
        Playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] },
        Prisma: { command: 'npx', args: ['--no', 'prisma', 'mcp'] },
        Mine: { command: 'node', args: ['tools/mcp.js'] },
        Remote: { type: 'http', url: 'https://mcp.example.com' },
      },
    }
    const audit = auditMcpConfig(config, 'claude-code')
    expect(audit.findings).toEqual([])
    expect(audit.passed).toBe(4)
    expect(audit.unaudited).toEqual([])
  })

  it('says what it could not read instead of passing it', () => {
    const audit = auditMcpConfig(
      {
        mcpServers: {
          Box: { command: 'docker', args: ['run', '-i', 'mcp/fetch:latest'] },
          Odd: { command: 'npx', args: ['--weird', 'x', 'foo'] },
        },
      },
      'cursor',
    )
    expect(audit.passed).toBe(0)
    expect(audit.unaudited.map((u) => u.server)).toEqual(['Box', 'Odd'])
  })

  it('passes a container image pinned by digest, and only that', () => {
    const digest = 'mcp/fetch@sha256:' + 'a'.repeat(64)
    expect(auditMcpConfig({ mcpServers: { Box: { command: 'docker', args: ['run', '-i', digest] } } }, 'cursor').passed).toBe(1)
    expect(auditMcpConfig({ mcpServers: { Box: { command: 'docker', args: ['run', '-i', 'mcp/fetch:1.2'] } } }, 'cursor').unaudited).toHaveLength(1)
  })

  it('knows sync removes a plugin server the stack does not include', () => {
    const { findings } = auditMcpConfig(
      { mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } },
      'claude-code',
      new Set(),
    )
    expect(findings).toMatchObject([{ server: 'Supabase', sync: 'removes', plugin: 'supabase' }])
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

  it('does not say sync fixes a server that sync will delete', () => {
    write('.mcp.json', { mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } })
    const r = checkMcpSupplyChain(root, 'claude-code', new Set())
    expect(r.fix).toContain('opencastle sync removes Supabase')
    expect(r.fix).toContain('opencastle add supabase')
    expect(r.fix).not.toContain('fixes')
  })

  it('warns, rather than passing, when it cannot read what a server launches', () => {
    write('.cursor/mcp.json', { mcpServers: { Box: { command: 'docker', args: ['run', '-i', 'mcp/fetch:latest'] } } })
    const r = checkMcpSupplyChain(root, 'cursor')
    expect(r).toMatchObject({ ok: true, warning: true })
    expect(r.detail).toContain('Box (container image without a digest)')
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
    expect(r.fix).toContain('opencastle sync --force')
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
