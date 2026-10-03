import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGINS } from './index.js'
import { readAgentPlugin } from '../../cli/agent-plugin.js'
import { packFiles } from '../../cli/pack-plugins.js'

/**
 * Every integration is an Agent Plugin 1.0 directory: plugin.json, its skill in
 * skills/<name>/SKILL.md, and mcp.json when its server can be written portably.
 * Checked the way a conformant client loads one, and held to config.ts, which
 * the files are compiled from.
 */
const root = import.meta.dirname

describe.each(Object.values(PLUGINS).map((p) => [p.id, p] as const))('%s', (id, plugin) => {
  const dir = join(root, id)

  it('is a conformant Agent Plugin, with its skill and server', () => {
    const report = readAgentPlugin(dir)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.skills).toEqual(plugin.skillName ? [plugin.skillName] : [])
    const portable = packFiles(plugin)['mcp.json'] !== undefined
    expect(Object.keys(report.servers)).toEqual(portable ? [plugin.mcpServerKey] : [])
  })

  it('matches its config.ts — run npm run plugins:build if not', () => {
    for (const [rel, text] of Object.entries(packFiles(plugin))) {
      expect(readFileSync(join(dir, rel), 'utf8'), `${id}/${rel}`).toBe(text)
    }
    if (!packFiles(plugin)['mcp.json']) expect(existsSync(join(dir, 'mcp.json'))).toBe(false)
  })
})
