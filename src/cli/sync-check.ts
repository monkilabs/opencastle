import { resolve, relative, join, sep } from 'node:path'
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readManifest } from './manifest.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { detectRepoInfo, mergeStackIntoRepoInfo } from './detect.js'
import { resolveStack } from './stack-config.js'
import {
  START_MARKER as GITIGNORE_START,
  END_MARKER as GITIGNORE_END,
  buildBlock as buildGitignoreBlock,
} from './gitignore.js'
import {
  blockRegions,
  carriesLegacyBody,
  stripManagedBlock,
  hasManagedBlock,
  extractManagedBlock,
  countManagedBlocks,
  diagnoseManagedFile,
} from './managed-block.js'
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

/**
 * `unreducible` is the state no command will change: a co-owned file holding
 * more than one block *and* a marker that pairs with nothing. It is drift, so
 * CI must fail — but the remedy is a person, and printing "Fix: opencastle
 * sync" beside it made the check permanently red on a command that by design
 * refuses to touch the file.
 */
export type DriftKind = 'missing' | 'changed' | 'extra' | 'unreducible'

export interface Drift {
  ide: string
  path: string
  kind: DriftKind
  /** The classifier's own words, so the checker and `doctor` cannot diverge. */
  detail?: string
  /** What resolves it, per entry — these do not share a remedy. */
  fix?: string
}

export interface CheckReport {
  installed: boolean
  ides: string[]
  drift: Drift[]
  /** Files compared, for reporting scale. */
  checked: number
}

/** The text of the last complete region delimited by `start`/`end`, if any. */
function extractRegion(content: string, start: string, end: string): string | null {
  const regions = blockRegions(content, start, end)
  if (regions.length === 0) return null
  const r = regions[regions.length - 1]
  return content.slice(r.start, r.end)
}

/** Every file under a directory, relative to it, sorted for stable output. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      // Anything that is not a directory, matching what the sweep collects. The
      // checker used `isFile()` and the adapters a bare `else`, so a symlink in
      // a framework directory was invisible to the check and deleted by the
      // sync — the one class the checker exists to warn about beforehand.
      else out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}

/**
 * Compare a generated file against a freshly compiled one.
 *
 * Root instruction files hold a managed block surrounded by the user's own
 * writing, and a clean compile has no user content — so comparing whole files
 * would report drift on every merged file forever. When both sides carry the
 * block, only the block is compared; the surrounding prose is the user's and is
 * none of the checker's business.
 */
function sameContent(freshPath: string, actualPath: string): boolean {
  try {
    const fresh = readFileSync(freshPath)
    const actual = readFileSync(actualPath)
    if (fresh.equals(actual)) return true

    const freshText = normaliseEndings(fresh.toString('utf8'))
    const actualText = normaliseEndings(actual.toString('utf8'))
    if (freshText === actualText) return true

    if (!hasManagedBlock(freshText)) return false

    // More than one block is drift even when the one we maintain is correct.
    // Comparing only the last let a duplicate — the shape a "keep both sides"
    // merge produces, now that generated config is committed — sit in the file
    // forever: the check was green, so `sync` short-circuited, so the collapse
    // that would have healed it never ran. The invariant has to be visible to
    // the command, not just enforced inside the writer.
    if (countManagedBlocks(actualText) !== countManagedBlocks(freshText)) return false



    const freshBlock = extractManagedBlock(freshText)
    const actualBlock = extractManagedBlock(actualText)
    return freshBlock !== null && freshBlock === actualBlock
  } catch {
    return false
  }
}

/**
 * Line endings are git's business, not the compiler's.
 *
 * Git for Windows defaults to `core.autocrlf=true`, so a checkout there converts
 * every committed file to CRLF while the compiler always writes LF. Byte
 * comparison therefore reported every single generated file as drifted, on every
 * run, with no way to make it pass. This is new exposure: until the generated
 * config was committed, git never touched it.
 */
function normaliseEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
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
    const generated = filesUnder(fresh)
    for (const rel of generated) {
      const f = join(fresh, rel)
      const a = join(actual, rel)
      const shown = `${managedPath.replace(/\/$/, '')}/${rel}`
      checked++
      if (!existsSync(a)) drift.push({ ide, path: shown, kind: 'missing' })
      else if (!sameContent(f, a)) drift.push({ ide, path: shown, kind: 'changed' })
    }
    // `update` deletes each framework directory before recompiling, so a file
    // someone dropped in by hand disappears on the next sync with no warning.
    // Reporting it as drift is the warning.
    const expected = new Set(generated)
    for (const rel of filesUnder(actual)) {
      if (expected.has(rel)) continue
      drift.push({ ide, path: `${managedPath.replace(/\/$/, '')}/${rel}`, kind: 'extra' })
    }
    return checked
  }

  if (!existsSync(actual)) {
    drift.push({ ide, path: managedPath, kind: 'missing' })
  } else if (!sameContent(fresh, actual)) {
    // Keyed on the state, not on `fixable`.
    //
    // `fixable` answers "can the *structure* be reduced". Using it to classify
    // *content* drift conflated two questions: a file with one block and one
    // stray marker is unreducible as a structure but its block resyncs
    // perfectly, so a stale body in it was reported as "no command will change
    // these" — and one `sync` changed it. Only a file the writer will not touch
    // at all belongs in that category.
    // A file we cannot read is drift only a person can clear, not a crash.
    let actualText: string
    try {
      actualText = readFileSync(actual, 'utf8')
    } catch (err) {
      drift.push({
        ide,
        path: managedPath,
        kind: 'unreducible',
        detail: `cannot be read — ${(err as Error).message}`,
        fix: 'fix the permissions or replace the file; this one needs a person',
      })
      return 1
    }
    const diagnosis = diagnoseManagedFile(actualText)
    drift.push({
      ide,
      path: managedPath,
      kind:
        diagnosis.state === 'unreducible' || diagnosis.state === 'severed'
          ? 'unreducible'
          : 'changed',
      ...((diagnosis.state === 'unreducible' || diagnosis.state === 'severed') && {
        detail: diagnosis.detail,
        fix: diagnosis.fix,
      }),
    })
  }
  return 1
}

export async function buildCheckReport(pkgRoot: string, projectRoot: string): Promise<CheckReport> {
  const manifest = await readManifest(projectRoot)
  if (!manifest) return { installed: false, ides: [], drift: [], checked: 0 }

  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter(
    (id): id is IdeChoice => id in IDE_ADAPTERS,
  )

  const stack: StackConfig = resolveStack({ ...manifest, ides })
  const repoInfo = manifest.repoInfo ?? mergeStackIntoRepoInfo(await detectRepoInfo(projectRoot), stack)

  const drift: Drift[] = []
  let checked = 0

  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const scratch = mkdtempSync(join(tmpdir(), `opencastle-check-${ide}-`))
    try {
      await adapter.install(pkgRoot, scratch, stack, repoInfo)
      // Framework and merged paths are compared. Customizable paths are the
      // user's by design — reporting those as drift would make the check useless.
      // Merged paths must be included or the root instruction file, the one file
      // most likely to be edited by hand, would be the only thing never checked.
      const managed = adapter.getManagedPaths()
      for (const managedPath of [...managed.framework, ...(managed.merged ?? [])]) {
        checked += comparePath(managedPath, scratch, projectRoot, ide, drift)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  // A whole instruction set from an older release, sitting above our block.
  //
  // `sameContent` compares the block and finds it correct, so this passed the
  // documented CI gate while `doctor` failed on the same file — two full sets
  // of instructions the assistant reads, the stale one naming personas the
  // upgrade had just deleted. Reported here as needing a person, because only
  // they can tell where their own writing ends.
  {
    const manifestForRoots = await readManifest(projectRoot)
    if (manifestForRoots) {
      const { resolveManagedPaths } = await import('./managed-paths.js')
      for (const rel of (await resolveManagedPaths(manifestForRoots)).merged) {
        const abs = resolve(projectRoot, rel)
        if (!existsSync(abs)) continue
        let text: string
        try {
          text = readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        // Only when the structure is otherwise clean, which is how `doctor`
        // asks it. A torn file's residue is *this* release's body orphaned by a
        // missing end marker, not an older release's — reporting it here called
        // it "from an older OpenCastle release" and re-flagged a state the torn
        // diagnosis already owns.
        // Structural damage first, so the gate sees the states `doctor` fails
        // on. `comparePath` only ever classifies a file whose *content* it has
        // already found to differ, so a torn root file with a perfectly correct
        // block passed CI while `doctor` exited 1 naming it — the same hole
        // that was closed for `.gitignore` one file over.
        // `unreducible` only — two blocks the tool will not reduce, which is
        // real harm the assistant reads. A lone stray marker is *not* gated
        // here: the commonest way to get one is a file documenting the
        // convention, and failing CI on that would be a red the user could
        // only clear by deleting their own documentation. `doctor` warns and
        // names it, which is the right weight for something that breaks
        // nothing.
        const diagnosis = diagnoseManagedFile(text)
        // `severed` too: nothing will be written to that file until a person
        // acts, so CI must not pass over it. `torn` stays out — an intact block
        // beside a documented marker breaks nothing.
        if (diagnosis.state === 'unreducible' || diagnosis.state === 'severed') {
          if (!drift.some((d) => d.path === rel)) {
            drift.push({
              ide: 'all',
              path: rel,
              kind: 'unreducible',
              detail: diagnosis.detail,
              fix: diagnosis.fix,
            })
          }
          continue
        }
        if (diagnosis.state !== 'clean') continue
        if (!carriesLegacyBody(stripManagedBlock(text))) continue
        if (drift.some((d) => d.path === rel)) continue
        drift.push({
          ide: 'all',
          path: rel,
          kind: 'unreducible',
          detail: 'contains a whole instruction set from an older OpenCastle release,' +
            ' above the managed block',
          fix: 'delete the generated text above the OpenCastle block — it is superseded,' +
            ' and only you can tell where your own writing ends',
        })
      }
    }
  }

  // `.gitignore` is co-owned and is the one file whose loss cannot be noticed
  // by reading it, yet the documented CI gate never looked at it: a
  // `.gitignore` the writer refuses to reduce left `doctor` red and this
  // command green, so CI passed over the exact state a person has to resolve.
  {
    const gi = resolve(projectRoot, '.gitignore')
    if (existsSync(gi)) {
      // Guarded like every other read of a user file. An unreadable
      // `.gitignore` made `sync` exit 1 while this command, `doctor` and
      // `status` all exited 0 — the same shape as the `.mcp.json` twin fixed a
      // round ago, one file over.
      let giText: string | null = null
      try {
        giText = readFileSync(gi, 'utf8')
      } catch (err) {
        drift.push({
          ide: 'all',
          path: '.gitignore',
          kind: 'unreducible',
          detail: `cannot be read — ${(err as Error).message}`,
          fix: 'fix the permissions or replace the file; this one needs a person',
        })
      }
      if (giText !== null) {
      // The block's *contents*, not only its structure. Deleting `.env` from
      // inside it left every surface green while `.env` became committable —
      // the one co-owned file whose loss cannot be noticed by reading it, with
      // its content checked by nothing.
      // Normalised, for the reason `sameContent` gives above: a Git for Windows
      // checkout rewrites every committed file to CRLF, so a byte comparison
      // reported `.gitignore` as drifted on every run there — and `sync`'s
      // "fix" produced nothing to commit, because git normalises on staging.
      // Permanently red CI with an uncommittable remedy, which is exactly the
      // failure `normaliseEndings` exists to prevent, on the comparison added
      // one commit after it.
      const wanted = normaliseEndings(buildGitignoreBlock())
      const region = extractRegion(giText, GITIGNORE_START, GITIGNORE_END)
      const actual = region === null ? null : normaliseEndings(region)
      // `null` — the block removed altogether — is the *larger* deletion, and it
      // fell straight through this test: `.env`, the run artefacts and the
      // rescue directory all stopped being ignored, `.env` became committable,
      // and every surface reported health. The case the check was written for
      // was caught and the bigger one beside it was not.
      if (actual === null || actual.trim() !== wanted.trim()) {
        drift.push({
          ide: 'all',
          path: '.gitignore',
          kind: 'changed',
          ...(actual === null && {
            detail: 'the OpenCastle block is gone, so .env and the run artefacts are no' +
              ' longer ignored',
          }),
        })
      }
      const d = diagnoseManagedFile(giText, GITIGNORE_START, GITIGNORE_END)
      // `unreducible` only, matching how root files are weighted twenty lines
      // up. `!d.fixable` includes `torn`, so a lone stray marker — the state
      // deliberately downgraded to a warning because the commonest way to get
      // one is a file documenting the convention — still failed CI here,
      // permanently, on the very file this gate was added for. `doctor` called
      // the same bytes healthy throughout.
      if (d.state === 'unreducible' || d.state === 'severed') {
        drift.push({
          ide: 'all',
          path: '.gitignore',
          kind: 'unreducible',
          detail: d.detail,
          fix: d.fix,
        })
      }
      }
    }
  }

  // A manifest that parses but names no target this release knows is not a
  // clean project — `sync` exits 1 on it. Reporting "0 generated files match
  // their sources across 0 targets" is an assertion that cannot fail, and it
  // turned the drift gate into a silent pass over an install with 78 files on
  // disk.
  if (ides.length === 0) {
    drift.push({
      ide: 'all',
      path: '.opencastle/manifest.json',
      kind: 'unreducible',
      detail: 'names no target this release recognises, so nothing could be compared',
      fix: 'fix the "ides" field, or re-run opencastle init; this one needs a person',
    })
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
  const extra = report.drift.filter((d) => d.kind === 'extra')
  const unreducible = report.drift.filter((d) => d.kind === 'unreducible')

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
  if (extra.length > 0) {
    console.log(`  ${c.bold('Added by hand')} ${c.dim('(deleted on the next sync)')}`)
    for (const d of extra) console.log(`    ${c.red('+')} ${d.path} ${c.dim(`(${d.ide})`)}`)
    console.log('')
  }

  if (unreducible.length > 0) {
    console.log(`  ${c.bold('Needs a person')} ${c.dim('(no command will change these)')}`)
    // The classifier's sentence, not a second one written here. The hard-coded
    // line said "more than one block" about files that had exactly one, while
    // `doctor` — reading the same classifier — described them correctly.
    // Per entry, including the remedy. A single trailing sentence was printed
    // for every state here — "keep one start/end pair" over a file whose
    // problem was a superseded instruction set — which is the same hard-coded
    // wording that told users a file held more than one block when it held one.
    for (const d of unreducible) {
      console.log(`    ${c.red('!')} ${d.path} ${c.dim(`(${d.ide})`)}`)
      if (d.detail) console.log(`      ${c.dim(d.detail)}`)
      if (d.fix) console.log(`      ${c.dim(`→ ${d.fix}`)}`)
    }
    console.log('')
  }

  // Only when something here is actually fixable by it. `sync` was printed
  // unconditionally, so a file the writer refuses to touch produced a red check
  // recommending the command that refuses — CI red forever on a no-op.
  if (report.drift.length > unreducible.length) {
    console.log(`  ${c.bold('Fix:')} ${c.cyan('opencastle sync')}`)
    console.log(`  ${c.dim('To keep an edit, move it into .opencastle/ instead — that directory is yours.')}\n`)
  } else {
    console.log(`  ${c.bold('Fix:')} ${c.dim('by hand — see above, then run')} ${c.cyan('opencastle doctor')}\n`)
  }
}

/** Exits non-zero on drift so CI fails. */
export async function runCheck({ pkgRoot, args }: CliContext): Promise<void> {
  let report: CheckReport
  try {
    report = await buildCheckReport(pkgRoot, process.cwd())
  } catch (err) {
    // A comparison that could not run is a finding, reported like any other —
    // and reported as one only a person can clear, because `sync` fails on the
    // same path. The bare exception that used to come out here exited 1 with no
    // verdict, no remedy, and (with `--json`) no JSON at all, so a CI consumer
    // got a parse error instead of a report.
    const failure: CheckReport = {
      installed: true,
      ides: [],
      checked: 0,
      drift: [
        {
          ide: 'all',
          path: (err as Error).message,
          kind: 'unreducible',
          detail: 'the comparison could not run',
          fix: 'fix the path named above, then run opencastle sync; this one needs a person',
        },
      ],
    }
    if (args.includes('--json')) console.log(JSON.stringify(failure, null, 2))
    else render(failure)
    process.exit(1)
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    render(report)
  }

  if (!report.installed || report.drift.length > 0) process.exit(1)
}
