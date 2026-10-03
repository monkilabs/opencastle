import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { TeamMcpServer } from './team-config.js'

/**
 * Agent Plugins: the portable package format for agent extensions.
 *
 * Agent Plugins 1.0 (agent-plugins.org, under the Agentic AI Foundation) is a
 * directory with a closed `plugin.json` manifest at its root, Agent Skills in
 * `skills/<name>/SKILL.md`, and MCP servers in `mcp.json`. GitHub Copilot, VS
 * Code, Cursor, Codex and Kiro load it as it is. Anything a client adds lives
 * under a reverse-domain namespace — OpenCastle's is `dev.opencastle`, a
 * directory beside `skills/` holding what the standard does not cover yet:
 * instructions, agents, prompts, workflows and the team's policy.
 *
 * That makes an OpenCastle baseline and an Agent Plugin the same thing. A team
 * publishes one package; assistants that read Agent Plugins install it
 * natively, and OpenCastle compiles all of it — the parts the standard covers
 * and the parts it does not — into every assistant, including the ones that do
 * not read Agent Plugins at all.
 *
 * This module reads and checks one, against the published 1.0.0 text; the
 * schemas are the spec's, written as code because a client must not fetch a
 * schema while loading a plugin.
 */

export const AGENT_PLUGINS_VERSION = '1.0.0'
/** Versions whose rules this reads. 1.1.0 is a working draft that changes nothing but the number. */
const KNOWN_VERSIONS = ['1.0.0', '1.1.0']
export const pluginSchemaUrl = (v = AGENT_PLUGINS_VERSION): string => `https://agent-plugins.org/schemas/${v}/plugin.schema.json`
export const mcpSchemaUrl = (v = AGENT_PLUGINS_VERSION): string => `https://agent-plugins.org/schemas/${v}/mcp.schema.json`

/** OpenCastle's extension namespace: the `extensions` key and the directory. */
export const EXTENSION_NAMESPACE = 'dev.opencastle'

export interface PluginManifest {
  $schema: string
  name: string
  version?: string
  description?: string
  author?: { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  extensions?: Record<string, Record<string, unknown>>
}

export type PortableServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'streamable-http' | 'sse'; url: string; headers?: Record<string, string> }

export interface PluginReport {
  root: string
  manifest?: PluginManifest
  /** The Agent Plugins version it targets. */
  version?: string
  skills: string[]
  servers: Record<string, PortableServer>
  /** Problems that make it, or one of its components, not load in a conformant client. */
  errors: string[]
  /** What a client reports and ignores, and what will surprise someone. */
  warnings: string[]
}

const MANIFEST_FIELDS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every((x) => typeof x === 'string')
}

/** The version a `$schema` names, or null when it is not one this reads. */
function versionOf(schema: unknown, kind: 'plugin' | 'mcp'): string | null {
  if (typeof schema !== 'string') return null
  const m = new RegExp(`^https://agent-plugins\\.org/schemas/(\\d+\\.\\d+\\.\\d+)/${kind}\\.schema\\.json$`).exec(schema)
  return m && KNOWN_VERSIONS.includes(m[1]) ? m[1] : null
}

function readJson(path: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** Whether `abs`, links followed, is inside `root`. */
function inside(root: string, abs: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(abs))
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
  } catch {
    return false
  }
}

/** True when `dir` holds a `plugin.json` that declares an Agent Plugins version this reads. */
export function isAgentPlugin(dir: string): boolean {
  const file = join(dir, 'plugin.json')
  if (!existsSync(file)) return false
  const { value } = readJson(file)
  return isObject(value) && versionOf(value.$schema, 'plugin') !== null
}

// ── Agent Skills ─────────────────────────────────────────────

const SKILL_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
/** Fields assistants add that the spec does not define — said once, not as a fault. */
const CLIENT_SKILL_FIELDS = new Set([
  'argument-hint',
  'user-invocable',
  'disable-model-invocation',
  'model',
  'context',
  'agent',
  'hooks',
  'version',
])
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * One skill directory against the Agent Skills specification
 * (agentskills.io/specification). A client that follows it skips a skill
 * whose name does not match its directory, so that is an error, not style.
 */
export function checkSkill(dir: string): { name?: string; errors: string[]; warnings: string[] } {
  const where = `skills/${basename(dir)}/SKILL.md`
  const errors: string[] = []
  const warnings: string[] = []
  let text: string
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '')
  } catch (err) {
    return { errors: [`${where}: cannot be read — ${(err as Error).message}`], warnings }
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!m) return { errors: [`${where}: has no YAML frontmatter, so it has no name or description`], warnings }
  let meta: Record<string, unknown>
  try {
    meta = (parseYaml(m[1]) ?? {}) as Record<string, unknown>
  } catch (err) {
    return { errors: [`${where}: its frontmatter is not valid YAML — ${(err as Error).message}`], warnings }
  }
  const name = meta.name
  if (typeof name !== 'string' || name.length === 0) {
    errors.push(`${where}: has no name`)
  } else {
    if (name.length > 64 || !SKILL_NAME.test(name)) {
      errors.push(`${where}: name "${name}" must be 1–64 lowercase letters, digits and single hyphens, not starting or ending with one`)
    }
    if (name !== basename(dir)) {
      errors.push(`${where}: name "${name}" must match its directory, ${basename(dir)}/ — assistants that follow the spec skip it otherwise`)
    }
  }
  const description = meta.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    errors.push(`${where}: has no description, so no assistant can tell when to load it`)
  } else if (description.length > 1024) {
    errors.push(`${where}: description is ${description.length} characters; the limit is 1024`)
  }
  if (meta.compatibility !== undefined && (typeof meta.compatibility !== 'string' || meta.compatibility.length > 500)) {
    errors.push(`${where}: compatibility must be a string of at most 500 characters`)
  }
  if (meta.metadata !== undefined && !isStringMap(meta.metadata)) {
    errors.push(`${where}: metadata must map strings to strings`)
  }
  const unknown = Object.keys(meta).filter((k) => !SKILL_FIELDS.has(k) && !CLIENT_SKILL_FIELDS.has(k))
  if (unknown.length > 0) {
    warnings.push(`${where}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not an Agent Skills field' : 'are not Agent Skills fields'}; other assistants ignore ${unknown.length === 1 ? 'it' : 'them'}`)
  }
  const lines = m[2].split('\n').length
  if (lines > 500) warnings.push(`${where}: ${lines} lines; the spec recommends under 500, with detail in files the skill links to`)
  return { name: typeof name === 'string' ? name : undefined, errors, warnings }
}

// ── MCP servers ──────────────────────────────────────────────

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/** Why one `mcp.json` server entry is invalid, or null. */
export function serverProblem(key: string, raw: unknown): string | null {
  if (!isObject(raw)) return `server "${key}" is not an object`
  const allowed = (fields: string[]): string | null => {
    const extra = Object.keys(raw).filter((k) => !fields.includes(k))
    return extra.length > 0 ? `server "${key}" has ${extra.join(', ')}, which a ${String(raw.type)} server cannot have` : null
  }
  if (raw.type === 'stdio') {
    const bad = allowed(['type', 'command', 'args', 'env', 'cwd'])
    if (bad) return bad
    if (typeof raw.command !== 'string' || raw.command.length === 0) return `server "${key}" has no command`
    if (/\s/.test(raw.command)) return `server "${key}": command must be one executable, with its arguments in "args" — not "${raw.command}"`
    if (raw.command.includes('${')) return `server "${key}": command is not expanded, so it cannot use \${PLUGIN_ROOT}; write ./path/inside/the/plugin`
    if ((raw.command.includes('/') || raw.command.includes('\\')) && !raw.command.startsWith('./')) {
      return `server "${key}": a command inside the plugin must start with ./, and one on PATH must be a bare name`
    }
    if (raw.command.startsWith('./') && raw.command.split('/').includes('..')) return `server "${key}": command leaves the plugin`
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string'))) {
      return `server "${key}": args must be a list of strings`
    }
    if (raw.env !== undefined) {
      if (!isStringMap(raw.env)) return `server "${key}": env must map names to strings`
      const reserved = Object.keys(raw.env).find((n) => n === 'PLUGIN_ROOT' || n === 'PLUGIN_DATA')
      if (reserved) return `server "${key}": env cannot set ${reserved}; the client provides it`
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(raw.cwd)) {
        return `server "${key}": cwd must start with ./, \${PLUGIN_ROOT} or \${PLUGIN_DATA}`
      }
      if (raw.cwd.split('/').includes('..')) return `server "${key}": cwd leaves the plugin`
    }
    return null
  }
  if (raw.type === 'streamable-http' || raw.type === 'sse') {
    const bad = allowed(['type', 'url', 'headers'])
    if (bad) return bad
    if (typeof raw.url !== 'string') return `server "${key}" has no url`
    let url: URL
    try {
      url = new URL(raw.url)
    } catch {
      return `server "${key}": url ${raw.url} is not an absolute URL`
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return `server "${key}": url must be http or https`
    if (url.username || url.password) return `server "${key}": url must not carry a user or password`
    if (url.hash) return `server "${key}": url must not have a fragment`
    if (url.protocol === 'http:' && !LOOPBACK.test(url.hostname)) return `server "${key}": only a loopback server may use http; ${url.hostname} needs https`
    if (raw.headers !== undefined) {
      if (!isStringMap(raw.headers)) return `server "${key}": headers must map names to strings`
      const seen = new Set<string>()
      for (const h of Object.keys(raw.headers)) {
        if (seen.has(h.toLowerCase())) return `server "${key}": header ${h} is given twice`
        seen.add(h.toLowerCase())
      }
    }
    return null
  }
  return `server "${key}": type must be "stdio", "streamable-http" or "sse"`
}

// ── A whole plugin ───────────────────────────────────────────

/**
 * Read and check a plugin directory the way a conformant client loads it,
 * reporting what such a client would refuse, skip and ignore.
 */
export function readAgentPlugin(root: string): PluginReport {
  const report: PluginReport = { root, skills: [], servers: {}, errors: [], warnings: [] }
  const manifestFile = join(root, 'plugin.json')
  if (!existsSync(manifestFile)) {
    report.errors.push('plugin.json: missing — every Agent Plugin has one at its root')
    return report
  }
  if (!inside(root, manifestFile)) {
    report.errors.push('plugin.json: resolves outside the plugin')
    return report
  }
  const { value, error } = readJson(manifestFile)
  if (error !== undefined || !isObject(value)) {
    report.errors.push(`plugin.json: ${error ? `is not valid JSON — ${error}` : 'must be a JSON object'}`)
    return report
  }
  const version = versionOf(value.$schema, 'plugin')
  if (!version) {
    report.errors.push(`plugin.json: "$schema" must be ${pluginSchemaUrl()}`)
    return report
  }
  report.version = version
  const fatal: string[] = []
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 64 || !PLUGIN_NAME.test(value.name)) {
    fatal.push('"name" must be 1–64 lowercase letters, digits, hyphens and periods, starting and ending with a letter or digit, with no "--" or ".."')
  }
  for (const k of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (value[k] !== undefined && typeof value[k] !== 'string') fatal.push(`"${k}" must be a string`)
  }
  if (value.keywords !== undefined && !(Array.isArray(value.keywords) && value.keywords.every((k) => typeof k === 'string'))) {
    fatal.push('"keywords" must be a list of strings')
  }
  if (value.author !== undefined) {
    if (!isObject(value.author) || Object.keys(value.author).some((k) => !['name', 'email', 'url'].includes(k)) || !isStringMap(value.author)) {
      fatal.push('"author" may hold only name, email and url, each a string')
    }
  }
  if (fatal.length > 0) {
    report.errors.push(...fatal.map((f) => `plugin.json: ${f}`))
    return report
  }
  for (const k of Object.keys(value)) {
    if (!MANIFEST_FIELDS.includes(k)) {
      report.warnings.push(`plugin.json: "${k}" is not an Agent Plugins field; clients ignore it — client data belongs under "extensions"`)
    }
  }
  if (value.extensions !== undefined && (!isObject(value.extensions) || !Object.values(value.extensions).every(isObject))) {
    report.warnings.push('plugin.json: "extensions" must map namespaces to objects; clients ignore it as written')
  }
  if (typeof value.version === 'string' && !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value.version)) {
    report.warnings.push(`plugin.json: version "${value.version}" is not semantic versioning, which clients use to offer updates`)
  }
  report.manifest = value as unknown as PluginManifest

  // Skills: each immediate child of skills/ holding a SKILL.md.
  const skillsDir = join(root, 'skills')
  if (existsSync(skillsDir)) {
    if (!statSync(skillsDir).isDirectory() || !inside(root, skillsDir)) {
      report.errors.push('skills: is not a directory inside the plugin, so no skill loads')
    } else {
      for (const entry of readdirSync(skillsDir).sort()) {
        const dir = join(skillsDir, entry)
        if (!existsSync(join(dir, 'SKILL.md'))) continue
        if (!inside(root, join(dir, 'SKILL.md'))) {
          report.errors.push(`skills/${entry}/SKILL.md: resolves outside the plugin, so it is skipped`)
          continue
        }
        const skill = checkSkill(dir)
        report.errors.push(...skill.errors)
        report.warnings.push(...skill.warnings)
        if (skill.errors.length === 0 && skill.name) report.skills.push(skill.name)
      }
    }
  }

  // MCP servers: mcp.json, all or nothing at the file, one by one below it.
  const mcpFile = join(root, 'mcp.json')
  if (existsSync(mcpFile)) {
    const mcp = readJson(mcpFile)
    const mcpVersion = isObject(mcp.value) ? versionOf(mcp.value.$schema, 'mcp') : null
    if (mcp.error !== undefined || !isObject(mcp.value)) {
      report.errors.push(`mcp.json: ${mcp.error ? `is not valid JSON — ${mcp.error}` : 'must be a JSON object'}, so no server loads`)
    } else if (!mcpVersion) {
      report.errors.push(`mcp.json: "$schema" must be ${mcpSchemaUrl(version)}, so no server loads`)
    } else if (mcpVersion !== version) {
      report.errors.push(`mcp.json: targets Agent Plugins ${mcpVersion} while plugin.json targets ${version}, so no server loads`)
    } else if (!isObject(mcp.value.mcpServers) || Object.keys(mcp.value).some((k) => k !== '$schema' && k !== 'mcpServers')) {
      report.errors.push('mcp.json: must hold "$schema" and an "mcpServers" object and nothing else, so no server loads')
    } else {
      for (const [key, raw] of Object.entries(mcp.value.mcpServers)) {
        const problem = serverProblem(key, raw)
        if (problem) {
          report.errors.push(`mcp.json: ${problem}, so it is skipped`)
          continue
        }
        report.servers[key] = raw as PortableServer
        const secretish = Object.entries({ ...((raw as { env?: object }).env ?? {}), ...((raw as { headers?: object }).headers ?? {}) })
        for (const [field, val] of secretish) {
          if (typeof val === 'string' && /(?:^|\s)(?:Bearer\s+)?[A-Za-z0-9_\-.]{32,}$/.test(val) && !/^\$\{/.test(val)) {
            report.warnings.push(`mcp.json: server "${key}" sets ${field} to what looks like a credential — mcp.json is published with the plugin`)
          }
        }
      }
    }
  }

  // Claude Code's manifest, when one is kept beside the portable one.
  const claude = join(root, '.claude-plugin', 'plugin.json')
  if (existsSync(claude)) {
    const c = readJson(claude)
    if (isObject(c.value) && c.value.name !== value.name) {
      report.warnings.push(`.claude-plugin/plugin.json: names the plugin "${String(c.value.name)}" and plugin.json "${String(value.name)}" — Claude Code users and everyone else would install two different names`)
    }
  }
  if (/^(claude|anthropic|anthropics|cc-plugin)(-|$)/.test(String(value.name))) {
    report.warnings.push(`plugin.json: Claude Code reserves names like "${String(value.name)}" for Anthropic's own plugins`)
  }
  return report
}

// ── Claude Code, which reads its own manifest ────────────────

/** `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, in Claude Code's spelling. */
function claudeVars(s: string): string {
  return s.split('${PLUGIN_ROOT}').join('${CLAUDE_PLUGIN_ROOT}').split('${PLUGIN_DATA}').join('${CLAUDE_PLUGIN_DATA}')
}

/**
 * The `.claude-plugin/plugin.json` Claude Code reads, from the portable
 * manifest. Claude Code does not read a root `plugin.json`; without this a
 * Claude Code user installing the plugin gets it under whatever name the
 * marketplace entry gives it, and no version.
 */
export function claudeManifestFor(m: PluginManifest): Record<string, unknown> {
  return {
    name: m.name,
    ...(m.version && { version: m.version }),
    ...(m.description && { description: m.description }),
    // Claude Code requires a name in an author.
    ...(m.author?.name && { author: m.author }),
    ...(m.homepage && { homepage: m.homepage }),
    ...(m.repository && { repository: m.repository }),
    ...(m.license && { license: m.license }),
    ...(m.keywords && m.keywords.length > 0 && { keywords: m.keywords }),
  }
}

/**
 * The `.mcp.json` Claude Code reads from a plugin, from the portable
 * `mcp.json`: its own type names, and `${CLAUDE_PLUGIN_ROOT}` where the
 * portable format resolves `./` against the plugin.
 */
export function claudeMcpFor(servers: Record<string, PortableServer>): { mcpServers: Record<string, unknown> } {
  const out: Record<string, unknown> = {}
  for (const [key, s] of Object.entries(servers)) {
    if (s.type === 'stdio') {
      out[key] = {
        command: s.command.startsWith('./') ? `\${CLAUDE_PLUGIN_ROOT}/${s.command.slice(2)}` : s.command,
        ...(s.args && { args: s.args.map(claudeVars) }),
        ...(s.env && { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, claudeVars(v)])) }),
      }
    } else {
      out[key] = { type: s.type === 'sse' ? 'sse' : 'http', url: s.url, ...(s.headers && { headers: s.headers }) }
    }
  }
  return { mcpServers: out }
}

// ── A plugin as a team's layer ───────────────────────────────

/**
 * One portable server as a team server, for a plugin a project extends.
 *
 * `./` and `${PLUGIN_ROOT}` mean the plugin's directory; compiled into a
 * project's config they become its path from the project root, where every
 * assistant starts a project's servers. `${PLUGIN_DATA}` is a directory only an
 * assistant that installs the plugin itself provides, and legacy SSE is a
 * transport the generated configs do not carry — those servers are left out,
 * with the reason.
 */
export function teamServerFor(server: PortableServer, pluginPath: string): { server?: TeamMcpServer; skipped?: string } {
  const at = pluginPath === '' || pluginPath === '.' ? '.' : pluginPath.startsWith('.') ? pluginPath : `./${pluginPath}`
  if (server.type !== 'stdio') {
    if (server.type === 'sse') return { skipped: 'uses the legacy SSE transport, which OpenCastle does not compile; install the plugin in an assistant that reads it' }
    return { server: { type: 'http', url: server.url, ...(server.headers && { headers: server.headers }) } }
  }
  const all = [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {}), server.cwd ?? '']
  if (all.some((v) => v.includes('${PLUGIN_DATA}'))) {
    return { skipped: 'uses ${PLUGIN_DATA}, a directory only an assistant that installs the plugin itself provides' }
  }
  if (server.cwd && !/^(?:\.\/?|\$\{PLUGIN_ROOT\}\/?)$/.test(server.cwd)) {
    return { skipped: `runs in ${server.cwd}, and the assistants OpenCastle compiles for start servers in the project directory` }
  }
  const expand = (v: string): string => v.split('${PLUGIN_ROOT}').join(at)
  return {
    server: {
      type: 'stdio',
      command: server.command.startsWith('./') ? `${at}/${server.command.slice(2)}` : server.command,
      ...(server.args && { args: server.args.map(expand) }),
      ...(server.env && { env: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expand(v)])) }),
    },
  }
}

/** A plugin name from a package name: `@acme/ai-standard` → `acme.ai-standard`. */
export function pluginNameFrom(packageName: string): string {
  const name = packageName
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\//g, '.')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64)
    .replace(/[.-]+$/, '')
  return name || 'plugin'
}
