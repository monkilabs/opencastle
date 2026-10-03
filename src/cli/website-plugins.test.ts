/**
 * The plugin guide takes its MCP configs from the plugin sources.
 *
 * It used to carry hand-copied JSON, and when the sources were pinned and three
 * packages that do not exist were replaced, sixteen cards kept the old configs —
 * `@latest`, and the dead packages — because nothing tied them to the code. The
 * page now renders each snippet from `PLUGINS`; these tests keep it that way.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PLUGINS } from '../orchestrator/plugins/index.js'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const pages = join(repoRoot, 'website', 'src', 'pages')
const page = readFileSync(join(pages, 'docs', 'plugins.astro'), 'utf8')
const home = readFileSync(join(pages, 'index.astro'), 'utf8')
const landing = readFileSync(join(pages, 'docs', 'index.astro'), 'utf8')
const rendered = [...page.matchAll(/mcpSnippet\('([\w-]+)'\)/g)].map((m) => m[1])
const withServer = Object.values(PLUGINS).filter((p) => p.mcpServerKey && p.mcpConfig)
const ids = Object.values(PLUGINS).map((p) => p.id)

/** The keys of an object literal `const <name>… = { … };` in a page's frontmatter. */
function keysOf(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`)
  if (start < 0) return []
  const body = source.slice(start, source.indexOf('\n};', start))
  return [...body.matchAll(/^\s{2}(?:'([^']+)'|([\w-]+)):/gm)].map((m) => m[1] ?? m[2])
}

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

/**
 * Hetzner Cloud shipped in the CLI — `add --list` showed it — and was missing from
 * both lists on the site, which said 31 integrations and showed 30. The tests above
 * only covered integrations with an MCP server, and Hetzner has none.
 */
describe('every integration is on the site', () => {
  it('has a card on the integrations page, which init links to by id', () => {
    const cards = [...page.matchAll(/class="plugin-card" id="([\w-]+)"/g)].map((m) => m[1])
    expect(ids.filter((id) => !cards.includes(id))).toEqual([])
    expect(cards.filter((id) => !ids.includes(id))).toEqual([])
  })

  it('is in the homepage grid', () => {
    // The grid takes names and the count from PLUGINS, and each tile's icon and
    // one-line description from these two maps — keyed by the same ids.
    expect(home).toContain("from '../../../src/orchestrator/plugins/index'")
    for (const map of ['integrationBlurbs', 'integrationIcons']) {
      const keys = keysOf(home, map)
      expect(ids.filter((id) => !keys.includes(id)), map).toEqual([])
      expect(keys.filter((id) => !ids.includes(id)), map).toEqual([])
    }
  })

  it('counts the skills the homepage states', () => {
    // The stat is the core skills plus one per integration; it said 57 when it was 62.
    const core = readdirSync(join(repoRoot, 'src', 'orchestrator', 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).length
    expect(home.match(/const coreSkillCount = (\d+);/)?.[1]).toBe(String(core))
  })

  it('states no integration count by hand', () => {
    // 31 was right until a 32nd ships; the pages print Object.keys(PLUGINS).length.
    const count = String(ids.length)
    const sources = [['index.astro', home], ['docs/index.astro', landing], ['plugins.astro', page]] as const
    for (const [name, source] of sources) {
      expect(source.match(new RegExp(`\\b${count} (?:plugins|integrations)\\b`))?.[0], name).toBeUndefined()
    }
  })
})
