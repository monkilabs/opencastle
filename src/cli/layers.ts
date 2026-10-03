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
import { disallowedBy, hostDisallowedBy, findInlineSecret, emptyPolicy, globMatch, hostOfUrl, hostAllowedBy, type EffectivePolicy } from './policy.js'
import { LOCAL_DIRS } from './gitignore.js'
import { satisfies, parseVersion, compareVersions } from './version-range.js'
import { EXTENSION_NAMESPACE, isAgentPlugin, readAgentPlugin, teamServerFor } from './agent-plugin.js'
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
  envNamesIn,
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
  /**
   * For a baseline that is an Agent Plugin: the `dev.opencastle/` directory
   * holding everything but skills — instructions, agents, prompts, workflows
   * and `config.json`. Skills stay in the plugin's own `skills/`.
   */
  extensionRoot?: string
  /** Servers that came from a plugin's `mcp.json`, and the file to name for each. */
  serverWhere?: Record<string, string>
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
  /** Where links inside a team item may point; anything else is skipped. */
  within?: string[]
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

/**
 * Files an OS or a tool drops beside real content. Compiling them made the lock
 * differ between a Mac and CI — `.DS_Store` in a team skill changed its digest
 * and appeared as generated output on one machine only. Only these: a skill's
 * own `.env.example` or `.github/` template is content, and dropping every
 * dotfile lost them without a word.
 */
function isJunk(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._') || name === 'Thumbs.db' || name === 'desktop.ini' || name === '.git'
}

/**
 * Bytes as they mean the same on every machine: text with LF line endings.
 * Git on Windows checks text out with CRLF, and a digest over raw bytes then
 * called an unchanged baseline changed.
 */
export function canonicalBytes(buf: Buffer): Buffer {
  const head = buf.subarray(0, 8000)
  if (head.includes(0)) return buf
  const text = buf.toString('utf8')
  return text.includes('\r\n') ? Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8') : buf
}

function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function listDir(dir: string, within?: string[], onSkip?: (abs: string) => void): Array<{ name: string; isDir: boolean }> {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !isJunk(e.name))
      .filter((e) => {
        // A link out of the layer would copy whatever it points at — a system
        // file, another project — into every assistant's config.
        if (!within || !e.isSymbolicLink()) return true
        let inside = false
        try {
          const real = realpathSync(join(dir, e.name))
          inside = within.some((root) => isInside(root, real))
        } catch {
          inside = false
        }
        if (!inside) onSkip?.(join(dir, e.name))
        return inside
      })
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

/** The directories a layer's links may point into: itself, and the project. */
function allowedRoots(layer: Layer, projectRoot: string | null): string[] {
  const roots: string[] = []
  for (const r of [layer.root, projectRoot]) {
    if (!r) continue
    try {
      roots.push(realpathSync(r))
    } catch {
      roots.push(r)
    }
  }
  return roots
}

function scanLayer(layer: Layer, projectRoot: string | null): { items: ContentItem[]; issues: TeamIssue[] } {
  const items: ContentItem[] = []
  const issues: TeamIssue[] = []
  const dirs = layer.kind === 'core' ? CORE_DIR : LAYER_DIR
  const within = layer.kind === 'core' ? undefined : allowedRoots(layer, projectRoot)
  // Said, not silent: a skill linked in from elsewhere in a monorepo is a
  // reasonable thing to do, and vanishing from every assistant without a word
  // is the worst way to find out it is not followed.
  const skipped = (abs: string): void => {
    issues.push({
      level: 'warning',
      where: display(projectRoot, abs),
      message: 'is a link to somewhere outside this layer and the project, so it is not compiled',
      fix: 'copy it in, or publish it as a baseline and extend that',
    })
  }
  for (const kind of CONTENT_KINDS) {
    const dir = join(kind !== 'skills' && layer.extensionRoot ? layer.extensionRoot : layer.root, dirs[kind])
    for (const entry of listDir(dir, within, skipped)) {
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
      if (kind === 'skills' && within) filesUnder(join(dir, entry.name), within, skipped)
      items.push({ kind, name, layer: layer.id, path: join(dir, entry.name), ...(within && { within }) })
    }
  }
  return { items, issues }
}

/**
 * Every file under a directory, relative, sorted. A directory reached twice
 * through links is walked once, so a link loop ends instead of recursing.
 */
export function filesUnder(root: string, within?: string[], onSkip?: (abs: string) => void): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (dir: string, prefix: string): void => {
    let real = dir
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    for (const e of listDir(dir, within, onSkip)) {
      if (e.isDir) walk(join(dir, e.name), `${prefix}${e.name}/`)
      else out.push(`${prefix}${e.name}`)
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}

/**
 * A digest of what a layer contributes: its config and its content directories.
 *
 * An Agent Plugin keeps only its skills at the root; its servers are in
 * `mcp.json` and everything else in `dev.opencastle/`. Hashing the root alone
 * left all of that out, so an instruction edited without a version bump moved
 * nothing in the lock and `review` had nothing to say about it.
 */
function layerIntegrity(root: string, extensionRoot?: string): string {
  const hash = createHash('sha256')
  const own = [LAYER_CONFIG_FILE, ...CONTENT_KINDS.map((k) => LAYER_DIR[k])]
  const ext = extensionRoot ? relative(root, extensionRoot).split(sep).join('/') : null
  const parts = ext ? [...own, 'plugin.json', 'mcp.json', ...own.map((p) => `${ext}/${p}`)] : own
  for (const part of parts) {
    const abs = join(root, part)
    if (!existsSync(abs)) continue
    const files = statSync(abs).isDirectory() ? filesUnder(abs, [root]).map((f) => `${part}/${f}`) : [part]
    for (const f of files) {
      hash.update(f).update('\0').update(canonicalBytes(readFileSync(join(root, f)))).update('\0')
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

/** Where a package is found under `node_modules`, before any link is followed. */
function packageLink(name: string, fromDir: string): string | null {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
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
  // Where the layer is as the project sees it — `node_modules/@acme/x`, not
  // the store path a link resolves to — for paths written into its configs.
  let seenAt: string

  if (spec.startsWith('./') || spec.startsWith('../')) {
    root = resolve(fromDir, spec)
    seenAt = root
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      fail(`extends "${spec}", which is not a directory (looked in ${display(ctx.projectRoot, root)})`)
      return
    }
    id = display(ctx.projectRoot, root)
    configWhere = `${id}/${LAYER_CONFIG_FILE}`
    // These directories are gitignored as local run output, so a baseline kept
    // there works on one laptop and is missing from every clone and from CI.
    const ignored = LOCAL_DIRS.find((d) => isInside(join(ctx.projectRoot, d), root))
    if (ignored) {
      ctx.issues.push({
        level: 'warning',
        where: declaredIn,
        message: `extends "${spec}", inside ${ignored}/, which git ignores — no clone or CI run will have it`,
        fix: 'keep a shared baseline somewhere committed, e.g. a top-level directory or a package',
      })
    }
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
    const declared = decl && typeof decl === 'object' && 'baseline' in decl && typeof decl.baseline === 'string'
    // Any Agent Plugin published to npm can be extended as it is: its skills
    // and portable servers are what a baseline's are.
    if (!declared && !isAgentPlugin(pkgDir)) {
      fail(
        `extends "${spec}", which is neither an OpenCastle baseline nor an Agent Plugin`,
        `a baseline declares itself in its package.json: "opencastle": { "baseline": "." } (opencastle baseline init creates one); an Agent Plugin has a plugin.json at its root`,
      )
      return
    }
    root = declared ? resolve(pkgDir, (decl as { baseline: string }).baseline) : pkgDir
    const linked = packageLink(spec, fromDir)
    seenAt = linked ? resolve(linked, relative(pkgDir, root)) : root
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

  if (isAgentPlugin(root)) {
    const plugin = loadPluginLayer(root, seenAt, id, declaredIn, ctx)
    if (!plugin) return
    for (const inner of plugin.config.extends ?? []) {
      loadExtends(inner, plugin.extensionRoot, plugin.configFile, [...chain, real], ctx)
    }
    ctx.layers.push({ id, kind: 'baseline', root, version: version ?? plugin.version, integrity: layerIntegrity(root, plugin.extensionRoot), ...plugin })
    return
  }

  const { config, issues } = readLayerConfig(root, configWhere)
  ctx.issues.push(...issues)
  for (const inner of config.extends ?? []) {
    loadExtends(inner, root, configWhere, [...chain, real], ctx)
  }
  ctx.layers.push({ id, kind: 'baseline', root, version, config, configFile: configWhere, integrity: layerIntegrity(root) })
}

/**
 * A baseline that is an Agent Plugin: its skills in `skills/`, its portable
 * servers in `mcp.json`, and OpenCastle's own content and config in
 * `dev.opencastle/`. Returns null, having said why, for one a conformant
 * client would refuse.
 *
 * A server or skill a client would skip is reported, not fatal, as the
 * standard has it: one bad component does not stop the rest from loading.
 */
function loadPluginLayer(
  root: string,
  seenAt: string,
  id: string,
  declaredIn: string,
  ctx: ExtendsContext,
): { config: TeamConfig; configFile: string; extensionRoot: string; serverWhere: Record<string, string>; version?: string } | null {
  const report = readAgentPlugin(root)
  if (!report.manifest) {
    ctx.issues.push({
      level: 'error',
      where: declaredIn,
      message: `extends ${id}, which is not a valid Agent Plugin: ${report.errors[0] ?? 'its plugin.json cannot be read'}`,
      fix: `run opencastle plugin check on it`,
    })
    return null
  }
  // `skills/x/SKILL.md: name … must match` — the file, then what is wrong with it.
  for (const e of report.errors) {
    const at = e.indexOf(': ')
    ctx.issues.push({ level: 'warning', where: `${id}/${e.slice(0, at)}`, message: e.slice(at + 2) })
  }
  const extensionRoot = join(root, EXTENSION_NAMESPACE)
  const configFile = `${id}/${EXTENSION_NAMESPACE}/${LAYER_CONFIG_FILE}`
  const { config, issues } = readLayerConfig(extensionRoot, configFile)
  ctx.issues.push(...issues)
  const servers: Record<string, TeamMcpServer> = { ...(config.mcpServers ?? {}) }
  const serverWhere: Record<string, string> = {}
  const pluginPath = posix(relative(ctx.projectRoot, seenAt))
  for (const [key, portable] of Object.entries(report.servers)) {
    if (key in servers) {
      ctx.issues.push({
        level: 'error',
        where: `${id}/mcp.json`,
        message: `defines MCP server "${key}", which ${configFile} defines too`,
        fix: 'keep one: mcp.json for a server every assistant can start as it is, config.json for one that needs ${NAME} variables',
      })
      continue
    }
    const { server, skipped } = teamServerFor(portable, pluginPath)
    if (!server) {
      ctx.issues.push({ level: 'warning', where: `${id}/mcp.json`, message: `MCP server "${key}" ${skipped}` })
      continue
    }
    servers[key] = server
    serverWhere[key] = `${id}/mcp.json`
  }
  return {
    config: { ...config, ...(Object.keys(servers).length > 0 && { mcpServers: servers }) },
    configFile,
    extensionRoot,
    serverWhere,
    version: report.manifest.version,
  }
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
  // Every layer's version of every item, in layer order: what `require` needs
  // to tell "replaced what the baseline shipped" from "provided it, as asked".
  const history = new Map<string, ContentItem[]>()
  const remember = (k: string, item: ContentItem): void => {
    const list = history.get(k) ?? []
    list.push(item)
    history.set(k, list)
  }

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
    remember(key(item), item)
  }
  // Integration skills: each integration is an Agent Plugin, and its skill sits
  // where the standard puts one — `skills/<name>/SKILL.md`, named as its
  // directory is. They used to be compiled under the integration's id
  // (`skills/supabase/`) while their frontmatter said `supabase-database`, and
  // an assistant that follows the Agent Skills spec skips a skill whose name
  // does not match its directory.
  const pluginsRoot = getPluginsRoot(pkgRoot)
  const includedPlugins = stack ? getIncludedPluginIds(stack) : null
  for (const entry of listDir(pluginsRoot)) {
    if (!entry.isDir) continue
    const name = PLUGINS[entry.name]?.skillName
    if (!name) continue
    const skill = join(pluginsRoot, entry.name, 'skills', name, 'SKILL.md')
    if (!existsSync(skill)) continue
    if (includedPlugins && !includedPlugins.has(entry.name)) {
      stackOut.add(`skills/${name}`)
      continue
    }
    const k = `skills/${name}`
    const prev = items.get(k)
    const item: ContentItem = { kind: 'skills', name, layer: 'opencastle', path: skill, plugin: entry.name, ...(prev && { overrides: prev.layer }) }
    items.set(k, item)
    remember(k, item)
  }
  // `skills/supabase`, as a layer wrote it before integration skills took their
  // own names, still means the integration's skill.
  const integrationSkill = (ref: string): string | null => {
    const m = /^skills\/(.+)$/.exec(ref)
    const name = m ? PLUGINS[m[1]]?.skillName : undefined
    return name && name !== m![1] ? `skills/${name}` : null
  }

  const excluded: ResolvedSources['excluded'] = []
  for (const layer of layers) {
    if (layer.kind === 'core') continue
    const where = layer.configFile ?? layer.id
    for (const written of layer.config.exclude ?? []) {
      // Servers are excluded where servers are merged, below.
      if (written.startsWith('mcpServers/')) continue
      const renamed = items.has(written) ? null : integrationSkill(written)
      if (renamed) {
        issues.push({
          level: 'warning',
          where,
          message: `excludes ${written}; integration skills are named for what they teach now — this means ${renamed}`,
          fix: `write "${renamed}"`,
        })
      }
      const ref = renamed ?? written
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
      const placed = prev ? { ...item, overrides: prev.layer } : item
      items.set(key(item), placed)
      remember(key(item), placed)
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
    // What the requiring layer saw: the last version at or below it. If there
    // was one, nothing above may replace it; if there was none, the layer is
    // asking for it to be provided, and whoever provides it satisfies that.
    const at = layerIndex.get(by) ?? 0
    const asShipped = [...(history.get(ref) ?? [])].reverse().find((i) => (layerIndex.get(i.layer) ?? 0) <= at)
    if (asShipped && asShipped !== item && (layerIndex.get(item.layer) ?? 0) > at) {
      const from = asShipped.layer === 'opencastle' ? 'OpenCastle' : asShipped.layer
      issues.push({
        level: 'error',
        where: layers[layerIndex.get(item.layer) ?? 0].configFile ?? item.layer,
        message: `${item.layer} replaces ${ref} (from ${from}), which ${by} requires unchanged`,
        fix: `give yours another name and keep ${from}'s, or ask the owners of ${by}`,
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
  const blocked = new Map<string, string>()
  const excludedServers = new Map<string, string>()
  for (const layer of layers) {
    if (layer.kind === 'core') continue
    const where = layer.configFile ?? layer.id
    // A layer opts out of a server a layer below defines — or an integration
    // brings — by excluding it, as it excludes a skill.
    for (const ref of layer.config.exclude ?? []) {
      if (!ref.startsWith('mcpServers/')) continue
      const k = ref.slice('mcpServers/'.length)
      const known = servers.has(k) || Object.values(PLUGINS).some((p) => p.mcpServerKey === k)
      if (!known) {
        issues.push({
          level: 'warning',
          where,
          message: `excludes ${ref}, which no layer below defines and no integration brings`,
          fix: 'check the spelling — opencastle explain lists every MCP server',
        })
      }
      if (servers.has(k)) servers.delete(k)
      excludedServers.set(k, layer.id)
      excluded.push({ ref, by: layer.id, from: 'mcp' })
    }
    for (const [k, raw] of Object.entries(layer.config.mcpServers ?? {})) {
      const serverWhere = layer.serverWhere?.[k] ?? where
      const shape = checkServerShape(k, raw, serverWhere)
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
      servers.set(k, { key: k, from: layer.id, server, where: serverWhere })
      excludedServers.delete(k)
    }
  }
  for (const ts of [...servers.values()]) {
    const { key: k, server, where } = ts
    // Refused by a layer above the one that defines it: that layer is opting
    // out, and the server is left out like a refused integration. Refused by
    // the defining layer's own policy or one below it: the layer is breaking a
    // rule it is held to, and that is an error.
    const defining = layerIndex.get(ts.from) ?? 0
    const refusing = policy.allowLists.filter((l) => !l.patterns.some((p) => globMatch(p, k)))
    const url = serverTransport(server) === 'http' ? server.url : undefined
    const hostRefusing = url ? policy.hostLists.filter((l) => !hostAllowedBy(l.patterns, url)) : []
    const all = [...refusing, ...hostRefusing]
    if (all.length > 0 && all.every((l) => (layerIndex.get(l.by) ?? 0) > defining)) {
      servers.delete(k)
      blocked.set(k, refusing.length > 0 ? `not on the MCP allowlist of ${refusing.map((l) => l.by).join(', ')}` : `${hostOfUrl(url ?? '')} is not an allowed host for ${hostRefusing.map((l) => l.by).join(', ')}`)
      continue
    }
    if (refusing.length > 0) {
      const by = refusing.map((l) => l.by).join(', ')
      issues.push({
        level: 'error',
        where,
        message: `defines MCP server "${k}", which ${by} does not allow`,
        fix: `add it to policy.mcp.allow in ${by}, or remove it`,
      })
    }
    if (hostRefusing.length > 0) {
      const by = hostRefusing.map((l) => l.by).join(', ')
      issues.push({
        level: 'error',
        where,
        message: `MCP server "${k}" connects to ${hostOfUrl(url ?? '')}, a host ${by} does not allow`,
        fix: `add the host to policy.mcp.remoteHosts in ${by}, or remove the server`,
      })
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
  for (const [k, by] of excludedServers) blocked.set(k, `excluded by ${by}`)
  const includedServers = stack
    ? getIncludedMcpServers(stack, repoInfo)
    : new Set(Object.values(PLUGINS).map((p) => p.mcpServerKey).filter((k): k is string => Boolean(k)))
  for (const plugin of Object.values(PLUGINS)) {
    const k = plugin.mcpServerKey
    if (!k || !plugin.mcpConfig || !includedServers.has(k) || servers.has(k) || blocked.has(k)) continue
    const refused = disallowedBy(policy, k)
    if (refused) {
      blocked.set(k, `not on the MCP allowlist of ${refused}`)
      continue
    }
    if (plugin.mcpConfig.type === 'http' && plugin.mcpConfig.url) {
      const hostRefused = hostDisallowedBy(policy, plugin.mcpConfig.url)
      if (hostRefused) blocked.set(k, `${hostOfUrl(plugin.mcpConfig.url)} is not an allowed host for ${hostRefused}`)
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

/**
 * Throws when the running OpenCastle is older than the one that compiled the
 * project: what it would compile is not what the project has, so any answer it
 * gave — a review, an explanation — would describe the wrong thing.
 */
export function refuseOlderCli(pkgRoot: string, projectVersion: string): void {
  const running = cliVersionOf(pkgRoot)
  const mine = parseVersion(running)
  const theirs = parseVersion(projectVersion)
  if (mine && theirs && compareVersions(mine, theirs) < 0) {
    throw new Error(
      `this project was compiled by OpenCastle ${projectVersion}; this is ${running} — run npx opencastle@${projectVersion}, or add it to devDependencies`,
    )
  }
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
  /** VS Code inputs only the retired servers asked for. */
  retiredInputs?: string[]
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
  const lf = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(lf)
  if (fm) {
    // An instruction with a description and no `applyTo` is still an
    // instruction: every other target loads it always, so Copilot must too.
    if (kind === 'instructions' && !/^applyTo\s*:/m.test(fm[1])) {
      return `---\n${fm[1]}\napplyTo: '**'\n---\n${lf.slice(fm[0].length)}`
    }
    return lf
  }
  if (kind === 'instructions') {
    // Copilot loads `.github/instructions/*.instructions.md` only where
    // `applyTo` matches; the other targets load every instruction always.
    // Without this a team instruction reached six assistants and not the seventh.
    return `---\napplyTo: '**'\n---\n\n${lf}`
  }
  if (kind === 'agents') return `---\nname: '${name}'\n---\n\n${lf}`
  return lf
}

function copyTree(
  from: string,
  to: string,
  opts: { team: boolean; within?: string[]; transform?: (rel: string, text: string) => string } = { team: false },
): void {
  mkdirSync(to, { recursive: true })
  for (const rel of filesUnder(from, opts.within)) {
    const dest = join(to, rel)
    mkdirSync(dirname(dest), { recursive: true })
    const buf = readFileSync(join(from, rel))
    if (opts.transform && rel.endsWith('.md')) writeFileSync(dest, opts.transform(rel, buf.toString('utf8')))
    else writeFileSync(dest, opts.team ? canonicalBytes(buf) : buf)
  }
}

/**
 * Write the merged content to a scratch directory in the layout the adapters
 * read. The caller disposes it.
 */
export function materialize(
  resolved: ResolvedSources,
  pkgRoot: string,
  previousTeamServers: string[] = [],
  previousTeamVariables: string[] = [],
): CompileSource {
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
          copyTree(item.path, dest, {
            team,
            within: item.within,
            transform: team
              ? (rel, text) => (rel === 'SKILL.md' ? normaliseTeamText('skills', item.name, text) : text.replace(/\r\n/g, '\n'))
              : undefined,
          })
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
    mcp: mcpPlan(resolved, previousTeamServers, previousTeamVariables),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

/**
 * What the MCP writers do for the team: its servers, the ones a previous sync
 * wrote that no layer defines now (named by the committed lock), and the
 * integrations its policy refuses.
 */
export function mcpPlan(
  resolved: ResolvedSources,
  previousTeamServers: string[] = [],
  previousTeamVariables: string[] = [],
): TeamMcpPlan {
  const servers: Record<string, TeamMcpServer> = {}
  const used = new Set<string>()
  for (const [k, ts] of [...resolved.servers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    servers[k] = ts.server
    for (const v of [...Object.values(ts.server.env ?? {}), ...Object.values(ts.server.headers ?? {}), ...(ts.server.args ?? []), ts.server.url ?? '']) {
      for (const name of envNamesIn(v)) used.add(name)
    }
  }
  return {
    servers,
    retired: previousTeamServers.filter((k) => !(k in servers)).sort(),
    blocked: [...resolved.blocked.keys()].sort(),
    retiredInputs: previousTeamVariables.filter((v) => !used.has(v)).sort(),
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
      ts.server.command ?? '',
    ]) {
      for (const name of envNamesIn(value)) names.add(name)
    }
    for (const name of [...names].sort()) {
      // One entry per variable. Two servers reading the same token listed it
      // twice, and `init` wrote two `NAME=` lines to .env — where the empty
      // second one is what a dotenv loader keeps.
      const have = out.find((o) => o.envVar === name)
      if (have) {
        have.hint = `${have.hint}; also the ${ts.key} MCP server`
        continue
      }
      out.push({ server: ts.key, envVar: name, hint: `used by the ${ts.key} MCP server (${ts.where})` })
    }
  }
  return out
}
