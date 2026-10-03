import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TECH_PLUGINS, TEAM_PLUGINS } from './index.js'
import { getMcpConfigRelPath } from '../../cli/mcp.js'
import { IDE_ADAPTERS, VALID_IDES } from '../../cli/adapters/index.js'
import type { IdeChoice } from '../../cli/types.js'

/**
 * Facts written down twice, held to each other.
 *
 * `TechTool` and `TeamTool` are hand-written unions beside the registry, and
 * `hetzner` was in the registry and missing from `TechTool`. Each target's MCP
 * config path is in its adapter and again in `getMcpConfigRelPath`, which the
 * rebuild, strip and audit read — the two must name the same file, or `sync`
 * writes one file and `remove` cleans another.
 */
const types = readFileSync(join(import.meta.dirname, '..', '..', 'cli', 'types.ts'), 'utf8')

function union(name: string): string[] {
  const m = new RegExp(`export type ${name} = ([^;]+);`).exec(types)
  expect(m, `${name} not found in types.ts`).toBeTruthy()
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
}

describe('the plugin registry and the types that name it', () => {
  it('TechTool names every tech integration', () => {
    expect(union('TechTool')).toEqual(TECH_PLUGINS.map((p) => p.id).sort())
  })

  it('TeamTool names every team integration', () => {
    expect(union('TeamTool')).toEqual(TEAM_PLUGINS.map((p) => p.id).sort())
  })
})

describe('MCP config paths', () => {
  it.each(VALID_IDES)('%s: the adapter and getMcpConfigRelPath name the same file', async (ide) => {
    const adapter = await IDE_ADAPTERS[ide]()
    const configs = adapter.getManagedPaths().customizable.filter((p) => !p.endsWith('/'))
    expect(configs).toEqual([getMcpConfigRelPath(ide as IdeChoice)])
  })
})
