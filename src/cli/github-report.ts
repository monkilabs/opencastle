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

const TITLES: Record<DriftKind, string> = {
  changed: 'Generated file edited in place',
  missing: 'Generated file never committed',
  extra: 'File added inside generated output',
  unreducible: 'Needs a person',
}

/** What the reader should do, per kind — they do not share a remedy. */
function explain(d: Drift): string {
  switch (d.kind) {
    case 'changed':
      return `${d.path} (${d.ide}) no longer matches its source, so the next \`opencastle sync\` overwrites this edit. To keep it, move the change into .opencastle/ — that directory is yours.`
    case 'missing':
      return `${d.path} (${d.ide}) should exist but does not. Run \`opencastle sync\` and commit the result; generated config is committed like a lockfile.`
    case 'extra':
      return `${d.path} (${d.ide}) sits in generated output but no source produces it, so the next \`opencastle sync\` deletes it.`
    case 'unreducible':
      return [d.detail, d.fix && `Fix: ${d.fix}`].filter(Boolean).join('. ') || `${d.path} (${d.ide}) needs a person.`
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
    // An unreducible entry can carry an error message where the path would be,
    // when the comparison itself could not run. There is no file to pin it to.
    if (d.ide !== 'all') props.unshift(`file=${escapeProperty(annotationPath(d.path, projectRoot, workspace))}`)
    return `::error ${props.join(',')}::${escapeData(explain(d))}`
  })
}

/** Markdown for the run summary page. */
export function summaryMarkdown(report: CheckReport): string {
  const heading = '### OpenCastle — generated assistant config\n\n'
  if (!report.installed) {
    return `${heading}❌ No OpenCastle installation found. Run \`npx opencastle init\` and commit the result.\n`
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
    `${heading}❌ ${report.drift.length} file${report.drift.length === 1 ? '' : 's'} differ from their sources.\n\n` +
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
