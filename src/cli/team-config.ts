import * as v from 'valibot'

/**
 * The team's own source: `.opencastle/config.json`, and the same file at the
 * root of every baseline it extends.
 *
 * Until this existed, OpenCastle compiled only its own content. A team could
 * not write a skill, an instruction or an agent once and have every assistant
 * receive it, which is the whole promise of a compiler — and could not share
 * one standard across its repositories at all. A layer is a directory laid out
 * like `.opencastle/`:
 *
 *   config.json            this file: extends, exclude, mcpServers, policy
 *   instructions/*.md      always loaded, by every assistant
 *   agents/*.agent.md      personas
 *   skills/<name>/SKILL.md on-demand knowledge, found by its description
 *   prompts/*.prompt.md    reusable prompts / commands
 *   workflows/*.md         multi-step workflow templates
 *
 * The project's `.opencastle/` is the top layer; `extends` puts baselines
 * underneath it, and OpenCastle's own content sits at the bottom.
 */

export const TEAM_CONFIG_REL = '.opencastle/config.json'
export const LAYER_CONFIG_FILE = 'config.json'
export const CONFIG_SCHEMA_URL = 'https://www.opencastle.dev/schema/config.json'

export const CONTENT_KINDS = ['instructions', 'agents', 'skills', 'prompts', 'workflows'] as const
export type ContentKind = (typeof CONTENT_KINDS)[number]

/** A problem found while reading or resolving team sources. */
export interface TeamIssue {
  level: 'error' | 'warning'
  /** The file or setting it is about, project-relative where possible. */
  where: string
  message: string
  fix?: string
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const ITEM_REF = new RegExp(`^(${CONTENT_KINDS.join('|')})/[A-Za-z0-9][A-Za-z0-9._-]*$`)

const ItemRef = v.pipe(
  v.string(),
  v.regex(ITEM_REF, 'must name a kind and an item, e.g. "skills/seo-patterns" or "agents/content-engineer"'),
)

const McpServer = v.strictObject({
  type: v.optional(v.picklist(['stdio', 'http'])),
  command: v.optional(v.pipe(v.string(), v.minLength(1))),
  args: v.optional(v.array(v.string())),
  url: v.optional(v.pipe(v.string(), v.regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'))),
  env: v.optional(v.record(v.string(), v.string())),
  headers: v.optional(v.record(v.string(), v.string())),
  description: v.optional(v.string()),
})

const Policy = v.strictObject({
  mcp: v.optional(
    v.strictObject({
      allow: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
      remoteHosts: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
      requirePinned: v.optional(v.boolean()),
    }),
  ),
  require: v.optional(v.array(ItemRef)),
  contextBudget: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})

export const TeamConfigSchema = v.strictObject({
  $schema: v.optional(v.string()),
  opencastle: v.optional(v.pipe(v.string(), v.minLength(1))),
  extends: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  exclude: v.optional(v.array(ItemRef)),
  mcpServers: v.optional(
    v.record(v.pipe(v.string(), v.regex(NAME, 'server names are letters, digits, ".", "_" and "-"')), McpServer),
  ),
  policy: v.optional(Policy),
})

export type TeamConfig = v.InferOutput<typeof TeamConfigSchema>
export type TeamMcpServer = NonNullable<TeamConfig['mcpServers']>[string]
export type TeamPolicy = NonNullable<TeamConfig['policy']>

/** Every key the schema knows, for "did you mean" on a typo. */
const KNOWN_KEYS = [
  '$schema', 'opencastle', 'extends', 'exclude', 'mcpServers', 'policy',
  'type', 'command', 'args', 'url', 'env', 'headers', 'description',
  'mcp', 'allow', 'remoteHosts', 'requirePinned', 'require', 'contextBudget',
]

function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

function suggest(key: string): string | undefined {
  let best: string | undefined
  let bestScore = Infinity
  for (const k of KNOWN_KEYS) {
    const s = distance(key.toLowerCase(), k.toLowerCase())
    if (s < bestScore) {
      best = k
      bestScore = s
    }
  }
  return bestScore <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined
}

/**
 * JSON with comments and trailing commas, which is what people write in a
 * config file their editor treats as JSONC. Rejecting a `//` comment in a file
 * with a `$schema` line would punish exactly the teams who set it up properly.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      // Newlines kept, so a JSON error's position still points at the right line.
      const body = end === -1 ? text.slice(i) : text.slice(i, end + 2)
      out += body.replace(/[^\n]/g, ' ')
      i = end === -1 ? text.length : end + 2
      continue
    }
    out += ch
    i++
  }
  return dropTrailingCommas(out)
}

/** A comma followed only by whitespace and a closing bracket, outside strings. */
function dropTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

/** Parse and validate one layer's config text. */
export function parseTeamConfig(text: string, where: string): { config: TeamConfig | null; issues: TeamIssue[] } {
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text.replace(/^﻿/, '')))
  } catch (err) {
    return {
      config: null,
      issues: [{ level: 'error', where, message: `is not valid JSON — ${(err as Error).message}`, fix: `fix the syntax in ${where}` }],
    }
  }
  const result = v.safeParse(TeamConfigSchema, raw)
  if (result.success) return { config: result.output, issues: [] }

  const issues: TeamIssue[] = []
  for (const issue of result.issues) {
    const path = v.getDotPath(issue)
    if (issue.type === 'strict_object' || issue.expected === 'never') {
      // An unknown key. The default message is "Expected never", which says
      // nothing to a person who typed `extend` instead of `extends`.
      const key = String(issue.input === undefined ? path : (path ?? '').split('.').pop())
      const bad = typeof issue.input === 'string' ? issue.input : key
      const hint = suggest(bad)
      issues.push({
        level: 'error',
        where,
        message: `unknown setting "${path ?? bad}"`,
        fix: hint ? `did you mean "${hint}"?` : `remove it, or see ${CONFIG_SCHEMA_URL}`,
      })
      continue
    }
    issues.push({ level: 'error', where, message: `${path ? `${path}: ` : ''}${issue.message}` })
  }
  return { config: null, issues }
}

/** How a server launches: a URL means remote, a command means local. */
export function serverTransport(server: TeamMcpServer): 'stdio' | 'http' | null {
  if (server.type) return server.type
  if (server.url && !server.command) return 'http'
  if (server.command && !server.url) return 'stdio'
  return null
}

/** Shape problems a schema cannot express: exactly one of command or url. */
export function checkServerShape(key: string, server: TeamMcpServer, where: string): TeamIssue[] {
  const t = serverTransport(server)
  if (t === null) {
    return [{
      level: 'error',
      where,
      message: `mcpServers.${key} needs either "command" (a local server) or "url" (a remote one)`,
    }]
  }
  if (t === 'stdio' && !server.command) {
    return [{ level: 'error', where, message: `mcpServers.${key} is "stdio" but has no "command"` }]
  }
  if (t === 'http' && !server.url) {
    return [{ level: 'error', where, message: `mcpServers.${key} is "http" but has no "url"` }]
  }
  if (t === 'stdio' && server.headers) {
    return [{ level: 'error', where, message: `mcpServers.${key}: "headers" only apply to a remote ("url") server` }]
  }
  if (t === 'http' && (server.args || server.env)) {
    return [{ level: 'error', where, message: `mcpServers.${key}: "args" and "env" only apply to a local ("command") server` }]
  }
  return []
}
