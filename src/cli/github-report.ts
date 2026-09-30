import { appendFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CheckReport, Drift, DriftKind } from './sync-check.js'

/**
 * Drift, told to GitHub in the two forms a pull request shows.
 *
 * `sync --check` in CI used to fail with its findings in the job log, which is
 * three clicks from the pull request that caused them and read by nobody who
 * did not already know to look. GitHub reads two things from a step without any
 * extra action: workflow-command lines on stdout become annotations on the
 * files in the PR, and Markdown appended to `$GITHUB_STEP_SUMMARY` becomes the
 * run's summary page. Both are written here, only when `GITHUB_ACTIONS` says the
 * step is running on GitHub, so a local run and every other CI print exactly
 * what they printed before.
 */

/**
 * The detail `sync --check` records when the comparison itself could not run.
 * Its `path` is then an error message, not a file, so it is the one drift that
 * is not pinned to a file.
 */
export const COMPARISON_FAILED = 'the comparison could not run'

const TITLES: Record<DriftKind, string> = {
  changed: 'Generated file differs from its source',
  missing: 'Generated file never committed',
  extra: 'File added inside generated output',
  outdated: 'MCP server still at an earlier default',
  unreducible: 'Needs a person',
}

function isComparisonFailure(d: Drift): boolean {
  return d.kind === 'unreducible' && d.detail === COMPARISON_FAILED
}

/** What the reader should do, per kind — they do not share a remedy. */
function explain(d: Drift): string {
  const where = `${d.path} (${d.ide})`
  switch (d.kind) {
    // Not "edited by hand": the same state follows an upgrade nobody recompiled
    // after, and blaming an edit that never happened sends people looking for it.
    case 'changed':
      return `${where} differs from a fresh compile of its source. Run \`opencastle sync\` and commit the result. If the difference is a hand edit you want to keep, move it into .opencastle/ first — sync overwrites generated files.`
    case 'missing':
      return `${where} should exist but does not. Run \`opencastle sync\` and commit the result; generated config is committed like a lockfile.`
    case 'extra':
      return `${where} sits in generated output but no source produces it, so the next \`opencastle sync\` deletes it.`
    case 'outdated':
      return `${where}: ${d.detail ?? 'an MCP server is still at an earlier default'}. Run \`opencastle sync\` and commit — it replaces only entries still exactly as OpenCastle wrote them.`
    case 'unreducible':
      if (isComparisonFailure(d)) return `The comparison could not run: ${d.path}.${d.fix ? ` Fix: ${d.fix}` : ''}`
      return [`${where}: ${d.detail ?? 'needs a person'}`, d.fix && `Fix: ${d.fix}`].filter(Boolean).join('. ')
  }
}

/** Workflow-command message escaping, as the runner decodes it. */
export function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** Property values additionally reserve `:` and `,`. */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

/**
 * The path GitHub should annotate: relative to the checkout, forward slashes.
 *
 * `sync --check` reports paths relative to the directory it ran in, and a
 * project in a monorepo runs in a subdirectory — annotating `CLAUDE.md` when
 * the file is `apps/web/CLAUDE.md` pins the comment on nothing.
 */
export function annotationPath(path: string, projectRoot: string, workspace?: string): string {
  const abs = isAbsolute(path) ? path : resolve(projectRoot, path)
  const base = workspace ? resolve(workspace) : projectRoot
  const rel = relative(base, abs)
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return (inside ? rel : path).split(sep).join('/')
}

/** One `::error` line per drifted file. */
export function annotations(report: CheckReport, projectRoot: string, workspace?: string): string[] {
  if (!report.installed) {
    return [`::error title=${escapeProperty('OpenCastle is not set up')}::${escapeData('No OpenCastle installation found. Run `npx opencastle init` and commit the result.')}`]
  }
  return report.drift.map((d) => {
    const props = [`title=${escapeProperty(TITLES[d.kind])}`]
    // Every drift names a file — `.gitignore`, a shared AGENTS.md, the manifest
    // — except the one recording that the comparison could not run, whose path
    // is an error message. Keying this on `ide === 'all'` left those real files
    // unpinned.
    if (!isComparisonFailure(d)) props.unshift(`file=${escapeProperty(annotationPath(d.path, projectRoot, workspace))}`)
    return `::error ${props.join(',')}::${escapeData(explain(d))}`
  })
}

/** Markdown for the run summary page. */
export function summaryMarkdown(report: CheckReport): string {
  const heading = '### OpenCastle — generated assistant config\n\n'
  if (!report.installed) {
    return `${heading}❌ No OpenCastle installation found. Run \`npx opencastle init\` and commit the result.\n`
  }
  const failed = report.drift.find(isComparisonFailure)
  if (failed) {
    return `${heading}❌ The comparison could not run: ${failed.path}.${failed.fix ? ` ${failed.fix}.` : ''}\n`
  }
  if (report.drift.length === 0) {
    return (
      `${heading}✅ ${report.checked} generated file${report.checked === 1 ? '' : 's'} match their sources ` +
      `across ${report.ides.length} target${report.ides.length === 1 ? '' : 's'} (${report.ides.join(', ')}).\n`
    )
  }
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const rows = report.drift.map(
    (d) => `| \`${cell(d.path)}\` | ${cell(d.ide)} | ${cell(TITLES[d.kind])} | ${cell(explain(d))} |`,
  )
  const fixable = report.drift.some((d) => d.kind !== 'unreducible')
  return (
    `${heading}❌ ${report.drift.length === 1 ? '1 file differs from its source' : `${report.drift.length} files differ from their sources`}.\n\n` +
    '| File | Target | What happened | What to do |\n| --- | --- | --- | --- |\n' +
    rows.join('\n') +
    '\n\n' +
    (fixable
      ? 'Run `npx opencastle sync` locally and commit the result.\n'
      : 'No command clears these; see each row.\n')
  )
}

/**
 * Write both forms when running on GitHub Actions.
 *
 * `json` suppresses the annotations: they are stdout lines, and a consumer
 * parsing `--json` output would choke on them. The summary is a file, so it is
 * still written. A summary file we cannot append to is not a reason to change
 * the check's verdict — the verdict is the exit code, and it stands.
 */
export function reportToGitHub(
  report: CheckReport,
  projectRoot: string,
  options: { json?: boolean; env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): void {
  const env = options.env ?? process.env
  if (env.GITHUB_ACTIONS !== 'true') return
  const write = options.write ?? ((line: string) => console.log(line))
  if (!options.json) {
    for (const line of annotations(report, projectRoot, env.GITHUB_WORKSPACE)) write(line)
  }
  const summaryFile = env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, summaryMarkdown(report) + '\n')
    } catch {
      // See above: the exit code is the verdict.
    }
  }
}
