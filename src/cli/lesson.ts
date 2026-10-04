import { stat, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { CliContext } from './types.js'
import { scanForSecrets } from './secret-scan.js'
import {
  LESSON_CATEGORIES,
  LESSON_SEVERITIES,
  LESSONS_DIR,
  LESSONS_INDEX,
  citationProblem,
  findLesson,
  fingerprintsOf,
  isLessonCategory,
  isLessonSeverity,
  lessonBody,
  newLessonId,
  readLessons,
  renderLesson,
  syncLessons,
  today,
  type Lesson,
} from './lessons.js'

const HELP = `
  npx opencastle lesson [add] --title <text> --category <cat> --severity <level> --problem <text> [options]
  npx opencastle lesson verify <id> [--cite <path[:line]>]...
  npx opencastle lesson archive <id> --into <file>

  Record what an agent learned the hard way, as a file in .opencastle/lessons/,
  and rewrite the index agents read before they start (.opencastle/${LESSONS_INDEX}).

  add (the default)   Write a new lesson. --title, --category, --severity and
                      --problem are required.
  verify <id>         Say a lesson still holds: stamps today's date and what
                      the cited files hold now, so doctor stops reporting them
                      as changed. --cite replaces its citations.
  archive <id>        Mark a lesson merged into a skill or instruction file,
                      named with --into. It stays on record and leaves the
                      list agents read.

  Options:
    --title <text>           Short descriptive title
    --category <cat>         One of: ${LESSON_CATEGORIES.join(', ')}
    --severity <level>       One of: ${LESSON_SEVERITIES.join(', ')}
    --problem <text>         What went wrong
    --wrong <text>           The approach that was tried and failed
    --correct <text>         The approach that works
    --why <text>             Root cause
    --cite <path[:line]>     Code the lesson is about, relative to the project
                             root; repeat for more than one. doctor reports a
                             lesson whose cited code changes after it was verified
    --into <file>            archive: where the lesson now lives
    --customizations-dir <p> Use this .opencastle directory instead of finding one
    --dry-run                Print what would be written, and write nothing
    --help, -h               Show this help

  Examples:
    npx opencastle lesson \\
      --title "Always quote shell variables" \\
      --category terminal \\
      --severity medium \\
      --problem "Unquoted variables break on paths with spaces" \\
      --wrong 'rm -rf $DIR/old' \\
      --correct 'rm -rf "$DIR/old"' \\
      --cite scripts/clean.sh:12

    npx opencastle lesson verify 2026-10-02-always-quote-shell-variables
    npx opencastle lesson archive 2026-10-02-always-quote-shell-variables \\
      --into .opencastle/skills/git-workflow/SKILL.md
`

/** The `.opencastle/` this lesson belongs to: the override, or the nearest one up from here. */
async function resolveCustomizationsDir(override: string | null): Promise<string> {
  if (override) return override
  let dir = process.cwd()
  for (;;) {
    try {
      const s = await stat(join(dir, '.opencastle'))
      if (s.isDirectory()) return join(dir, '.opencastle')
    } catch {
      // .opencastle not found here, walk up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), '.opencastle')
}

function fail(message: string): never {
  console.error(`  \u2717 ${message}`)
  process.exit(1)
}

interface Parsed {
  positional: string[]
  values: Map<string, string>
  cites: string[]
  dryRun: boolean
}

const VALUE_FLAGS = new Set([
  '--title',
  '--category',
  '--severity',
  '--problem',
  '--wrong',
  '--correct',
  '--why',
  '--into',
  '--customizations-dir',
])

function parse(args: string[]): Parsed {
  const out: Parsed = { positional: [], values: new Map(), cites: [], dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry-run' || a === '--dryRun') {
      out.dryRun = true
    } else if (a === '--cite' || VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) fail(`${a} requires a value`)
      const value = args[++i]
      if (!value.trim()) fail(`${a} cannot be empty`)
      if (a === '--cite') out.cites.push(value.trim())
      else out.values.set(a, value)
    } else if (a.startsWith('-')) {
      fail(`unknown option ${a} — run "npx opencastle lesson --help"`)
    } else {
      out.positional.push(a)
    }
  }
  return out
}

/**
 * A credential written into a lesson is committed with it. Refused, naming the
 * line, the way a convoy refuses one in its own output.
 */
function refuseSecrets(text: string, where: string): void {
  const scan = scanForSecrets(text, where)
  if (scan.clean) return
  const first = scan.findings[0]
  fail(`${where} would hold what looks like a ${first.pattern} (line ${first.line}) — a lesson is committed, so describe the credential instead of pasting it`)
}

function checkCitations(projectRoot: string, cites: string[]): void {
  for (const cite of cites) {
    const problem = citationProblem(projectRoot, cite)
    if (problem) fail(`--cite: ${problem}`)
  }
}

async function writeLessonFile(dir: string, lesson: Omit<Lesson, 'file'>, file: string, dryRun: boolean): Promise<void> {
  const text = renderLesson(lesson)
  const rel = `${LESSONS_DIR}/${file}`
  refuseSecrets(text, rel)
  if (dryRun) {
    console.log(`  [dry-run] Would write .opencastle/${rel}:\n`)
    console.log(text)
    return
  }
  await mkdir(join(dir, LESSONS_DIR), { recursive: true })
  await writeFile(join(dir, LESSONS_DIR, file), text)
}

/** Rewrite the index, after moving anything still in the old single file. */
function reindex(dir: string): void {
  const outcome = syncLessons(dir)
  if (outcome.migrated > 0) {
    console.log(
      `  Moved ${outcome.migrated} lesson(s) from ${LESSONS_INDEX} into .opencastle/${LESSONS_DIR}/` +
        (outcome.backup ? ` (the old file is kept as ${outcome.backup})` : ''),
    )
  }
}

async function add(dir: string, projectRoot: string, p: Parsed): Promise<void> {
  const title = p.values.get('--title')
  const category = p.values.get('--category')
  const severity = p.values.get('--severity')
  const problem = p.values.get('--problem')
  const missing = [
    !title && '--title',
    !category && '--category',
    !severity && '--severity',
    !problem && '--problem',
  ].filter(Boolean)
  if (missing.length > 0) fail(`Missing required flags: ${missing.join(', ')}\n  Run "npx opencastle lesson --help" for usage.`)
  if (!isLessonCategory(category!)) fail(`Invalid --category "${category}". Must be one of: ${LESSON_CATEGORIES.join(', ')}`)
  if (!isLessonSeverity(severity!)) fail(`Invalid --severity "${severity}". Must be one of: ${LESSON_SEVERITIES.join(', ')}`)
  checkCitations(projectRoot, p.cites)

  // Lessons still in the old file keep their numbers, so they are counted
  // among the taken ids before this one is named.
  if (!p.dryRun) reindex(dir)
  const { lessons } = readLessons(dir)
  const date = today()
  const id = newLessonId(title!, date, new Set(lessons.map((l) => l.id)))
  const lesson: Omit<Lesson, 'file'> = {
    id,
    title: title!.replace(/[\r\n]+/g, ' ').trim(),
    category: category!,
    severity: severity!,
    added: date,
    citations: p.cites,
    ...(p.cites.length > 0 && { verified: date, fingerprints: fingerprintsOf(projectRoot, p.cites) }),
    status: 'active',
    body: lessonBody({
      problem: problem!,
      wrong: p.values.get('--wrong'),
      correct: p.values.get('--correct'),
      why: p.values.get('--why'),
    }),
  }
  await writeLessonFile(dir, lesson, `${id}.md`, p.dryRun)
  if (p.dryRun) return
  reindex(dir)
  console.log(`${id}: ${lesson.title}`)
}

async function verify(dir: string, projectRoot: string, p: Parsed): Promise<void> {
  const [ref] = p.positional
  if (!ref) fail('verify needs the id of a lesson, e.g. npx opencastle lesson verify 2026-10-02-always-quote-shell-variables')
  checkCitations(projectRoot, p.cites)
  if (!p.dryRun) reindex(dir)
  const { lessons } = readLessons(dir)
  const lesson = findLesson(lessons, ref)
  if (!lesson) fail(`no lesson ${ref} in .opencastle/${LESSONS_DIR}/`)
  const citations = p.cites.length > 0 ? p.cites : lesson.citations
  for (const cite of citations) {
    const problem = citationProblem(projectRoot, cite)
    if (problem) fail(`${lesson.id} cites ${cite}: ${problem} — pass --cite with where it is now`)
  }
  const updated: Lesson = { ...lesson, citations, verified: today(), fingerprints: fingerprintsOf(projectRoot, citations) }
  await writeLessonFile(dir, updated, lesson.file, p.dryRun)
  if (p.dryRun) return
  reindex(dir)
  console.log(`${lesson.id}: verified ${updated.verified}`)
}

async function archive(dir: string, projectRoot: string, p: Parsed): Promise<void> {
  const [ref] = p.positional
  const into = p.values.get('--into')
  if (!ref) fail('archive needs the id of a lesson, e.g. npx opencastle lesson archive 2026-10-02-always-quote-shell-variables --into <file>')
  if (!into) fail('archive needs --into <file>: the skill or instruction file the lesson was merged into')
  const problem = citationProblem(projectRoot, into)
  if (problem) fail(`--into: ${problem}`)
  if (!p.dryRun) reindex(dir)
  const { lessons } = readLessons(dir)
  const lesson = findLesson(lessons, ref)
  if (!lesson) fail(`no lesson ${ref} in .opencastle/${LESSONS_DIR}/`)
  await writeLessonFile(dir, { ...lesson, status: 'archived', mergedInto: into.replace(/^\.\//, '') }, lesson.file, p.dryRun)
  if (p.dryRun) return
  reindex(dir)
  console.log(`${lesson.id}: archived, merged into ${into}`)
}

export default async function lesson({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }
  const sub = args[0] === 'add' || args[0] === 'verify' || args[0] === 'archive' ? args[0] : 'add'
  const p = parse(args[0] === sub ? args.slice(1) : args)
  const dir = await resolveCustomizationsDir(p.values.get('--customizations-dir') ?? null)
  const projectRoot = dirname(dir)
  try {
    await stat(dir)
  } catch {
    fail(`no .opencastle/ directory at ${dir} — run npx opencastle init first`)
  }
  if (sub === 'add' && p.positional.length > 0) {
    fail(`unexpected argument "${p.positional[0]}" — did you mean npx opencastle lesson verify or archive?`)
  }
  if (sub === 'add') return add(dir, projectRoot, p)
  if (sub === 'verify') return verify(dir, projectRoot, p)
  return archive(dir, projectRoot, p)
}
