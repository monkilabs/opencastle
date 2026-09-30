import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { PLUGINS } from '../orchestrator/plugins/index.js'
import { getMcpConfigRelPath, upgradeGeneratedServers, canonicalJson } from './mcp.js'
import type { IdeChoice } from './types.js'
import { disallowedBy, hostDisallowedBy, findInlineSecret, type EffectivePolicy } from './policy.js'

/**
 * What a project's MCP config actually launches, read the way a supply-chain
 * review would read it.
 *
 * An MCP server is code an agent runs with the developer's credentials, and the
 * usual way to launch one — `npx -y some-server@latest` — installs whatever was
 * published most recently, on every machine, with no review and no lockfile.
 * `-y` is not even what makes it unattended: npx assumes yes whenever stdin is
 * not a terminal, which is how every assistant starts a server. OWASP lists
 * this as agentic supply-chain risk (ASI04). A team wants the opposite: the same
 * server version on every laptop and in CI, changed in a reviewed diff.
 *
 * Three things are reported, from least to most serious:
 * - a package run without an exact version (`@latest`, a range, or none);
 * - a package that does not exist on npm — the server cannot start, and a name
 *   that was unpublished can be registered by anyone;
 * - a remote server in `.mcp.json` with no `"type"`, which Claude Code reads as
 *   a stdio server with no command, so it never loads.
 *
 * What it cannot read it says so. An all-clear that counted a container image
 * or an unparsed command line as "pinned" would be the false assurance this
 * exists to replace.
 */

export type McpProblem =
  | 'unpinned'
  | 'nonexistent'
  | 'untyped-remote'
  | 'inline-secret'
  | 'not-allowed'
  | 'host-not-allowed'

/** What `opencastle sync` will do to an entry. */
export type SyncEffect = 'replaces' | 'removes' | 'keeps'

export interface McpFinding {
  server: string
  problem: McpProblem
  /** The package spec or URL the finding is about, as written. */
  subject: string
  /** The package name, for findings about a package. */
  pkg?: string
  /**
   * `replaces`: still exactly as a release wrote it, so sync moves it forward.
   * `removes`: a plugin's server the project's stack no longer includes.
   * `keeps`: edited since, or never ours — only a person changes it.
   * A remedy that says "run sync" is only true for the first.
   */
  sync: SyncEffect
  /** The plugin that owns this server key, if one does. */
  plugin?: string
  /** The team layer that defines this server, if one does — its config file. */
  team?: string
  /** For `removes`: whose decision the removal is. */
  removal?: 'stack' | 'policy' | 'retired'
  /** For policy findings: the layers whose policy refuses it. */
  refusedBy?: string
}

/**
 * The team's side of the audit: what its layers define, what they retired,
 * and the policy every entry is held to — hand-added ones included.
 */
export interface TeamAuditContext {
  /** Server entries exactly as `sync` writes them into this target. */
  expected: Record<string, unknown>
  /** Server key → the config file that defines it. */
  definedIn: Record<string, string>
  /** Servers a previous sync wrote for the team that no layer defines now. */
  retired: string[]
  /** Integration servers the policy refuses, with why. */
  blocked: Map<string, string>
  policy: EffectivePolicy
}

export interface McpAudit {
  findings: McpFinding[]
  /** Servers `sync` would move to the current default, problem or not. */
  outdated: string[]
  /** Plugin servers the stack no longer includes, which `sync` deletes. */
  removed: string[]
  /** Integration servers the team's policy refuses, which `sync` deletes. */
  blockedByPolicy: string[]
  /** Team servers no layer defines any more, which `sync` deletes. */
  retired: string[]
  /** Servers whose launch was read and passed. */
  passed: number
  /** Servers that launch something this audit cannot read, with why. */
  unaudited: Array<{ server: string; why: string }>
}

/**
 * Packages earlier releases of this tool wrote into configs that do not exist
 * on npm. Kept here, by name, because an install from before the fix still has
 * them until its next `sync` — and a hand-copied config has them for good.
 */
export const NONEXISTENT_PACKAGES: Record<string, string> = {
  'netlify-mcp': 'unpublished from npm in January 2026, so the name can be claimed by anyone',
  '@anthropic/figma-mcp': 'never published on npm',
  '@anthropic/prisma-mcp': 'never published on npm',
}

/** Runners that fetch a package from a registry and execute it. */
const RUNNERS: Record<string, string[]> = {
  npx: [],
  npm: ['exec'],
  bunx: [],
  pnpm: ['dlx'],
  yarn: ['dlx'],
  uvx: [],
  pipx: ['run'],
}

/** Runners from the Python ecosystem, whose specs pin with `==`. */
const PYTHON_RUNNERS = new Set(['uvx', 'pipx'])

/** Container runtimes: they fetch code too, and this audit does not read images. */
const CONTAINER_RUNTIMES = new Set(['docker', 'podman'])

/** Flags that take no value, so the next token may be the package. */
const VALUELESS_FLAGS = new Set(['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '--silent', '--ignore-existing'])

/** Flags followed by a value that is not the package. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  default: new Set(['--registry', '--cache', '--userconfig', '--prefix', '--node-options', '--workspace', '-w']),
  uvx: new Set(['--python', '-p', '--with', '--index', '--index-url', '--extra-index-url', '--python-preference']),
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export interface PackageLaunch {
  /** The spec as written, e.g. `@playwright/mcp@0.0.83`. */
  spec: string
  name: string
  /** The version part, or null when there is none. */
  version: string | null
  /**
   * `npx --no` refuses to download anything, so it runs the copy the project
   * already depends on — pinned by the project's own lockfile.
   */
  localOnly: boolean
}

function binName(command: string): string {
  // Split on both separators: a config written on Windows says `C:\tools\npx.cmd`,
  // and `basename` only knows the separator of the machine running the check.
  return (command.split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe)$/i, '').toLowerCase()
}

/**
 * The command line with any `cmd /c` wrapper removed.
 *
 * Claude Code's documented form for an npx server on Windows is
 * `"command": "cmd", "args": ["/c", "npx", ...]`. Reading `cmd` as the command
 * meant the package behind it was never audited at all.
 */
export function unwrapShell(command: string, args: string[]): { command: string; args: string[] } {
  if (binName(command) === 'cmd' && args.length >= 2 && /^\/c$/i.test(args[0])) {
    return { command: args[1], args: args.slice(2) }
  }
  return { command, args }
}

/**
 * The registry package a command line fetches and runs.
 *
 * `null` when it runs none (a local script), or when the line uses an option
 * this parser does not know — see `auditMcpConfig` for how that is reported.
 */
export function packageLaunch(rawCommand: string, rawArgs: string[]): PackageLaunch | null {
  const { command, args } = unwrapShell(rawCommand, rawArgs)
  const bin = binName(command)
  const lead = RUNNERS[bin]
  if (!lead) return null
  if (lead.some((word, i) => args[i] !== word)) return null
  const rest = args.slice(lead.length)
  const python = PYTHON_RUNNERS.has(bin)
  const valueFlags = python ? VALUE_FLAGS.uvx : VALUE_FLAGS.default

  // Only flags *before* the package are the runner's. Everything after it is
  // passed to the server, so `npx -y foo@latest --no` is not project-local.
  let localOnly = false
  let spec: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (python && (arg === '--from' || arg === '--spec')) {
      spec = rest[i + 1]
      break
    }
    if (!python && (arg === '-p' || arg === '--package')) {
      spec = rest[i + 1]
      break
    }
    if (arg.startsWith('--package=') || arg.startsWith('--from=') || arg.startsWith('--spec=')) {
      spec = arg.slice(arg.indexOf('=') + 1)
      break
    }
    if (arg === '--') {
      spec = rest[i + 1]
      break
    }
    // `-c` runs a shell string, not a package; nothing here to name.
    if (arg === '-c' || arg === '--call') return null
    if (arg.startsWith('-')) {
      if (VALUELESS_FLAGS.has(arg)) {
        if (arg === '--no' || arg === '--no-install') localOnly = true
        continue
      }
      if (valueFlags.has(arg)) {
        i++
        continue
      }
      if (arg.includes('=')) continue
      // An option we do not know may take a value; stop rather than guess.
      return null
    }
    spec = arg
    break
  }
  if (!spec) return null
  // A path, a URL or a git spec is not a registry package, and pinning advice
  // about it would be wrong.
  if (/^(\.|\/|~|file:|git\+|git:|https?:|github:)/.test(spec)) return null

  let name = spec
  let version: string | null = null
  const eq = spec.indexOf('==')
  if (python && eq > 0) {
    name = spec.slice(0, eq)
    version = spec.slice(eq + 2)
  } else {
    const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@')
    if (at > 0) {
      name = spec.slice(0, at)
      version = spec.slice(at + 1)
    }
  }
  return { spec, name, version, localOnly: (bin === 'npx' || bin === 'npm') && localOnly }
}

/** True when the launch always runs the same code. */
export function isPinned(launch: PackageLaunch): boolean {
  return launch.localOnly || (launch.version !== null && EXACT_VERSION.test(launch.version))
}

/** Every server entry in a parsed MCP config, whatever the target's dialect. */
function serverEntries(config: unknown): Array<[string, Record<string, unknown>]> {
  if (!config || typeof config !== 'object') return []
  const out: Array<[string, Record<string, unknown>]> = []
  for (const key of ['servers', 'mcpServers', 'mcp']) {
    const container = (config as Record<string, unknown>)[key]
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue
    for (const [name, entry] of Object.entries(container as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        out.push([name, entry as Record<string, unknown>])
      }
    }
  }
  return out
}

/** The command line an entry launches: `command` + `args`, or OpenCode's array. */
function commandLine(entry: Record<string, unknown>): { command: string; args: string[] } | null {
  const { command, args } = entry
  if (Array.isArray(command) && command.length > 0 && command.every((p) => typeof p === 'string')) {
    return { command: command[0] as string, args: (command as string[]).slice(1) }
  }
  if (typeof command === 'string') {
    const list = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
    return { command, args: list }
  }
  return null
}

/**
 * Read one parsed config. `ide` decides which dialect rules apply; `included`
 * is the set of plugin servers the project's stack includes — the same set a
 * rebuild uses, so what this predicts about `sync` is what `sync` does. Without
 * it, every plugin server present is treated as included.
 *
 * `team` adds what the project's layers decide: the servers they define (which
 * `sync` keeps exactly as defined), the ones they retired, and the policy every
 * entry is held to, including entries nobody generated.
 */
export function auditMcpConfig(
  config: unknown,
  ide: IdeChoice,
  included?: Set<string>,
  team?: TeamAuditContext,
): McpAudit {
  const pluginByKey = new Map(
    Object.values(PLUGINS)
      .filter((p) => p.mcpServerKey)
      .map((p) => [p.mcpServerKey as string, p.id]),
  )
  const audit: McpAudit = {
    findings: [],
    outdated: [],
    removed: [],
    blockedByPolicy: [],
    retired: [],
    passed: 0,
    unaudited: [],
  }
  const present = new Set<string>()
  for (const [server, entry] of serverEntries(config)) {
    present.add(server)
    const plugin = pluginByKey.get(server)
    const teamWhere = team?.definedIn[server]
    let sync: SyncEffect = 'keeps'
    let removal: McpFinding['removal']
    if (teamWhere && team) {
      // A team server is compiled output: `sync` writes it exactly as the layer
      // defines it, so any difference is one `sync` removes.
      if (canonicalJson(entry) !== canonicalJson(team.expected[server])) sync = 'replaces'
    } else if (team?.retired.includes(server)) {
      sync = 'removes'
      removal = 'retired'
    } else if (plugin) {
      if (team?.blocked.has(server)) {
        sync = 'removes'
        removal = 'policy'
      } else if (included && !included.has(server)) {
        sync = 'removes'
        removal = 'stack'
      } else if (upgradeGeneratedServers({ [server]: structuredClone(entry) }, ide, new Set([server])).length > 0) {
        sync = 'replaces'
      }
    }
    if (sync === 'replaces') audit.outdated.push(server)
    if (removal === 'stack') audit.removed.push(server)
    if (removal === 'policy') audit.blockedByPolicy.push(server)
    if (removal === 'retired') audit.retired.push(server)
    const base = {
      server,
      sync,
      ...(plugin ? { plugin } : {}),
      ...(teamWhere ? { team: teamWhere } : {}),
      ...(removal ? { removal } : {}),
    }

    // Policy, for every entry: a server the team does not allow is a finding
    // wherever it came from — the hand-added ones are the reason to have one.
    let refused = false
    if (team) {
      const by = disallowedBy(team.policy, server)
      if (by) {
        audit.findings.push({ ...base, problem: 'not-allowed', subject: server, refusedBy: by })
        refused = true
      }
      const url = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : null
      if (url && !refused) {
        const hostBy = hostDisallowedBy(team.policy, url)
        if (hostBy) {
          audit.findings.push({ ...base, problem: 'host-not-allowed', subject: url, refusedBy: hostBy })
          refused = true
        }
      }
    }
    // A credential in a committed file is a leak however the server launches.
    const secretAt = findInlineSecret(entry)
    if (secretAt) {
      audit.findings.push({ ...base, problem: 'inline-secret', subject: secretAt })
      refused = true
    }

    const line = commandLine(entry)
    if (line) {
      const { command, args } = unwrapShell(line.command, line.args)
      const bin = binName(command)
      if (CONTAINER_RUNTIMES.has(bin)) {
        // A digest names exactly one image. A tag — `:latest` or `:1.2` — can be
        // moved, and reading where the image sits among docker's own options is
        // beyond this check, so anything else is reported, not passed.
        if (args.some((a) => /@sha256:[0-9a-f]{64}$/.test(a))) {
          if (!refused) audit.passed++
        } else audit.unaudited.push({ server, why: 'container image without a digest' })
        continue
      }
      const launch = packageLaunch(command, args)
      if (!launch) {
        // A runner we could not read is not a pass. A plain command — `node
        // tools/mcp.js` — fetches nothing, and is the project's own code.
        if (RUNNERS[bin]) audit.unaudited.push({ server, why: `${bin} options this check does not read` })
        else if (!refused) audit.passed++
        continue
      }
      if (NONEXISTENT_PACKAGES[launch.name]) {
        audit.findings.push({ ...base, problem: 'nonexistent', subject: launch.spec, pkg: launch.name })
      } else if (!isPinned(launch)) {
        audit.findings.push({ ...base, problem: 'unpinned', subject: launch.spec, pkg: launch.name })
      } else if (!refused) {
        audit.passed++
      }
      continue
    }
    if (ide === 'claude-code' && typeof entry.url === 'string' && entry.type === undefined) {
      audit.findings.push({ ...base, problem: 'untyped-remote', subject: entry.url })
      continue
    }
    if (!refused) audit.passed++
  }
  // A team server missing from the file is one `sync` adds.
  for (const server of Object.keys(team?.expected ?? {})) {
    if (!present.has(server)) audit.outdated.push(server)
  }
  return audit
}

/** Whether a finding fails the check, given the policy in force. */
export function isFailure(f: McpFinding, policy?: EffectivePolicy): boolean {
  return f.problem !== 'unpinned' || Boolean(policy?.requirePinned)
}

/** One finding in words, saying so when it fails only because the team requires pinning. */
export function describeFindingUnder(f: McpFinding, policy?: EffectivePolicy): string {
  if (f.problem === 'unpinned' && policy?.requirePinned) {
    return `${f.server}: ${f.subject} is not pinned to an exact version, which ${policy.requirePinned} requires`
  }
  return describeFinding(f)
}

/** One finding in words. */
export function describeFinding(f: McpFinding): string {
  switch (f.problem) {
    case 'nonexistent':
      return `${f.server}: ${f.subject} was ${NONEXISTENT_PACKAGES[f.pkg ?? ''] ?? 'not found on npm'}`
    case 'untyped-remote':
      return `${f.server}: no "type" — Claude Code reads it as a stdio server, so it never loads`
    case 'unpinned':
      return `${f.server}: ${f.subject}`
    case 'inline-secret':
      return `${f.server}: a credential is written into ${f.subject} — it is committed with the file`
    case 'not-allowed':
      return `${f.server}: not on the MCP allowlist of ${f.refusedBy}`
    case 'host-not-allowed':
      return `${f.server}: ${f.subject} is not an allowed host for ${f.refusedBy}`
  }
}

/**
 * The remedy that works for each finding, joined.
 *
 * Only `sync` can clear what it wrote, and only while nobody has edited it.
 * Saying "run sync" over an entry someone changed would send them to a command
 * that, correctly, will not touch it; and over a server the stack no longer
 * includes it would not fix the entry but delete it.
 */
export function remedyFor(list: McpFinding[], rel: string): string {
  const names = (pick: (f: McpFinding) => boolean) =>
    [...new Set(list.filter(pick).map((f) => f.server))].join(', ')
  const parts: string[] = []
  const replaced = names((f) => f.sync === 'replaces' && !f.team)
  const rewritten = names((f) => f.sync === 'replaces' && Boolean(f.team))
  const removed = list.filter((f) => f.sync === 'removes' && (f.removal ?? 'stack') === 'stack')
  const blocked = names((f) => f.sync === 'removes' && f.removal === 'policy')
  const retired = names((f) => f.sync === 'removes' && f.removal === 'retired')
  const edited = names((f) => f.sync === 'keeps' && Boolean(f.plugin) && !f.team)
  const teamSource = list.filter((f) => f.sync === 'keeps' && Boolean(f.team))
  const own = names((f) => f.sync === 'keeps' && !f.plugin && !f.team)
  if (replaced) parts.push(`opencastle sync fixes ${replaced} (still as OpenCastle wrote them)`)
  if (rewritten) parts.push(`opencastle sync rewrites ${rewritten} as the team config defines them`)
  if (removed.length > 0) {
    const servers = [...new Set(removed.map((f) => f.server))].join(', ')
    const packs = [...new Set(removed.map((f) => f.plugin))].join(' ')
    parts.push(`opencastle sync removes ${servers}, which this project's stack does not include — opencastle add ${packs} keeps it`)
  }
  if (blocked) parts.push(`opencastle sync removes ${blocked}, which the team's MCP policy does not allow`)
  if (retired) parts.push(`opencastle sync removes ${retired}, which no team layer defines any more`)
  for (const where of new Set(teamSource.map((f) => f.team as string))) {
    parts.push(`fix ${names((f) => f.team === where && f.sync === 'keeps')} in ${where}, where it is defined`)
  }
  if (edited) {
    parts.push(
      `${edited} changed since OpenCastle wrote them — fix by hand, or delete the entry and run opencastle sync --force for the current default`,
    )
  }
  if (own) parts.push(`fix ${own} by hand in ${rel}`)
  // A credential in a committed file needs more than an edit: it has to leave
  // the file, and if the file was ever pushed, the credential is spent.
  const leaked = names((f) => f.problem === 'inline-secret')
  if (leaked) {
    parts.push(
      `move the credential in ${leaked} into .env or your shell and reference it as \${NAME}; rotate it if the file was ever committed`,
    )
  }
  return parts.join('; ')
}

export interface McpAuditResult {
  ok: boolean
  label: string
  detail?: string
  warning?: boolean
  fix?: string
}

const LABEL = 'MCP servers load and run pinned code'

/**
 * The check `doctor` and `status` run for one target's MCP config.
 *
 * A config that is absent or will not parse is not reported here: the MCP
 * configuration check beside this one already owns both of those answers, and
 * saying it twice would print two remedies for one fault.
 */
export function checkMcpSupplyChain(
  projectRoot: string,
  ide: IdeChoice,
  included?: Set<string>,
  team?: TeamAuditContext,
): McpAuditResult {
  const rel = getMcpConfigRelPath(ide)
  const abs = resolve(projectRoot, rel)
  if (!existsSync(abs)) return { ok: true, label: LABEL, detail: 'no MCP config' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'))
  } catch {
    return { ok: true, label: LABEL, detail: `${rel} could not be read (reported above)` }
  }

  const audit = auditMcpConfig(parsed, ide, included, team)
  const broken = audit.findings.filter((f) => isFailure(f, team?.policy))
  const unpinned = audit.findings.filter((f) => !isFailure(f, team?.policy))
  const unaudited = audit.unaudited.length
    ? `not audited — ${audit.unaudited.map((u) => `${u.server} (${u.why})`).join(', ')}`
    : ''

  if (broken.length > 0) {
    // The rest in the same line: a failure used to hide them, so fixing it was
    // followed by a second, surprise round of warnings.
    const also = [
      unpinned.length > 0 ? `not pinned — ${unpinned.map(describeFinding).join(', ')}` : '',
      unaudited,
    ].filter(Boolean)
    return {
      ok: false,
      label: LABEL,
      detail: [broken.map((f) => describeFindingUnder(f, team?.policy)).join('; '), ...also].join('; also '),
      fix: remedyFor([...broken, ...unpinned], rel),
    }
  }
  if (unpinned.length > 0 || unaudited) {
    const said = [
      unpinned.length > 0 ? `not pinned to an exact version — ${unpinned.map(describeFinding).join(', ')}` : '',
      unaudited,
    ].filter(Boolean)
    const fixes = [
      unpinned.length > 0
        ? `${remedyFor(unpinned, rel)} (pin as name@x.y.z; each machine otherwise runs whatever was published last)`
        : '',
      unaudited ? `check by hand what ${audit.unaudited.map((u) => u.server).join(', ')} launch` : '',
    ].filter(Boolean)
    return { ok: true, warning: true, label: LABEL, detail: said.join('; '), fix: fixes.join('; ') }
  }
  return {
    ok: true,
    label: LABEL,
    detail: audit.passed === 0 ? 'no servers configured' : `${audit.passed} server(s): pinned, project-local, remote, or the project's own code`,
  }
}
