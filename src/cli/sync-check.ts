import { resolve, relative, join, sep } from 'node:path'
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readManifest } from './manifest.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { detectRepoInfo, mergeStackIntoRepoInfo } from './detect.js'
import { c } from './prompt.js'
import type { CliContext, IdeChoice, StackConfig } from './types.js'

/**
 * Drift detection for CI: compile to a scratch directory and compare.
 *
 * This is the check a compiler owes you. Generated assistant config drifts the
 * moment someone edits `.cursor/rules/foo.mdc` directly instead of the source,
 * or when the package is upgraded and nobody re-runs sync — and nothing tells
 * you, because a stale rule file still loads fine. Comparing against a fresh
 * compile is the only honest answer.
 */

export type DriftKind = 'missing' | 'changed'

export interface Drift {
  ide: string
  path: string
  kind: DriftKind
}

export interface CheckReport {
  installed: boolean
  ides: string[]
  drift: Drift[]
  /** Files compared, for reporting scale. */
  checked: number
}

/** Every file under a directory, relative to it, sorted for stable output. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}

function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/**
 * Compare one managed path — a file or a directory tree — between the freshly
 * compiled output and the project.
 */
function comparePath(
  managedPath: string,
  freshRoot: string,
  projectRoot: string,
  ide: string,
  drift: Drift[],
): number {
  const fresh = resolve(freshRoot, managedPath)
  const actual = resolve(projectRoot, managedPath)

  // A path the compiler did not produce cannot have drifted.
  if (!existsSync(fresh)) return 0

  if (statSync(fresh).isDirectory()) {
    let checked = 0
    for (const rel of filesUnder(fresh)) {
      const f = join(fresh, rel)
      const a = join(actual, rel)
      const shown = `${managedPath.replace(/\/$/, '')}/${rel}`
      checked++
      if (!existsSync(a)) drift.push({ ide, path: shown, kind: 'missing' })
      else if (!sameContent(f, a)) drift.push({ ide, path: shown, kind: 'changed' })
    }
    return checked
  }

  if (!existsSync(actual)) {
    drift.push({ ide, path: managedPath, kind: 'missing' })
  } else if (!sameContent(fresh, actual)) {
    drift.push({ ide, path: managedPath, kind: 'changed' })
  }
  return 1
}

export async function buildCheckReport(pkgRoot: string, projectRoot: string): Promise<CheckReport> {
  const manifest = await readManifest(projectRoot)
  if (!manifest) return { installed: false, ides: [], drift: [], checked: 0 }

  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter(
    (id): id is IdeChoice => id in IDE_ADAPTERS,
  )

  const stack: StackConfig =
    manifest.stack ?? { ides, techTools: [], teamTools: [] }
  const repoInfo = manifest.repoInfo ?? mergeStackIntoRepoInfo(await detectRepoInfo(projectRoot), stack)

  const drift: Drift[] = []
  let checked = 0

  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const scratch = mkdtempSync(join(tmpdir(), `opencastle-check-${ide}-`))
    try {
      await adapter.install(pkgRoot, scratch, stack, repoInfo)
      // Only framework paths are compared. Customizable paths are the user's by
      // design — reporting those as drift would make the check useless.
      for (const managedPath of adapter.getManagedPaths().framework) {
        checked += comparePath(managedPath, scratch, projectRoot, ide, drift)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  return { installed: true, ides, drift, checked }
}

function render(report: CheckReport): void {
  if (!report.installed) {
    console.error(`\n  ${c.red('✗')} No OpenCastle installation found here.`)
    console.error(`  ${c.dim('Run')} ${c.cyan('opencastle init')} ${c.dim('first.')}\n`)
    return
  }

  if (report.drift.length === 0) {
    console.log(
      `\n  ${c.green('✓')} ${report.checked} generated file${report.checked === 1 ? '' : 's'} ` +
        `match their sources across ${report.ides.length} target${report.ides.length === 1 ? '' : 's'}.\n`,
    )
    return
  }

  const missing = report.drift.filter((d) => d.kind === 'missing')
  const changed = report.drift.filter((d) => d.kind === 'changed')

  console.log(`\n  ${c.red('✗')} ${report.drift.length} file(s) differ from their sources.\n`)

  if (changed.length > 0) {
    console.log(`  ${c.bold('Edited in place')} ${c.dim('(your change will be lost on the next sync)')}`)
    for (const d of changed) console.log(`    ${c.yellow('~')} ${d.path} ${c.dim(`(${d.ide})`)}`)
    console.log('')
  }
  if (missing.length > 0) {
    console.log(`  ${c.bold('Never generated')}`)
    for (const d of missing) console.log(`    ${c.red('-')} ${d.path} ${c.dim(`(${d.ide})`)}`)
    console.log('')
  }

  console.log(`  ${c.bold('Fix:')} ${c.cyan('opencastle sync')}`)
  console.log(`  ${c.dim('To keep an edit, move it into .opencastle/ instead — that directory is yours.')}\n`)
}

/** Exits non-zero on drift so CI fails. */
export async function runCheck({ pkgRoot, args }: CliContext): Promise<void> {
  const report = await buildCheckReport(pkgRoot, process.cwd())

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    render(report)
  }

  if (!report.installed || report.drift.length > 0) process.exit(1)
}
