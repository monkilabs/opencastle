import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { PLUGINS } from '../orchestrator/plugins/index.js'
import { getIncludedMcpServers } from './stack-config.js'
import { splitFrontmatter, parseFrontmatterString } from './adapters/frontmatter.js'
import { compiledPath, filesUnder, type CompileSource, type LayerKind } from './layers.js'
import { serverTransport, envNamesIn, type ContentKind } from './team-config.js'
import type { RepoInfo, StackConfig } from './types.js'

/**
 * `.opencastle/lock.json`: what every assistant in this repository is given,
 * written by `sync` and committed.
 *
 * A source change regenerates dozens of files across seven targets, and nobody
 * reviews a hundred-line diff of generated Markdown. This is the one file that
 * says, in a reviewable shape, which layers were compiled at which versions,
 * where every skill, agent and instruction came from, which MCP servers every
 * assistant can start, and how much context is loaded before the task is read.
 * `opencastle review` diffs it between two commits; `sync --check` fails when it
 * is out of date, so it cannot drift from what was compiled.
 *
 * Deterministic by construction — no timestamps, no absolute paths, keys in a
 * fixed order — so it changes only when what the assistants get changes, and
 * two branches that both sync conflict only when they really disagree.
 */

export const LOCK_REL = '.opencastle/lock.json'
export const LOCKFILE_VERSION = 1

export interface LockItem {
  /** The layer that provides it. */
  from: string
  /** The first 12 hex digits of the compiled content's SHA-256. */
  sha: string
  overrides?: string
  description?: string
  /** Estimated tokens, for always-loaded instructions. */
  tokens?: number
}

export interface LockServer {
  /** `plugin:<id>` for an integration, otherwise the layer that defines it. */
  from: string
  transport: 'stdio' | 'http'
  /** The command line, or the URL. */
  launch: string
  env?: string[]
  auth?: string
  /**
   * For a team server, a digest of its whole definition. The launch line and
   * the variable names do not show a literal environment value or header —
   * `NODE_OPTIONS`, an API base URL — and a change there has to move the lock,
   * or the review and the owners the lock routes to never see it.
   */
  sha?: string
}

export interface LockLayer {
  id: string
  kind: LayerKind
  version?: string
  integrity?: string
}

export interface LockPolicy {
  allow?: Record<string, string[]>
  remoteHosts?: Record<string, string[]>
  requirePinned?: string
  require?: string[]
  contextBudget?: number
  opencastle?: Record<string, string>
}

export interface Lock {
  $comment?: string
  lockfileVersion: number
  opencastle: string
  targets: string[]
  integrations: string[]
  layers: LockLayer[]
  content: Record<string, LockItem>
  excluded?: Record<string, string>
  mcp: Record<string, LockServer>
  blocked?: Record<string, string>
  policy?: LockPolicy
  context: { tokens: number; instructions: number; index: number }
}

const COMMENT = 'Written by opencastle sync — do not edit. Change .opencastle/ (or a baseline) and run sync; opencastle review explains a change.'

function sha12(parts: Array<[string, Buffer]>): string {
  const hash = createHash('sha256')
  for (const [name, data] of parts) hash.update(name).update('\0').update(data).update('\0')
  return hash.digest('hex').slice(0, 12)
}

export function tokensOf(chars: number): number {
  return Math.ceil(chars / 4)
}

function frontmatterOf(text: string): { meta: Record<string, string>; body: string } {
  const { frontmatter, body } = splitFrontmatter(text.replace(/\r\n/g, '\n'))
  return { meta: parseFrontmatterString(frontmatter), body }
}

function clip(text: string, max = 200): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function sorted<T>(entries: Array<[string, T]>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = v
  return out
}

/** A server definition as a string that does not depend on key order. */
function canonicalServer(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** The command line a stdio server runs, as one string. */
function launchLine(command: string | string[] | undefined, args: string[] | undefined): string {
  const parts = Array.isArray(command) ? command : [command ?? '', ...(args ?? [])]
  return parts.filter((p) => p !== '').join(' ')
}

export interface LockOptions {
  ides: string[]
  stack: StackConfig
  repoInfo?: RepoInfo
}

export interface ContentReport {
  entries: Array<[string, LockItem]>
  instructionChars: number
  indexChars: number
  /** What each item costs in always-loaded context, in characters. */
  cost: Array<{ ref: string; from: string; chars: number }>
}

/** Every compiled item with its digest, and what the always-loaded part costs. */
export function contentReport(source: CompileSource): ContentReport {
  const { resolved } = source
  const content: Array<[string, LockItem]> = []
  const cost: ContentReport['cost'] = []
  let instructionChars = 0
  let indexChars = 0
  for (const item of resolved.items.values()) {
    const abs = join(source.root, compiledPath(item.kind as ContentKind, item.name))
    if (!existsSync(abs)) continue
    let sha: string
    let main: string
    if (statSync(abs).isDirectory()) {
      const files = filesUnder(abs)
      sha = sha12(files.map((f) => [f, readFileSync(join(abs, f))]))
      main = existsSync(join(abs, 'SKILL.md')) ? readFileSync(join(abs, 'SKILL.md'), 'utf8') : ''
    } else {
      const buf = readFileSync(abs)
      sha = sha12([['', buf]])
      main = buf.toString('utf8')
    }
    const { meta, body } = frontmatterOf(main)
    const entry: LockItem = { from: item.plugin ? `plugin:${item.plugin}` : item.layer, sha }
    if (item.overrides) entry.overrides = item.overrides
    const ref = `${item.kind}/${item.name}`
    if (item.kind === 'instructions') {
      const chars = body.trim().length
      instructionChars += chars
      entry.tokens = tokensOf(chars)
      cost.push({ ref, from: entry.from, chars })
    } else if (meta.description) {
      entry.description = clip(meta.description)
    }
    // What the index every single-file target writes costs, per entry: its
    // name twice (the name and the path) and its description.
    if (item.kind === 'skills' || item.kind === 'agents') {
      const chars = item.name.length * 2 + (meta.description ?? '').length + 32
      indexChars += chars
      cost.push({ ref, from: entry.from, chars })
    }
    content.push([ref, entry])
  }
  return { entries: content, instructionChars, indexChars, cost }
}

/** Build the lock for a compile. Reads the materialized source, not the layers, so it records what was compiled. */
export function buildLock(source: CompileSource, opts: LockOptions): Lock {
  const { resolved } = source
  const { entries: content, instructionChars, indexChars } = contentReport(source)

  // ── MCP ─────────────────────────────────────────────────────
  const mcp: Array<[string, LockServer]> = []
  const included = getIncludedMcpServers(opts.stack, opts.repoInfo)
  for (const plugin of Object.values(PLUGINS)) {
    const key = plugin.mcpServerKey
    const cfg = plugin.mcpConfig
    if (!key || !cfg || !included.has(key)) continue
    if (resolved.servers.has(key) || resolved.blocked.has(key)) continue
    const server: LockServer =
      cfg.type === 'http'
        ? { from: `plugin:${plugin.id}`, transport: 'http', launch: cfg.url ?? '' }
        : { from: `plugin:${plugin.id}`, transport: 'stdio', launch: launchLine(cfg.command, cfg.args) }
    const env = plugin.envVars.map((e) => e.name).sort()
    if (env.length > 0) server.env = env
    server.auth = plugin.authType
    mcp.push([key, server])
  }
  for (const ts of resolved.servers.values()) {
    const t = serverTransport(ts.server) ?? 'stdio'
    const server: LockServer =
      t === 'http'
        ? { from: ts.from, transport: 'http', launch: ts.server.url ?? '' }
        : { from: ts.from, transport: 'stdio', launch: launchLine(ts.server.command, ts.server.args) }
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
    if (names.size > 0) server.env = [...names].sort()
    server.sha = sha12([['', Buffer.from(canonicalServer(ts.server))]])
    mcp.push([ts.key, server])
  }

  // ── Policy ──────────────────────────────────────────────────
  const p = resolved.policy
  const policy: LockPolicy = {}
  if (p.allowLists.length > 0) policy.allow = sorted(p.allowLists.map((l) => [l.by, [...l.patterns].sort()]))
  if (p.hostLists.length > 0) policy.remoteHosts = sorted(p.hostLists.map((l) => [l.by, [...l.patterns].sort()]))
  if (p.requirePinned) policy.requirePinned = p.requirePinned
  if (p.require.length > 0) policy.require = [...new Set(p.require.map((r) => r.ref))].sort()
  if (p.contextBudget) policy.contextBudget = p.contextBudget.tokens
  if (p.versionRanges.length > 0) policy.opencastle = sorted(p.versionRanges.map((r) => [r.by, r.range]))

  const lock: Lock = {
    $comment: COMMENT,
    lockfileVersion: LOCKFILE_VERSION,
    opencastle: resolved.cliVersion,
    targets: [...opts.ides].sort(),
    integrations: [...opts.stack.techTools, ...opts.stack.teamTools].map(String).sort(),
    layers: resolved.layers
      .filter((l) => l.kind !== 'project' || Object.keys(l.config).length > 0 || [...resolved.items.values()].some((i) => i.layer === 'project'))
      .map((l) => ({
        id: l.id,
        kind: l.kind,
        ...(l.version && { version: l.version }),
        ...(l.integrity && { integrity: l.integrity }),
      })),
    content: sorted(content),
    mcp: sorted(mcp),
    context: {
      tokens: tokensOf(instructionChars + indexChars),
      instructions: tokensOf(instructionChars),
      index: tokensOf(indexChars),
    },
  }
  if (resolved.excluded.length > 0) lock.excluded = sorted(resolved.excluded.map((e) => [e.ref, e.by]))
  if (resolved.blocked.size > 0) lock.blocked = sorted([...resolved.blocked.entries()])
  if (Object.keys(policy).length > 0) lock.policy = policy
  // Keys in a fixed order, whatever order they were assigned in above.
  return {
    $comment: lock.$comment,
    lockfileVersion: lock.lockfileVersion,
    opencastle: lock.opencastle,
    targets: lock.targets,
    integrations: lock.integrations,
    layers: lock.layers,
    content: lock.content,
    ...(lock.excluded && { excluded: lock.excluded }),
    mcp: lock.mcp,
    ...(lock.blocked && { blocked: lock.blocked }),
    ...(lock.policy && { policy: lock.policy }),
    context: lock.context,
  }
}

export function serializeLock(lock: Lock): string {
  return JSON.stringify(lock, null, 2) + '\n'
}

/**
 * A lock, or null when the text is not one this release can read. Checked
 * field by field: `fleet` reads locks from many repositories, and one written
 * by hand or by a future release must not take the whole report down.
 */
export function parseLock(text: string): Lock | null {
  let parsed: Lock
  try {
    parsed = JSON.parse(text) as Lock
  } catch {
    return null
  }
  const obj = (v: unknown): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  if (
    !obj(parsed) ||
    parsed.lockfileVersion !== LOCKFILE_VERSION ||
    typeof parsed.opencastle !== 'string' ||
    !Array.isArray(parsed.targets) ||
    !Array.isArray(parsed.integrations) ||
    !Array.isArray(parsed.layers) ||
    !parsed.layers.every((l) => obj(l) && typeof l.id === 'string') ||
    !obj(parsed.content) ||
    !obj(parsed.mcp) ||
    !Object.values(parsed.mcp).every((m) => obj(m) && typeof m.from === 'string' && typeof m.launch === 'string') ||
    !obj(parsed.context) ||
    typeof parsed.context.tokens !== 'number'
  ) {
    return null
  }
  return parsed
}

/** The committed lock, or null when there is none or it cannot be read. */
export function readLock(projectRoot: string): Lock | null {
  const abs = join(projectRoot, LOCK_REL)
  if (!existsSync(abs)) return null
  try {
    return parseLock(readFileSync(abs, 'utf8'))
  } catch {
    return null
  }
}

/** Write the lock if it changed. Returns whether it did. */
export async function writeLock(projectRoot: string, lock: Lock): Promise<boolean> {
  const abs = join(projectRoot, LOCK_REL)
  const text = serializeLock(lock)
  try {
    if (existsSync(abs) && readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') === text) return false
  } catch {
    // Unreadable: overwrite it — it is generated.
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, text)
  return true
}

/** The servers a lock records as the team's own, not an integration's. */
export function teamServerKeys(lock: Lock | null): string[] {
  if (!lock?.mcp) return []
  return Object.entries(lock.mcp)
    .filter(([, s]) => !s.from.startsWith('plugin:'))
    .map(([k]) => k)
}

/**
 * Resolve a project's sources and write the lock `sync` would write for it.
 * For callers that compile through the adapters directly — tests, mostly — and
 * so need the one file a real compile also produces.
 */
export async function recordLockFor(
  pkgRoot: string,
  projectRoot: string,
  manifest: { ide?: string; ides?: string[]; stack?: StackConfig; repoInfo?: RepoInfo },
): Promise<void> {
  const { resolveStack } = await import('./stack-config.js')
  const { resolveSources, materialize, hasErrors, formatIssues } = await import('./layers.js')
  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter((i): i is string => Boolean(i))
  const stack = resolveStack({ ...manifest, ides })
  const resolved = resolveSources({ pkgRoot, projectRoot, stack, repoInfo: manifest.repoInfo })
  if (hasErrors(resolved)) throw new Error(formatIssues(resolved.issues).join('\n'))
  const source = materialize(resolved, pkgRoot, ...priorTeam(projectRoot))
  try {
    await writeLock(projectRoot, buildLock(source, { ides, stack, repoInfo: manifest.repoInfo }))
  } finally {
    source.dispose()
  }
}

/**
 * What the committed lock says a previous sync wrote for the team: its server
 * keys, and the variables those servers read (VS Code inputs among them).
 * Passed to `materialize` so `sync` can take back what no layer defines now.
 */
export function priorTeam(projectRoot: string): [string[], string[]] {
  const lock = readLock(projectRoot)
  const keys = teamServerKeys(lock)
  const vars = new Set<string>()
  for (const k of keys) for (const v of lock?.mcp[k]?.env ?? []) vars.add(v)
  return [keys, [...vars].sort()]
}
