/**
 * The plugin guide takes its MCP configs from the plugin sources.
 *
 * It used to carry hand-copied JSON, and when the sources were pinned and three
 * packages that do not exist were replaced, sixteen cards kept the old configs —
 * `@latest`, and the dead packages — because nothing tied them to the code. The
 * page now renders each snippet from `PLUGINS`; these tests keep it that way.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PLUGINS } from '../orchestrator/plugins/index.js'

const page = readFileSync(
  join(resolve(import.meta.dirname, '..', '..'), 'website', 'src', 'pages', 'docs', 'plugins.astro'),
  'utf8',
)
const rendered = [...page.matchAll(/mcpSnippet\('([\w-]+)'\)/g)].map((m) => m[1])
const withServer = Object.values(PLUGINS).filter((p) => p.mcpServerKey && p.mcpConfig)

describe('the plugin guide', () => {
  it('writes no MCP config by hand', () => {
    expect(page.match(/"(?:command|args|url|type)"\s*:/g) ?? []).toEqual([])
  })

  it('renders only servers that exist', () => {
    const ids = new Set(withServer.map((p) => p.id))
    expect(rendered.filter((id) => !ids.has(id))).toEqual([])
  })

  it('shows every server a plugin ships', () => {
    const shown = new Set(rendered)
    expect(withServer.map((p) => p.id).filter((id) => !shown.has(id))).toEqual([])
  })

  it('names no package that is not on npm', () => {
    for (const dead of ['@anthropic/figma-mcp', '@anthropic/prisma-mcp', '@mseep/linear-mcp', '>netlify-mcp<']) {
      expect(page).not.toContain(dead)
    }
  })
})
