import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { PLUGINS } from '../orchestrator/plugins/index.js'
import { getMcpConfigRelPath, upgradeGeneratedServers } from './mcp.js'
import type { IdeChoice } from './types.js'

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
 */

export type McpProblem = 'unpinned' | 'nonexistent' | 'untyped-remote'

export interface McpFinding {
  server: string
  problem: McpProblem
  /** The package spec or URL the finding is about, as written. */
  subject: string
  /** An OpenCastle plugin owns this server key. */
  pluginKey: boolean
  /**
   * The entry is still exactly as a release wrote it, so `sync` replaces it.
   * A plugin key alone is not enough: an entry someone edited is theirs, and
   * `sync` correctly leaves it — so "run sync" over it would be a remedy that
   * does nothing.
   */
  bySync: boolean
  /** The package name, for findings about a package. */
  pkg?: string
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

/** Runners that fetch a package from the registry and execute it. */
const RUNNERS: Record<string, string[]> = {
  npx: [],
  bunx: [],
  pnpm: ['dlx'],
  yarn: ['dlx'],
}

/** npx flags that take no value, so the first other token is the package. */
const VALUELESS_FLAGS = new Set(['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '--silent', '--ignore-existing'])

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

/** The registry package a command line fetches and runs, or null if it runs none. */
export function packageLaunch(command: string, args: string[]): PackageLaunch | null {
  // Split on both separators: a config written on Windows says `C:\tools\npx.cmd`,
  // and `basename` only knows the separator of the machine running the check.
  const bin = (command.split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe)$/i, '')
  const lead = RUNNERS[bin]
  if (!lead) return null
  if (lead.some((word, i) => args[i] !== word)) return null
  const rest = args.slice(lead.length)

  let spec: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '-p' || arg === '--package') {
      spec = rest[i + 1]
      break
    }
    if (arg.startsWith('--package=')) {
      spec = arg.slice('--package='.length)
      break
    }
    if (arg === '--') {
      spec = rest[i + 1]
      break
    }
    if (arg.startsWith('-')) {
      if (VALUELESS_FLAGS.has(arg)) continue
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

  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : null
  const localOnly = bin === 'npx' && (rest.includes('--no') || rest.includes('--no-install'))
  return { spec, name, version, localOnly }
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

/** Findings for one parsed config. `ide` decides which dialect rules apply. */
export function auditMcpConfig(config: unknown, ide: IdeChoice): McpFinding[] {
  const managedKeys = new Set(
    Object.values(PLUGINS)
      .map((p) => p.mcpServerKey)
      .filter((k): k is string => Boolean(k)),
  )
  const findings: McpFinding[] = []
  for (const [server, entry] of serverEntries(config)) {
    const pluginKey = managedKeys.has(server)
    const bySync =
      pluginKey && upgradeGeneratedServers({ [server]: structuredClone(entry) }, ide, new Set([server])).length > 0
    const line = commandLine(entry)
    if (line) {
      const launch = packageLaunch(line.command, line.args)
      if (!launch) continue
      if (NONEXISTENT_PACKAGES[launch.name]) {
        findings.push({ server, problem: 'nonexistent', subject: launch.spec, pluginKey, bySync, pkg: launch.name })
      } else if (!isPinned(launch)) {
        findings.push({ server, problem: 'unpinned', subject: launch.spec, pluginKey, bySync, pkg: launch.name })
      }
      continue
    }
    if (ide === 'claude-code' && typeof entry.url === 'string' && entry.type === undefined) {
      findings.push({ server, problem: 'untyped-remote', subject: entry.url, pluginKey, bySync })
    }
  }
  return findings
}

export interface McpAuditResult {
  ok: boolean
  label: string
  detail?: string
  warning?: boolean
  fix?: string
}

const LABEL = 'MCP servers run pinned code'

function describe(f: McpFinding): string {
  switch (f.problem) {
    case 'nonexistent':
      return `${f.server}: ${f.subject} was ${NONEXISTENT_PACKAGES[f.pkg ?? ''] ?? 'not found on npm'}`
    case 'untyped-remote':
      return `${f.server}: no "type" — Claude Code reads it as a stdio server, so it never loads`
    case 'unpinned':
      return `${f.server}: ${f.subject}`
  }
}

/**
 * The check `doctor` and `status` run for one target's MCP config.
 *
 * A config that is absent or will not parse is not reported here: the MCP
 * configuration check beside this one already owns both of those answers, and
 * saying it twice would print two remedies for one fault.
 */
export function checkMcpSupplyChain(projectRoot: string, ide: IdeChoice): McpAuditResult {
  const rel = getMcpConfigRelPath(ide)
  const abs = resolve(projectRoot, rel)
  if (!existsSync(abs)) return { ok: true, label: LABEL, detail: 'no MCP config' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'))
  } catch {
    return { ok: true, label: LABEL, detail: `${rel} could not be read (reported above)` }
  }

  const findings = auditMcpConfig(parsed, ide)
  const broken = findings.filter((f) => f.problem !== 'unpinned')
  const unpinned = findings.filter((f) => f.problem === 'unpinned')
  const total = serverEntries(parsed).length

  // Only `sync` can clear what it wrote, and only while nobody has edited it.
  // Saying "run sync" over an entry someone changed would send them to a
  // command that, correctly, will not touch it — so each finding gets the
  // remedy that actually works for it.
  const remedy = (list: McpFinding[]): string => {
    const names = (pick: (f: McpFinding) => boolean) => [...new Set(list.filter(pick).map((f) => f.server))].join(', ')
    const parts: string[] = []
    const sync = names((f) => f.bySync)
    const edited = names((f) => f.pluginKey && !f.bySync)
    const own = names((f) => !f.pluginKey)
    if (sync) parts.push(`opencastle sync fixes ${sync} (still as OpenCastle wrote them)`)
    if (edited) parts.push(`${edited} changed since OpenCastle wrote them — fix by hand, or delete the entry and run opencastle sync for the current default`)
    if (own) parts.push(`fix ${own} by hand in ${rel}`)
    return parts.join('; ')
  }

  if (broken.length > 0) {
    // The unpinned ones too, in the same line: a failure hid them, so fixing the
    // failure used to be followed by a second, surprise round of warnings.
    const also = unpinned.length > 0 ? `; also not pinned — ${unpinned.map(describe).join(', ')}` : ''
    return {
      ok: false,
      label: LABEL,
      detail: broken.map(describe).join('; ') + also,
      fix: remedy([...broken, ...unpinned]),
    }
  }
  if (unpinned.length > 0) {
    return {
      ok: true,
      warning: true,
      label: LABEL,
      detail: `not pinned to an exact version — ${unpinned.map(describe).join(', ')}`,
      fix: `${remedy(unpinned)} (pin as name@x.y.z; each machine otherwise runs whatever was published last)`,
    }
  }
  return {
    ok: true,
    label: LABEL,
    detail: total === 0 ? 'no servers configured' : `${total} server(s): pinned, project-local, or remote`,
  }
}
