import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { readLock, type Lock } from './lock.js'
import { parseVersion, compareVersions } from './version-range.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * `opencastle fleet`: many repositories, one view.
 *
 * A platform team that publishes a baseline needs to know where it has landed:
 * which repositories run which version, which are behind, and whether the same
 * MCP server runs at five different versions across the organisation. Every
 * repository's committed lock already says all of this, so the answer is a
 * read of files — no install, no network, no access to anyone's machine.
 */

const HELP = `
  opencastle fleet <dir...> [options]

  Read the committed .opencastle/lock.json of each repository given and show
  which OpenCastle and baseline versions they run, which lag behind the newest,
  and which MCP servers run at more than one version across them.

  Options:
    --json         Machine-readable output
    --help, -h     Show this help

  Example: opencastle fleet ~/src/*
`

interface RepoRow {
  repo: string
  path: string
  lock: Lock | null
}

export interface FleetReport {
  repos: Array<{
    repo: string
    opencastle?: string
    baselines: Record<string, string>
    targets: string[]
    mcpServers: number
    contextTokens?: number
    lock: boolean
  }>
  /** Per baseline or OpenCastle itself: version → repositories. */
  versions: Record<string, Record<string, string[]>>
  /** MCP servers launched at more than one version or address. */
  spread: Record<string, Record<string, string[]>>
  withoutLock: string[]
}

function repoName(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    if (pkg.name) return pkg.name
  } catch {
    // Not a package; the directory name will do.
  }
  return basename(dir)
}

export function buildFleet(rows: RepoRow[]): FleetReport {
  const report: FleetReport = { repos: [], versions: {}, spread: {}, withoutLock: [] }
  const note = (bucket: Record<string, Record<string, string[]>>, key: string, value: string, repo: string): void => {
    ;((bucket[key] ??= {})[value] ??= []).push(repo)
  }
  for (const { repo, lock } of rows) {
    if (!lock) {
      report.withoutLock.push(repo)
      report.repos.push({ repo, baselines: {}, targets: [], mcpServers: 0, lock: false })
      continue
    }
    const baselines: Record<string, string> = {}
    for (const l of lock.layers) {
      if (l.kind === 'baseline') baselines[l.id] = l.version ?? '?'
    }
    report.repos.push({
      repo,
      opencastle: lock.opencastle,
      baselines,
      targets: lock.targets,
      mcpServers: Object.keys(lock.mcp).length,
      contextTokens: lock.context?.tokens,
      lock: true,
    })
    note(report.versions, 'opencastle', lock.opencastle, repo)
    for (const [id, v] of Object.entries(baselines)) note(report.versions, id, v, repo)
    for (const [key, s] of Object.entries(lock.mcp)) note(report.spread, key, s.launch, repo)
  }
  for (const key of Object.keys(report.spread)) {
    if (Object.keys(report.spread[key]).length < 2) delete report.spread[key]
  }
  return report
}

function newest(versions: string[]): string | undefined {
  return [...versions].sort((a, b) => {
    const pa = parseVersion(a)
    const pb = parseVersion(b)
    if (!pa || !pb) return a < b ? -1 : 1
    return compareVersions(pa, pb)
  }).pop()
}

function render(report: FleetReport): void {
  const out = (s = ''): void => console.log(s)
  out(`\n  🏰 ${c.bold('Fleet')} ${c.dim(`— ${report.repos.length} repositories`)}\n`)
  const width = Math.max(10, ...report.repos.map((r) => r.repo.length))
  for (const r of report.repos) {
    if (!r.lock) {
      out(`  ${c.yellow('!')} ${r.repo.padEnd(width)}  ${c.dim('no lock — not synced with a release that writes one')}`)
      continue
    }
    const bl = Object.entries(r.baselines).map(([id, v]) => `${id}@${v}`).join(', ')
    out(
      `  ${c.dim('•')} ${r.repo.padEnd(width)}  opencastle ${r.opencastle}  ${bl || c.dim('no baseline')}  ` +
        c.dim(`${r.targets.length} target(s), ${r.mcpServers} MCP server(s), ~${r.contextTokens ?? '?'} tokens up front`),
    )
  }
  out('')
  for (const [what, byVersion] of Object.entries(report.versions)) {
    const versions = Object.keys(byVersion)
    const top = newest(versions)
    const behind = versions.filter((v) => v !== top).flatMap((v) => byVersion[v])
    const line = versions
      .sort()
      .map((v) => `${v} (${byVersion[v].length})`)
      .join(', ')
    out(`  ${c.bold(what)}: ${line}${behind.length > 0 ? c.yellow(` — ${behind.length} behind ${top}: ${behind.join(', ')}`) : c.green(' — all on one version')}`)
  }
  const spread = Object.entries(report.spread)
  if (spread.length > 0) {
    out('')
    out(`  ${c.bold('MCP servers running differently across repositories')}`)
    for (const [key, byLaunch] of spread) {
      out(`    ${c.yellow('~')} ${key}`)
      for (const [launch, repos] of Object.entries(byLaunch)) out(`      ${c.dim(`${launch}  — ${repos.join(', ')}`)}`)
    }
  }
  out('')
}

export default async function fleet({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }
  const dirs = args.filter((a) => !a.startsWith('--'))
  if (dirs.length === 0) {
    console.log(HELP)
    process.exit(1)
  }
  const rows: RepoRow[] = []
  for (const dir of dirs) {
    const abs = resolve(dir)
    if (!existsSync(join(abs, '.opencastle'))) continue
    rows.push({ repo: repoName(abs), path: abs, lock: readLock(abs) })
  }
  if (rows.length === 0) {
    console.error(`\n  ${c.red('✗')} None of those directories uses OpenCastle (no .opencastle/ in any).\n`)
    process.exit(1)
  }
  const report = buildFleet(rows)
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else render(report)
}
