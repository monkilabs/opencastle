import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { readManifest } from './manifest.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { detectAssistantConfigs } from './detect.js'
import { c } from './prompt.js'
import type { CliContext, IdeAdapter, Manifest } from './types.js'

/**
 * The no-argument command: report what is installed, whether generated targets
 * are current, and name the one command to run next.
 *
 * This exists so users never have to tell the tool something it can already
 * see. It replaces the flag families (--status, --resume, --retry-failed) that
 * previously made the user restate known state on the command line.
 */

const STATUS_HELP = `
  opencastle

  Show what is installed, whether generated files are current, and what to run next.

  Options:
    --json          Machine-readable output
    --help, -h      Show this help
`

export interface TargetStatus {
  ide: string
  /** Generated paths that are missing entirely. */
  missing: string[]
  /** True when every expected path is present. */
  present: boolean
}

export interface StatusReport {
  installed: boolean
  version?: string
  ides: string[]
  targets: TargetStatus[]
  /** Generated files older than the newest source file — a drift signal. */
  stale: boolean
  /** Assistant config found in the project that OpenCastle does not manage yet. */
  unmanaged: string[]
  nextCommand?: string
  nextReason?: string
}

/** Newest mtime under a directory tree, or 0 when absent. */
async function newestMtime(root: string, depth = 4): Promise<number> {
  if (!existsSync(root)) return 0
  let newest = 0
  async function walk(dir: string, level: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (level > 0) await walk(p, level - 1)
      } else {
        try {
          const m = (await stat(p)).mtimeMs
          if (m > newest) newest = m
        } catch { /* ignore unreadable files */ }
      }
    }
  }
  await walk(root, depth)
  return newest
}

/** Resolve the adapters named by the manifest, skipping unknown ids. */
async function loadAdapters(manifest: Manifest): Promise<Array<{ ide: string; adapter: IdeAdapter }>> {
  const ids = manifest.ides?.length ? manifest.ides : [manifest.ide]
  const out: Array<{ ide: string; adapter: IdeAdapter }> = []
  for (const ide of ids) {
    const loader = IDE_ADAPTERS[ide]
    if (!loader) continue
    out.push({ ide, adapter: await loader() })
  }
  return out
}

export async function buildStatusReport(pkgRoot: string, projectRoot: string): Promise<StatusReport> {
  const manifest = await readManifest(projectRoot)

  if (!manifest) {
    // Not installed: the useful signal is which assistants are already configured,
    // because that is what init can lift and compile for the others.
    const unmanaged = detectAssistantConfigs(projectRoot).map((a) => a.label)
    return {
      installed: false,
      ides: [],
      targets: [],
      stale: false,
      unmanaged,
      nextCommand: 'opencastle init',
      nextReason: unmanaged.length
        ? `found existing config for ${unmanaged.join(', ')} — init can compile it for every other assistant`
        : 'set up AI assistant config for this project',
    }
  }

  const adapters = await loadAdapters(manifest)
  const targets: TargetStatus[] = []
  for (const { ide, adapter } of adapters) {
    const missing = adapter
      .getManagedPaths()
      .framework.filter((p) => !existsSync(resolve(projectRoot, p)))
    targets.push({ ide, missing, present: missing.length === 0 })
  }

  // Drift, decided the same way `sync --check` decides it: by compiling to a
  // scratch directory and comparing. The old answer here was an mtime heuristic,
  // which said "1/1 target in sync — up to date" on a project where the check
  // reported four differing files, three of them about to be deleted. The bare
  // command is the front door; reassuring someone right before `sync` removes
  // their file is worse than saying nothing.
  let stale = false
  try {
    const { buildCheckReport } = await import('./sync-check.js')
    const report = await buildCheckReport(pkgRoot, projectRoot)
    stale = report.drift.length > 0
  } catch {
    // Falls back to the mtime heuristic rather than claiming health it cannot
    // establish — a manifest we cannot compile from is itself worth a nudge.
    const sourceMtime = await newestMtime(resolve(pkgRoot, 'src', 'orchestrator'))
    for (const { adapter } of adapters) {
      for (const p of adapter.getManagedPaths().framework) {
        const abs = resolve(projectRoot, p)
        if (!existsSync(abs)) continue
        try {
          const m = statSync(abs).isDirectory() ? await newestMtime(abs, 2) : statSync(abs).mtimeMs
          if (sourceMtime > 0 && m > 0 && m < sourceMtime) {
            stale = true
            break
          }
        } catch { /* ignore */ }
      }
      if (stale) break
    }
  }

  // Assistants configured in the repo that this install does not compile for.
  const managedIdes = new Set(adapters.map((a) => a.ide))
  const unmanaged = detectAssistantConfigs(projectRoot)
    .filter((a) => !managedIdes.has(a.ide))
    .map((a) => a.label)

  const incomplete = targets.filter((t) => !t.present)
  let nextCommand: string | undefined
  let nextReason: string | undefined
  if (incomplete.length > 0) {
    nextCommand = 'opencastle sync'
    nextReason = `${incomplete.length} target${incomplete.length === 1 ? '' : 's'} missing generated files`
  } else if (stale) {
    nextCommand = 'opencastle sync'
    nextReason = 'generated files no longer match their sources'
  } else if (unmanaged.length > 0) {
    nextCommand = 'opencastle init --customize'
    nextReason = `${unmanaged.join(', ')} config exists but is not being compiled`
  }

  return {
    installed: true,
    version: manifest.version,
    ides: adapters.map((a) => a.ide),
    targets,
    stale,
    unmanaged,
    nextCommand,
    nextReason,
  }
}

function render(report: StatusReport): void {
  if (!report.installed) {
    console.log(`\n  🏰 ${c.bold('OpenCastle')} — not set up in this project\n`)
    if (report.unmanaged.length > 0) {
      console.log(`  Found existing assistant config:`)
      for (const label of report.unmanaged) console.log(`    ${c.dim('•')} ${label}`)
      console.log('')
    }
    if (report.nextCommand) {
      console.log(`  ${c.bold('Next:')} ${c.cyan(report.nextCommand)}`)
      if (report.nextReason) console.log(`  ${c.dim(report.nextReason)}`)
    }
    console.log('')
    return
  }

  const inSync = report.targets.filter((t) => t.present).length
  const total = report.targets.length
  console.log(`\n  🏰 ${c.bold('OpenCastle')} ${c.dim(`v${report.version ?? '?'}`)}\n`)
  console.log(
    `  ${inSync === total && !report.stale ? c.green('✓') : c.yellow('!')} ` +
      `${inSync}/${total} target${total === 1 ? '' : 's'} in sync` +
      (report.stale ? c.yellow(' (sources are newer)') : ''),
  )

  for (const t of report.targets) {
    const mark = t.present ? c.green('✓') : c.yellow('!')
    const detail = t.present
      ? c.dim('up to date')
      : c.yellow(`${t.missing.length} path${t.missing.length === 1 ? '' : 's'} missing`)
    console.log(`    ${mark} ${t.ide.padEnd(14)} ${detail}`)
  }

  if (report.unmanaged.length > 0) {
    console.log('')
    console.log(`  ${c.dim('Not compiled:')} ${report.unmanaged.join(', ')}`)
  }

  console.log('')
  if (report.nextCommand) {
    console.log(`  ${c.bold('Next:')} ${c.cyan(report.nextCommand)}`)
    if (report.nextReason) console.log(`  ${c.dim(report.nextReason)}`)
  } else {
    console.log(`  ${c.dim('Everything is current. Run')} ${c.cyan('opencastle doctor')} ${c.dim('for a deeper check.')}`)
  }
  console.log('')
}

export default async function status({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(STATUS_HELP)
    return
  }

  const report = await buildStatusReport(pkgRoot, process.cwd())

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  render(report)
}
