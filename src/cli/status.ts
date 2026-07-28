import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { readManifest } from './manifest.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { detectAssistantConfigs } from './detect.js'
import { missingRequiredCustomizations } from './managed-paths.js'
import { UnreadableConfigError } from './types.js'
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
  /** True when this target's files no longer match their sources. */
  drifted?: boolean
}

export interface StatusReport {
  /** Required files absent from `.opencastle/`; non-empty means unhealthy. */
  missingRequired?: string[]
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
  let manifest: Awaited<ReturnType<typeof readManifest>> = null
  try {
    manifest = await readManifest(projectRoot)
  } catch (err) {
    if (!(err instanceof UnreadableConfigError)) throw err
    // Present but unreadable. Reporting "not set up" sent people to `init`,
    // which is the one command that could make it worse.
    return {
      installed: true,
      version: undefined,
      ides: [],
      targets: [],
      stale: false,
      unmanaged: [],
      nextCommand: 'opencastle doctor',
      nextReason: `${err.file} is not valid JSON — fix it by hand, a merge conflict most likely`,
    }
  }

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
  let checkFailed: string | undefined
  // Per target, because the report already knows which one drifted. Collapsing
  // it to one boolean made every target read "needs a sync" when one had.
  const drifted = new Set<string>()
  try {
    const { buildCheckReport } = await import('./sync-check.js')
    const report = await buildCheckReport(pkgRoot, projectRoot)
    stale = report.drift.length > 0
    for (const d of report.drift) drifted.add(d.ide)
  } catch {
    // Falls back to the mtime heuristic. That is a fair answer when the reason
    // we could not compile is on our side; what it must not do is answer "no
    // drift" when it could not read the project either — see the inner catch.
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
        } catch (err) {
          // Not ignored. Swallowing this meant an unreadable framework
          // directory left `stale = false`, and the front door printed
          // "Everything is current" over a project `doctor` and `sync --check`
          // were both exiting 1 on. A path we cannot read is not a path we have
          // checked.
          checkFailed = `${p}: ${(err as Error).message}`
        }
      }
      if (stale) break
    }
  }

  for (const target of targets) target.drifted = drifted.has(target.ide)

  // Assistants configured in the repo that this install does not compile for.
  const managedIdes = new Set(adapters.map((a) => a.ide))
  const unmanaged = detectAssistantConfigs(projectRoot)
    .filter((a) => !managedIdes.has(a.ide))
    .map((a) => a.label)

  // An install missing the files the tool itself requires is incomplete, whatever
  // the compiled targets look like.
  const missingRequired = missingRequiredCustomizations(projectRoot)

  // The same checks `doctor` exits on, asked of `doctor`. Approximating them
  // here is how the front door came to call a project current while `doctor`
  // was failing it.
  let failing: string[] = []
  try {
    const { runSharedChecks, runAdapterChecks } = await import('./doctor.js')
    // Both halves of `doctor`'s verdict. `failing` was built from the shared
    // checks alone, so every adapter-declared one — the root file, the agent,
    // skill and command directories, per target — was invisible here: exactly
    // the "one fact, two interpreters" split this surface was restructured to
    // remove, still standing in the surface it was restructured for.
    const results = [
      ...(await runSharedChecks(projectRoot, manifest)),
      ...(await runAdapterChecks(projectRoot, manifest)),
    ]
    failing = results.filter((r) => !r.ok).map((r) => r.label)
  } catch (err) {
    // A diagnosis we could not run is not evidence of health — and the comment
    // that said so used to be followed by code that treated it as exactly that.
    // With a co-owned file unreadable, `doctor` exited 1, `sync --check` exited
    // 1, and this command printed "Everything is current".
    failing = [`could not be checked (${(err as Error).message})`]
  }

  const incomplete = targets.filter((t) => !t.present)
  let nextCommand: string | undefined
  let nextReason: string | undefined
  // Ordered by how specific the remedy is. Generated files that are simply
  // missing make the adapter checks fail too, and for those `sync` is the
  // answer — pointing at `doctor` first would have sent the user to a
  // diagnostic that says "run sync". `doctor` is what is left when a failure
  // has no more specific command.
  if (missingRequired.length > 0) {
    nextCommand = 'opencastle sync'
    nextReason = `${missingRequired.length} required file(s) missing from .opencastle/`
  } else if (incomplete.length > 0) {
    nextCommand = 'opencastle sync'
    nextReason = `${incomplete.length} target${incomplete.length === 1 ? '' : 's'} missing generated files`
  } else if (failing.length > 0) {
    nextCommand = 'opencastle doctor'
    nextReason = `${failing.length} check(s) failing: ${failing.join(', ')}`
  } else if (checkFailed) {
    // Last of the failure branches, because a comparison can also fail for
    // reasons that say nothing about the project — but never *ignored*: it used
    // to fall through to an mtime heuristic that answered "no drift", so an
    // unreadable framework directory produced "Everything is current" while
    // `doctor` and `sync --check` both exited 1.
    nextCommand = 'opencastle doctor'
    nextReason = `the drift check could not run (${checkFailed})`
  } else if (stale) {
    nextCommand = 'opencastle sync'
    nextReason = 'generated files no longer match their sources'
  } else if (unmanaged.length > 0) {
    nextCommand = 'opencastle init --customize'
    nextReason = `${unmanaged.join(', ')} config exists but is not being compiled`
  }

  return {
    installed: true,
    missingRequired,
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
  // "in sync" is a claim about content, and `present` only counts paths. Saying
  // "1/1 target in sync (sources are newer)" was two answers in one line — the
  // headline reassuring while the parenthesis contradicted it.
  // `nextCommand` is set for every condition that makes the install
  // unhealthy, including the required files `doctor` fails on. Recomputing
  // health from a subset of those facts is how the front door came to print
  // a green headline on a project `doctor` was exiting 1 over.
  const healthy = inSync === total && !report.stale && !report.nextCommand
  console.log(
    healthy
      ? `  ${c.green('✓')} ${total} target${total === 1 ? '' : 's'} in sync`
      : `  ${c.yellow('!')} ${inSync}/${total} target${total === 1 ? '' : 's'} installed` +
          (report.stale ? c.yellow(' — generated files no longer match their sources') : ''),
  )

  for (const t of report.targets) {
    // Per target. Folding `nextCommand` back in marked all seven targets
    // "needs a sync" when one had drifted.
    const targetStale = t.drifted ?? report.stale
    const mark = t.present && !targetStale ? c.green('✓') : c.yellow('!')
    const detail = !t.present
      ? c.yellow(`${t.missing.length} path${t.missing.length === 1 ? '' : 's'} missing`)
      : targetStale
        ? c.yellow('needs a sync')
        : c.dim('up to date')
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
