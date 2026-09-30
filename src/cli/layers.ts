import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { PLUGINS } from '../orchestrator/plugins/index.js'
import { getOrchestratorRoot, getPluginsRoot } from './copy.js'
import { getExcludedSkills, getExcludedAgents, getIncludedPluginIds, getIncludedMcpServers, getRequiredMcpEnvVars } from './stack-config.js'
import { splitFrontmatter, parseFrontmatterString } from './adapters/frontmatter.js'
import { packageLaunch, isPinned } from './mcp-audit.js'
import { disallowedBy, hostDisallowedBy, findInlineSecret, emptyPolicy, type EffectivePolicy } from './policy.js'
import { satisfies } from './version-range.js'
import {
  CONTENT_KINDS,
  TEAM_CONFIG_REL,
  LAYER_CONFIG_FILE,
  parseTeamConfig,
  checkServerShape,
  serverTransport,
  type ContentKind,
  type TeamConfig,
  type TeamIssue,
  type TeamMcpServer,
} from './team-config.js'
import type { RepoInfo, StackConfig } from './types.js'

export type { EffectivePolicy } from './policy.js'

/**
 * Layered sources: OpenCastle's own content at the bottom, the baselines a
 * project extends above it, and the project's `.opencastle/` on top.
 *
 * Everything the adapters compile comes out of here as one directory in the
 * shape they have always read, so seven targets gain team content without
 * seven new code paths — and so what `sync`, `sync --check` and `review` see is
 * one resolution, not three that agree by luck.
 */

export type LayerKind = 'core' | 'baseline' | 'project'

export interface Layer {
  /** How it is named in output and in the lock: `opencastle`, a package name, a path, `project`. */
  id: string
  kind: LayerKind
  /** Absolute directory holding `skills/`, `agents/` and the rest. */
  root: string
  version?: string
  config: TeamConfig
  /** Where its config lives, as a person would find it. */
  configFile?: string
  /** A digest of the layer's content, so a baseline that changed without a version bump still shows. */
  integrity?: string
}

export interface ContentItem {
  kind: ContentKind
  name: string
  /** The id of the layer that provides it. */
  layer: string
  /** A file, or a skill's directory. */
  path: string
  /** The layer it replaced, when it replaced one. */
  overrides?: string
  /** The integration a plugin skill belongs to. */
  plugin?: string
}

export interface TeamServer {
  key: string
  /** The layer that defines it. */
  from: string
  server: TeamMcpServer
  /** Its config file, for messages. */
  where: string
}

export interface ResolvedSources {
  layers: Layer[]
  /** Keyed `kind/name`, e.g. `skills/testing-workflow`. */
  items: Map<string, ContentItem>
  excluded: Array<{ ref: string; by: string; from: string }>
  servers: Map<string, TeamServer>
  /** Plugin servers the stack includes but the team's policy does not allow, with why. */
  blocked: Map<string, string>
  policy: EffectivePolicy
  issues: TeamIssue[]
  cliVersion: string
}

/** Where a kind lives inside a layer, and inside the directory the adapters read. */
const LAYER_DIR: Record<ContentKind, string> = {
  instructions: 'instructions',
  agents: 'agents',
  skills: 'skills',
  prompts: 'prompts',
  workflows: 'workflows',
}
const CORE_DIR: Record<ContentKind, string> = { ...LAYER_DIR, workflows: 'agent-workflows' }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export function cliVersionOf(pkgRoot: string): string {
  try {
    return (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return '0.0.0'
  }
}

function posix(p: string): string {
  return p.split(sep).join('/')
}

/** A path as a person in the project would type it. */
function display(projectRoot: string | null, abs: string): string {
  if (!projectRoot) return abs
  const rel = posix(relative(projectRoot, abs))
  return rel === '' ? '.' : rel
}

/** The name an item goes by, from its file name. */
function itemName(kind: ContentKind, file: string): string | null {
  switch (kind) {
    case 'instructions':
      return file.endsWith('.md') ? file.replace(/(\.instructions)?\.md$/, '') : null
    case 'agents':
      return file.endsWith('.agent.md') ? file.slice(0, -'.agent.md'.length) : null
    case 'prompts':
      return file.endsWith('.md') ? file.replace(/(\.prompt)?\.md$/, '') : null
    case 'workflows':
      return file.endsWith('.md') && file !== 'README.md' ? file.slice(0, -3) : null
    case 'skills':
      return file
  }
}

/** Where an item is written in the directory the adapters compile from. */
export function compiledPath(kind: ContentKind, name: string): string {
  switch (kind) {
    case 'instructions':
      return `instructions/${name}.instructions.md`
    case 'agents':
      return `agents/${name}.agent.md`
    case 'prompts':
      return `prompts/${name}.prompt.md`
    case 'workflows':
      return `agent-workflows/${name}.md`
    case 'skills':
      return `skills/${name}`
  }
}

function listDir(dir: string): Array<{ name: string; isDir: boolean }> {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        let isDir = e.isDirectory()
        if (!isDir && e.isSymbolicLink()) {
          try {
            isDir = statSync(join(dir, e.name)).isDirectory()
          } catch {
            isDir = false
          }
        }
        return { name: e.name, isDir }
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return []
  }
}

function scanLayer(layer: Layer, projectRoot: string | null): { items: ContentItem[]; issues: TeamIssue[] } {
  const items: ContentItem[] = []
  const issues: TeamIssue[] = []
  const dirs = layer.kind === 'core' ? CORE_DIR : LAYER_DIR
  for (const kind of CONTENT_KINDS) {
    const dir = join(layer.root, dirs[kind])
    for (const entry of listDir(dir)) {
      if (kind === 'skills') {
        if (!entry.isDir) continue
        if (!existsSync(join(dir, entry.name, 'SKILL.md'))) {
          if (layer.kind !== 'core') {
            issues.push({
              level: 'warning',
              where: display(projectRoot, join(dir, entry.name)),
              message: 'has no SKILL.md, so it is not compiled',
            })
          }
          continue
        }
      } else if (entry.isDir) {
        continue
      }
      const name = itemName(kind, entry.name)
      if (name === null) continue
      if (!NAME.test(name)) {
        issues.push({
          level: 'warning',
          where: display(projectRoot, join(dir, entry.name)),
          message: 'is skipped: names are letters, digits, ".", "_" and "-"',
        })
        continue
      }
      items.push({ kind, name, layer: layer.id, path: join(dir, entry.name) })
    }
  }
  return { items, issues }
}

/** Every file under a directory, relative, sorted. */
export function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const e of listDir(dir)) {
      if (e.isDir) walk(join(dir, e.name), `${prefix}${e.name}/`)
      else out.push(`${prefix}${e.name}`)
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}

/** A digest of what a layer contributes: its config and its content directories. */
function layerIntegrity(root: string): string {
  const hash = createHash('sha256')
  const parts = [LAYER_CONFIG_FILE, ...CONTENT_KINDS.map((k) => LAYER_DIR[k])]
  for (const part of parts) {
    const abs = join(root, part)
    if (!existsSync(abs)) continue
    const files = statSync(abs).isDirectory() ? filesUnder(abs).map((f) => `${part}/${f}`) : [part]
    for (const f of files) {
      hash.update(f).update('\0').update(readFileSync(join(root, f))).update('\0')
    }
  }
  return `sha256-${hash.digest('base64')}`
}

/** `node_modules/<name>` from `fromDir` upwards, the way Node resolves a package. */
function findPackageDir(name: string, fromDir: string): string | null {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate)
      } catch {
        return candidate
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readLayerConfig(root: string, where: string): { config: TeamConfig; issues: TeamIssue[] } {
  const file = join(root, LAYER_CONFIG_FILE)
  if (!existsSync(file)) return { config: {}, issues: [] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { config: {}, issues: [{ level: 'error', where, message: `cannot be read — ${(err as Error).message}` }] }
  }
  const { config, issues } = parseTeamConfig(text, where)
  return { config: config ?? {}, issues }
}

interface ExtendsContext {
  projectRoot: string
  layers: Layer[]
  seen: Set<string>
  issues: TeamIssue[]
}

/**
 * Load one `extends` entry and, before it, everything it extends.
 *
 * A package is found the way Node finds one — `node_modules` from the
 * declaring layer upwards — so npm, pnpm, Yarn and workspaces all work, a git
 * dependency works, and the version is whatever the project's lockfile pinned.
 * OpenCastle fetches nothing itself: the package manager already does that
 * with integrity checks, private registries and upgrade bots, and a second
 * fetcher here would be a second supply chain.
 */
function loadExtends(
  spec: string,
  fromDir: string,
  declaredIn: string,
  chain: string[],
  ctx: ExtendsContext,
): void {
  const fail = (message: string, fix?: string): void => {
    ctx.issues.push({ level: 'error', where: declaredIn, message, ...(fix && { fix }) })
  }

  let root: string
  let id: string
  let version: string | undefined
  let configWhere: string

  if (spec.startsWith('./') || spec.startsWith('../')) {
    root = resolve(fromDir, spec)
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      fail(`extends "${spec}", which is not a directory (looked in ${display(ctx.projectRoot, root)})`)
      return
    }
    id = display(ctx.projectRoot, root)
    configWhere = `${id}/${LAYER_CONFIG_FILE}`
    try {
      version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version
    } catch {
      version = undefined
    }
  } else if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) {
    fail(
      `extends "${spec}", an absolute path — it is different on every machine and in CI`,
      `use a path relative to ${declaredIn} (starting with ./ or ../), or a package name`,
    )
    return
  } else {
    const versioned = /^((?:@[^/@]+\/)?[^/@]+)@(.+)$/.exec(spec)
    if (versioned) {
      fail(
        `extends "${spec}" — a package's version belongs in package.json, where your lockfile pins it`,
        `write "extends": ["${versioned[1]}"] and add "${versioned[1]}": "${versioned[2]}" to devDependencies`,
      )
      return
    }
    if (!PACKAGE_NAME.test(spec)) {
      fail(`extends "${spec}", which is neither a package name nor a path starting with ./ or ../`)
      return
    }
    const pkgDir = findPackageDir(spec, fromDir)
    if (!pkgDir) {
      fail(
        `extends "${spec}", which is not installed`,
        `add it to devDependencies and install (in CI, install dependencies before running opencastle)`,
      )
      return
    }
    let pkg: { version?: string; opencastle?: unknown }
    try {
      pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    } catch (err) {
      fail(`extends "${spec}", whose package.json cannot be read — ${(err as Error).message}`)
      return
    }
    const decl = pkg.opencastle as { baseline?: unknown } | undefined
    if (!decl || typeof decl !== 'object' || !('baseline' in decl) || typeof decl.baseline !== 'string') {
      fail(
        `extends "${spec}", which is not an OpenCastle baseline`,
        `a baseline declares itself in its package.json: "opencastle": { "baseline": "." } (opencastle baseline init creates one)`,
      )
      return
    }
    root = resolve(pkgDir, decl.baseline)
    if (relative(pkgDir, root).startsWith('..') || !existsSync(root)) {
      fail(`extends "${spec}", whose "opencastle.baseline" points outside the package or at nothing`)
      return
    }
    id = spec
    version = pkg.version
    configWhere = `${spec}/${posix(relative(pkgDir, join(root, LAYER_CONFIG_FILE)))}`
  }

  let real: string
  try {
    real = realpathSync(root)
  } catch {
    real = root
  }
  if (chain.includes(real)) {
    const names = [...chain.map((c) => display(ctx.projectRoot, c)), display(ctx.projectRoot, real)]
    fail(`extends itself in a cycle: ${names.join(' → ')}`)
    return
  }
  // A baseline reached twice — two others both extend it — is loaded once, at
  // the first place it appears, which is below everything that needs it.
  if (ctx.seen.has(real)) return
  ctx.seen.add(real)

  const { config, issues } = readLayerConfig(root, configWhere)
  ctx.issues.push(...issues)
  for (const inner of config.extends ?? []) {
    loadExtends(inner, root, configWhere, [...chain, real], ctx)
  }
  ctx.layers.push({ id, kind: 'baseline', root, version, config, configFile: configWhere, integrity: layerIntegrity(root) })
}

/** `${VAR}`, `${env:VAR}` and `{env:VAR}` all mean the same variable. */
export function normaliseRefs(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}').replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
}

export interface ResolveOptions {
  pkgRoot: string
  /** Null resolves OpenCastle's own content only — what an adapter compiles when called directly. */
  projectRoot: string | null
  stack?: StackConfig
  repoInfo?: RepoInfo
}

/**
 * Resolve every layer and merge them into one set of items, one MCP server
 * list and one policy. Never throws on bad input: problems come back as issues,
 * errors among them meaning "do not compile".
 */
export function resolveSources(opts: ResolveOptions): ResolvedSources {
  const { pkgRoot, projectRoot, stack, repoInfo } = opts
  const cliVersion = cliVersionOf(pkgRoot)
  const issues: TeamIssue[] = []

  const core: Layer = { id: 'opencastle', kind: 'core', root: getOrchestratorRoot(pkgRoot), version: cliVersion, config: {} }
  const layers: Layer[] = [core]

  let project: Layer | null = null
  if (projectRoot) {
    const root = join(projectRoot, '.opencastle')
    const { config, issues: configIssues } = readLayerConfig(root, TEAM_CONFIG_REL)
    issues.push(...configIssues)
    const ctx: ExtendsContext = { projectRoot, layers, seen: new Set(), issues }
    for (const spec of config.extends ?? []) loadExtends(spec, root, TEAM_CONFIG_REL, [], ctx)
    project = { id: 'project', kind: 'project', root, config, configFile: TEAM_CONFIG_REL }
    layers.push(project)
  }

  // ── Content ──────────────────────────────────────────────────
  const items = new Map<string, ContentItem>()
  const key = (i: { kind: ContentKind; name: string }): string => `${i.kind}/${i.name}`

  // OpenCastle's own content, less what the stack leaves out. Those are not
  // exclusions anyone wrote, so a team layer naming one is not a mistake.
  const stackOut = new Set<string>()
  const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
  const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()
  for (const item of scanLayer(core, projectRoot).items) {
    if (item.kind === 'skills' && excludedSkills.has(item.name)) {
      stackOut.add(key(item))
      continue
    }
    if (item.kind === 'agents' && excludedAgents.has(`${item.name}.agent.md`)) {
      stackOut.add(key(item))
      continue
    }
    items.set(key(item), item)
  }
  // Integration skills: one SKILL.md per included plugin.
  const pluginsRoot = getPluginsRoot(pkgRoot)
  const includedPlugins = stack ? getIncludedPluginIds(stack) : null
  for (const entry of listDir(pluginsRoot)) {
    if (!entry.isDir) continue
    const skill = join(pluginsRoot, entry.name, 'SKILL.md')
    if (!existsSync(skill)) continue
    if (includedPlugins && !includedPlugins.has(entry.name)) {
      stackOut.add(`skills/${entry.name}`)
      continue
    }
    const k = `skills/${entry.name}`
    const prev = items.get(k)
    items.set(k, { kind: 'skills', name: entry.name, layer: 'opencastle', path: skill, plugin: entry.name, ...(prev && { overrides: prev.layer }) })
  }

  const excluded: ResolvedSources['excluded'] = []
  for (const layer of layers) {
    if (layer.kind === 'core') continue
    const where = layer.configFile ?? layer.id
    for (const ref of layer.config.exclude ?? []) {
      const prev = items.get(ref)
      if (prev) {
        items.delete(ref)
        excluded.push({ ref, by: layer.id, from: prev.layer })
      } else if (!stackOut.has(ref) && !excluded.some((e) => e.ref === ref)) {
        issues.push({
          level: 'warning',
          where,
          message: `excludes ${ref}, which no layer below provides`,
          fix: 'check the spelling — opencastle explain lists everything that is compiled',
        })
      }
    }
    const scanned = scanLayer(layer, projectRoot)
    issues.push(...scanned.issues)
    for (const item of scanned.items) {
      const prev = items.get(key(item))
      items.set(key(item), prev ? { ...item, overrides: prev.layer } : item)
    }
  }

  // ── Policy ───────────────────────────────────────────────────
  const policy: EffectivePolicy = emptyPolicy()
  for (const layer of layers) {
    const where = layer.configFile ?? layer.id
    const p = layer.config.policy
    if (layer.config.opencastle) policy.versionRanges.push({ range: layer.config.opencastle, by: layer.id, where })
    if (!p) continue
    if (p.mcp?.allow) {
      // Allowing what a lower layer refuses has no effect, and saying nothing
      // would let someone believe they had allowed it.
      for (const pattern of p.mcp.allow) {
        if (pattern.includes('*')) continue
        const by = disallowedBy(policy, pattern)
        if (by) {
          issues.push({
            level: 'warning',
            where,
            message: `allows MCP server "${pattern}", but ${by} does not — the stricter list applies`,
            fix: `ask the owners of ${by} to allow it`,
          })
        }
      }
      policy.allowLists.push({ by: layer.id, where, patterns: p.mcp.allow })
    }
    if (p.mcp?.remoteHosts) policy.hostLists.push({ by: layer.id, where, patterns: p.mcp.remoteHosts })
    if (p.mcp?.requirePinned === true) policy.requirePinned ??= layer.id
    if (p.mcp?.requirePinned === false && policy.requirePinned) {
      issues.push({
        level: 'warning',
        where,
        message: `sets requirePinned to false, but ${policy.requirePinned} requires it — a layer can tighten policy, not relax it`,
      })
    }
    for (const ref of p.require ?? []) policy.require.push({ ref, by: layer.id })
    if (p.contextBudget && (!policy.contextBudget || p.contextBudget < policy.contextBudget.tokens)) {
      policy.contextBudget = { tokens: p.contextBudget, by: layer.id }
    }
  }

  const layerIndex = new Map(layers.map((l, i) => [l.id, i]))
  for (const { ref, by } of policy.require) {
    const byLayer = layers[layerIndex.get(by) ?? 0]
    const where = byLayer.configFile ?? by
    const item = items.get(ref)
    if (!item) {
      const ex = excluded.find((e) => e.ref === ref)
      issues.push(
        ex
          ? {
              level: 'error',
              where: layers[layerIndex.get(ex.by) ?? 0].configFile ?? ex.by,
              message: `excludes ${ref}, which ${by} requires`,
              fix: `remove it from "exclude", or ask the owners of ${by}`,
            }
          : { level: 'error', where, message: `requires ${ref}, which no layer provides` },
      )
      continue
    }
    if ((layerIndex.get(item.layer) ?? 0) > (layerIndex.get(by) ?? 0)) {
      issues.push({
        level: 'error',
        where: layers[layerIndex.get(item.layer) ?? 0].configFile ?? item.layer,
        message: `${item.layer} replaces ${ref}, which ${by} requires as it ships it`,
        fix: `give yours another name and keep the required one, or ask the owners of ${by}`,
      })
    }
  }

  // ── What team content must carry ─────────────────────────────
  for (const item of items.values()) {
    if (item.layer === 'opencastle') continue
    if (item.kind !== 'skills' && item.kind !== 'agents') continue
    const file = item.kind === 'skills' ? join(item.path, 'SKILL.md') : item.path
    let meta: Record<string, string> = {}
    try {
      meta = parseFrontmatterString(splitFrontmatter(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).frontmatter)
    } catch {
      meta = {}
    }
    if (!meta.description) {
      issues.push({
        level: 'warning',
        where: display(projectRoot, file),
        message:
          item.kind === 'skills'
            ? 'has no description in its frontmatter, so no assistant can tell when to load it'
            : 'has no description in its frontmatter, so the agent index has nothing to say about it',
        fix: 'add ---\\ndescription: "…"\\n--- at the top',
      })
    }
  }

  // ── Team MCP servers ─────────────────────────────────────────
  const servers = new Map<string, TeamServer>()
  for (const layer of layers) {
    if (layer.kind === 'core') continue
    const where = layer.configFile ?? layer.id
    for (const [k, raw] of Object.entries(layer.config.mcpServers ?? {})) {
      const shape = checkServerShape(k, raw, where)
      if (shape.length > 0) {
        issues.push(...shape)
        continue
      }
      const server: TeamMcpServer = {
        ...raw,
        ...(raw.args && { args: raw.args.map(normaliseRefs) }),
        ...(raw.url && { url: normaliseRefs(raw.url) }),
        ...(raw.env && { env: Object.fromEntries(Object.entries(raw.env).map(([n, val]) => [n, normaliseRefs(val)])) }),
        ...(raw.headers && {
          headers: Object.fromEntries(Object.entries(raw.headers).map(([n, val]) => [n, normaliseRefs(val)])),
        }),
      }
      servers.set(k, { key: k, from: layer.id, server, where })
    }
  }
  for (const ts of servers.values()) {
    const { key: k, server, where } = ts
    const refused = disallowedBy(policy, k)
    if (refused) {
      issues.push({
        level: 'error',
        where,
        message: `defines MCP server "${k}", which ${refused} does not allow`,
        fix: `add it to policy.mcp.allow in ${refused}, or remove it`,
      })
    }
    if (serverTransport(server) === 'http' && server.url) {
      const hostRefused = hostDisallowedBy(policy, server.url)
      if (hostRefused) {
        issues.push({
          level: 'error',
          where,
          message: `MCP server "${k}" connects to ${server.url}, a host ${hostRefused} does not allow`,
          fix: `add the host to policy.mcp.remoteHosts in ${hostRefused}, or remove the server`,
        })
      }
    }
    if (server.command) {
      const launch = packageLaunch(server.command, server.args ?? [])
      if (launch && !isPinned(launch)) {
        issues.push({
          level: policy.requirePinned ? 'error' : 'warning',
          where,
          message: `MCP server "${k}" runs ${launch.spec} without an exact version — every machine runs whatever was published last`,
          fix: `pin it as ${launch.name}@x.y.z${policy.requirePinned ? ` (${policy.requirePinned} requires pinned servers)` : ''}`,
        })
      }
    }
    const secret = findInlineSecret(server as unknown as Record<string, unknown>)
    if (secret) {
      issues.push({
        level: 'error',
        where,
        message: `MCP server "${k}" has a credential written into ${secret} — it would be committed to every assistant's config`,
        fix: 'put it in an environment variable and write "${NAME}" here',
      })
    }
  }

  // Integration servers the stack brings in that the policy refuses. Not an
  // error: the team chose the policy, and the integration's skill is still
  // useful without its server. They are left out and the lock says why.
  const blocked = new Map<string, string>()
  const includedServers = stack
    ? getIncludedMcpServers(stack, repoInfo)
    : new Set(Object.values(PLUGINS).map((p) => p.mcpServerKey).filter((k): k is string => Boolean(k)))
  for (const plugin of Object.values(PLUGINS)) {
    const k = plugin.mcpServerKey
    if (!k || !plugin.mcpConfig || !includedServers.has(k) || servers.has(k)) continue
    const refused = disallowedBy(policy, k)
    if (refused) {
      blocked.set(k, `not on the MCP allowlist of ${refused}`)
      continue
    }
    if (plugin.mcpConfig.type === 'http' && plugin.mcpConfig.url) {
      const hostRefused = hostDisallowedBy(policy, plugin.mcpConfig.url)
      if (hostRefused) blocked.set(k, `${new URL(plugin.mcpConfig.url).hostname} is not an allowed host for ${hostRefused}`)
    }
  }

  // ── The OpenCastle version the project asked for ─────────────
  for (const { range, by, where } of policy.versionRanges) {
    const ok = satisfies(cliVersion, range)
    if (ok === null) {
      issues.push({ level: 'error', where, message: `"opencastle": "${range}" is not a version range this release can read` })
    } else if (!ok) {
      issues.push({
        level: 'error',
        where,
        message: `${by === 'project' ? 'this project' : by} needs OpenCastle ${range}; this is ${cliVersion}`,
        fix: `run the version the project pins — add opencastle to devDependencies and use npx opencastle, or run npx opencastle@"${range}"`,
      })
    }
  }

  return { layers, items, excluded, servers, blocked, policy, issues, cliVersion }
}

export function hasErrors(resolved: ResolvedSources): boolean {
  return resolved.issues.some((i) => i.level === 'error')
}

/** True when anything beyond OpenCastle's own content is in play. */
export function usesTeamSources(resolved: ResolvedSources): boolean {
  return (
    resolved.layers.some((l) => l.kind === 'baseline') ||
    [...resolved.items.values()].some((i) => i.layer !== 'opencastle') ||
    resolved.excluded.length > 0 ||
    resolved.servers.size > 0 ||
    resolved.layers.some((l) => Object.keys(l.config).some((k) => k !== '$schema'))
  )
}

// ── Materialising the merged source ────────────────────────────

/** What the MCP writers need beyond the plugin servers. */
export interface TeamMcpPlan {
  /** Servers the team's layers define, written into every target. */
  servers: Record<string, TeamMcpServer>
  /** Servers a previous sync wrote for the team that no layer defines any more. */
  retired: string[]
  /** Integration servers the policy refuses; never written, removed if present. */
  blocked: string[]
}

export interface CompileSource {
  /** A directory shaped like `src/orchestrator/`, holding the merged content. */
  root: string
  resolved: ResolvedSources
  mcp: TeamMcpPlan
  dispose(): void
}

/** Team files as the adapters expect them: LF line endings, and frontmatter where a target needs it. */
function normaliseTeamText(kind: ContentKind, name: string, text: string): string {
  const lf = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const hasFrontmatter = /^---\n[\s\S]*?\n---\n/.test(lf)
  if (hasFrontmatter) return lf
  if (kind === 'instructions') {
    // Copilot loads `.github/instructions/*.instructions.md` only where
    // `applyTo` matches; the other targets load every instruction always.
    // Without this a team instruction reached six assistants and not the seventh.
    return `---\napplyTo: '**'\n---\n\n${lf}`
  }
  if (kind === 'agents') return `---\nname: '${name}'\n---\n\n${lf}`
  return lf
}

function copyTree(from: string, to: string, transform?: (rel: string, text: string) => string): void {
  mkdirSync(to, { recursive: true })
  for (const rel of filesUnder(from)) {
    const dest = join(to, rel)
    mkdirSync(dirname(dest), { recursive: true })
    const buf = readFileSync(join(from, rel))
    if (transform && rel.endsWith('.md')) writeFileSync(dest, transform(rel, buf.toString('utf8')))
    else writeFileSync(dest, buf)
  }
}

/**
 * Write the merged content to a scratch directory in the layout the adapters
 * read. The caller disposes it.
 */
export function materialize(resolved: ResolvedSources, pkgRoot: string, previousTeamServers: string[] = []): CompileSource {
  const root = mkdtempSync(join(tmpdir(), 'opencastle-src-'))
  try {
    const coreRoot = getOrchestratorRoot(pkgRoot)
    const copilot = join(coreRoot, 'copilot-instructions.md')
    if (existsSync(copilot)) writeFileSync(join(root, 'copilot-instructions.md'), readFileSync(copilot))
    for (const kind of CONTENT_KINDS) mkdirSync(join(root, CORE_DIR[kind]), { recursive: true })

    for (const item of resolved.items.values()) {
      const dest = join(root, compiledPath(item.kind, item.name))
      const team = item.layer !== 'opencastle'
      if (item.kind === 'skills') {
        if (item.plugin) {
          mkdirSync(dest, { recursive: true })
          writeFileSync(join(dest, 'SKILL.md'), readFileSync(item.path))
        } else {
          copyTree(item.path, dest, team ? (rel, text) => (rel === 'SKILL.md' ? normaliseTeamText('skills', item.name, text) : text.replace(/\r\n/g, '\n')) : undefined)
        }
        continue
      }
      const buf = readFileSync(item.path)
      writeFileSync(dest, team ? normaliseTeamText(item.kind, item.name, buf.toString('utf8')) : buf)
    }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }

  return {
    root,
    resolved,
    mcp: mcpPlan(resolved, previousTeamServers),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

/**
 * What the MCP writers do for the team: its servers, the ones a previous sync
 * wrote that no layer defines now (named by the committed lock), and the
 * integrations its policy refuses.
 */
export function mcpPlan(resolved: ResolvedSources, previousTeamServers: string[] = []): TeamMcpPlan {
  const servers: Record<string, TeamMcpServer> = {}
  for (const [k, ts] of [...resolved.servers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    servers[k] = ts.server
  }
  return {
    servers,
    retired: previousTeamServers.filter((k) => !(k in servers)).sort(),
    blocked: [...resolved.blocked.keys()].sort(),
  }
}

/**
 * OpenCastle's own content for a stack, with nothing from any project. What an
 * adapter compiles when it is called without a source — the tests, mostly.
 */
export function defaultSource(pkgRoot: string, stack?: StackConfig): CompileSource {
  return materialize(resolveSources({ pkgRoot, projectRoot: null, stack }), pkgRoot)
}

/** Run `fn` with the caller's source, or a default one that is cleaned up after. */
export async function withSource<T>(
  pkgRoot: string,
  stack: StackConfig | undefined,
  source: CompileSource | undefined,
  fn: (src: CompileSource) => Promise<T>,
): Promise<T> {
  if (source) return fn(source)
  const own = defaultSource(pkgRoot, stack)
  try {
    return await fn(own)
  } finally {
    own.dispose()
  }
}

/** Issues rendered for a terminal, one per line pair. */
export function formatIssues(issues: TeamIssue[]): string[] {
  const out: string[] = []
  for (const i of issues) {
    out.push(`${i.level === 'error' ? '✗' : '!'} ${i.where}: ${i.message}`)
    if (i.fix) out.push(`  → ${i.fix}`)
  }
  return out
}

/**
 * The environment variables the servers this project will actually write need:
 * the integrations' (less any the team's policy refused or its layers
 * replaced), and every `${NAME}` a team server refers to.
 */
export function requiredEnvVars(
  resolved: ResolvedSources | undefined,
  stack: StackConfig,
  repoInfo?: RepoInfo,
): Array<{ server: string; envVar: string; hint: string }> {
  const out = getRequiredMcpEnvVars(stack, repoInfo).filter(
    (r) => !resolved || (!resolved.blocked.has(r.server) && !resolved.servers.has(r.server)),
  )
  for (const ts of resolved?.servers.values() ?? []) {
    const names = new Set<string>()
    for (const value of [
      ...Object.values(ts.server.env ?? {}),
      ...Object.values(ts.server.headers ?? {}),
      ...(ts.server.args ?? []),
      ts.server.url ?? '',
    ]) {
      for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1])
    }
    for (const name of [...names].sort()) {
      out.push({ server: ts.key, envVar: name, hint: `used by the ${ts.key} MCP server (${ts.where})` })
    }
  }
  return out
}
