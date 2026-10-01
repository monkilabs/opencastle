/**
 * The MCP servers this tool writes into a project are code that agents run with
 * the developer's credentials, on every teammate's machine and in CI. These
 * tests hold every default to the rules `doctor` holds a user's config to, so
 * the tool can never ship the thing it warns about.
 *
 * They exist because it did: most defaults ran `@latest`, and three pointed at
 * packages that are not on npm at all — two never published, one unpublished in
 * January 2026, whose name anyone could register and have every existing install
 * run on its next start.
 */
import { describe, it, expect } from 'vitest'
import { PLUGINS } from './index.js'
import { packageLaunch, isPinned, NONEXISTENT_PACKAGES } from '../../cli/mcp-audit.js'

const withMcp = Object.values(PLUGINS).filter((p) => p.mcpServerKey && p.mcpConfig)

describe('shipped MCP defaults', () => {
  it('has servers to check', () => {
    expect(withMcp.length).toBeGreaterThan(10)
  })

  it('pins every package a runner fetches, or runs the project’s own copy', () => {
    const offenders: string[] = []
    for (const plugin of withMcp) {
      const cfg = plugin.mcpConfig!
      if (cfg.type !== 'stdio') continue
      const launch = packageLaunch(cfg.command ?? '', cfg.args ?? [])
      if (launch && !isPinned(launch)) offenders.push(`${plugin.id}: ${launch.spec}`)
    }
    expect(offenders).toEqual([])
  })

  it('never says @latest', () => {
    const offenders = withMcp
      .filter((p) => (p.mcpConfig!.args ?? []).some((a) => a.endsWith('@latest')))
      .map((p) => p.id)
    expect(offenders).toEqual([])
  })

  it('launches no package known not to exist', () => {
    const offenders: string[] = []
    for (const plugin of withMcp) {
      const cfg = plugin.mcpConfig!
      const launch = cfg.type === 'stdio' ? packageLaunch(cfg.command ?? '', cfg.args ?? []) : null
      if (launch && NONEXISTENT_PACKAGES[launch.name]) offenders.push(`${plugin.id}: ${launch.spec}`)
    }
    expect(offenders).toEqual([])
  })

  it('keeps mcpPackage in step with what is actually launched', () => {
    const offenders: string[] = []
    for (const plugin of withMcp) {
      const cfg = plugin.mcpConfig!
      const launch = cfg.type === 'stdio' ? packageLaunch(cfg.command ?? '', cfg.args ?? []) : null
      if (launch && plugin.mcpPackage && plugin.mcpPackage !== launch.name) {
        offenders.push(`${plugin.id}: mcpPackage ${plugin.mcpPackage}, launches ${launch.name}`)
      }
      if (!launch && plugin.mcpPackage) offenders.push(`${plugin.id}: mcpPackage set on a server that launches no package`)
    }
    expect(offenders).toEqual([])
  })

  it('reaches every remote server over https', () => {
    const offenders = withMcp
      .filter((p) => p.mcpConfig!.type === 'http' && !/^https:\/\//.test(p.mcpConfig!.url ?? ''))
      .map((p) => p.id)
    expect(offenders).toEqual([])
  })

  it('records a previous default only when it differs from the current one', () => {
    const offenders: string[] = []
    for (const plugin of withMcp) {
      for (const prev of plugin.previousMcpConfigs ?? []) {
        if (JSON.stringify(prev.mcpConfig) === JSON.stringify(plugin.mcpConfig)) offenders.push(plugin.id)
      }
    }
    expect(offenders).toEqual([])
  })
})
