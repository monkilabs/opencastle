import { readFile, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { CliContext } from './types.js'

const CATEGORIES = [
  'task-management',
  'jira',
  'mcp-tools',
  'codebase-tool',
  'terminal',
  'framework',
  'cms',
  'database',
  'git',
  'deployment',
  'browser-testing',
  'general',
] as const

type Category = (typeof CATEGORIES)[number]

const SEVERITIES = ['high', 'medium', 'low'] as const
type Severity = (typeof SEVERITIES)[number]

const HELP = `
  opencastle lesson [options]

  Append a structured lesson to .opencastle/LESSONS-LEARNED.md

  Required flags:
    --title <text>           Short descriptive title
    --category <cat>         One of: ${CATEGORIES.join(', ')}
    --severity <level>       One of: high, medium, low
    --problem <text>         What went wrong

  Optional flags:
    --wrong <text>           The wrong approach that was tried
    --correct <text>         The correct approach that works
    --why <text>             Root cause explanation
    --customizations-dir <p> Override the customizations directory path
    --dry-run                Preview what would be appended without writing
    --help, -h               Show this help

  Examples:
    opencastle lesson \\
      --title "Never call foo without bar" \\
      --category general \\
      --severity high \\
      --problem "foo throws on Node 18 without bar"

    opencastle lesson \\
      --title "Always quote shell variables" \\
      --category terminal \\
      --severity medium \\
      --problem "Unquoted variables break on paths with spaces" \\
      --wrong 'rm -rf \$DIR/old' \\
      --correct 'rm -rf "\$DIR/old"' \\
      --why "Word splitting expands spaces into separate arguments"
`

function isCategory(s: string): s is Category {
  return (CATEGORIES as ReadonlyArray<string>).includes(s)
}

function isSeverity(s: string): s is Severity {
  return (SEVERITIES as ReadonlyArray<string>).includes(s)
}

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

function nextLessonId(content: string): string {
  const matches = [...content.matchAll(/^### LES-(\d+)/gm)]
  if (matches.length === 0) return 'LES-001'
  const last = Math.max(...matches.map((m) => parseInt(m[1], 10)))
  return `LES-${String(last + 1).padStart(3, '0')}`
}

function escapeMarkdown(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[\n\r]/g, ' ')
}

function formatLesson(opts: {
  id: string
  title: string
  category: Category
  severity: Severity
  date: string
  problem: string
  wrong?: string
  correct?: string
  why?: string
}): string {
  const title = opts.title.replace(/[\n\r]/g, ' ')
  const lines: string[] = [
    `### ${opts.id}: ${title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Category** | \`${opts.category}\` |`,
    `| **Added** | ${opts.date} |`,
    `| **Severity** | \`${opts.severity}\` |`,
    '',
    `**Problem:** ${escapeMarkdown(opts.problem)}`,
  ]
  if (opts.wrong !== undefined) lines.push('', `**Wrong approach:** ${escapeMarkdown(opts.wrong)}`)
  if (opts.correct !== undefined) lines.push('', `**Correct approach:** ${escapeMarkdown(opts.correct)}`)
  if (opts.why !== undefined) lines.push('', `**Why:** ${escapeMarkdown(opts.why)}`)
  return lines.join('\n')
}

function insertLesson(content: string, block: string): string {
  const marker = '\n## Index by Category'
  const idx = content.indexOf(marker)
  if (idx === -1) {
    return content.trimEnd() + '\n\n' + block + '\n'
  }
  // Insert block right before the \n## Index sequence
  return content.slice(0, idx) + '\n' + block + '\n' + content.slice(idx)
}

function updateIndex(content: string, category: string, lessonId: string): string {
  const lines = content.split('\n')
  let found = false

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\| `([^`]+)` \| (.+) \|$/)
    if (m && m[1] === category) {
      const current = m[2].trim()
      const updated = current === '\u2014' ? lessonId : `${current}, ${lessonId}`
      lines[i] = `| \`${category}\` | ${updated} |`
      found = true
      break
    }
  }

  if (!found) {
    // Row doesn't exist — append after the last table row in the Index section
    const indexHeading = lines.findIndex((l) => l.trim() === '## Index by Category')
    if (indexHeading !== -1) {
      let lastTableRow = -1
      for (let i = indexHeading; i < lines.length; i++) {
        if (lines[i].startsWith('|')) lastTableRow = i
        else if (lastTableRow > indexHeading && lines[i].trim() !== '') break
      }
      if (lastTableRow !== -1) {
        lines.splice(lastTableRow + 1, 0, `| \`${category}\` | ${lessonId} |`)
      }
    }
  }

  return lines.join('\n')
}

export interface LessonInput {
  title: string
  category: string
  severity: string
  problem: string
  wrong?: string
  correct?: string
  why?: string
}

/**
 * Append a structured lesson to LESSONS-LEARNED.md programmatically.
 * Returns the generated lesson ID (e.g., "LES-005").
 */
export async function appendLesson(
  input: LessonInput,
  customizationsDir?: string | null,
): Promise<string> {
  if (!isCategory(input.category)) {
    throw new Error(`Invalid category "${input.category}". Must be one of: ${CATEGORIES.join(', ')}`)
  }
  if (!isSeverity(input.severity)) {
    throw new Error(`Invalid severity "${input.severity}". Must be one of: ${SEVERITIES.join(', ')}`)
  }
  const category = input.category
  const severity = input.severity

  const resolvedDir = await resolveCustomizationsDir(customizationsDir ?? null)
  const lessonsFile = join(resolvedDir, 'LESSONS-LEARNED.md')

  let content: string
  try {
    content = await readFile(lessonsFile, 'utf8')
  } catch {
    throw new Error(`LESSONS-LEARNED.md not found at: ${lessonsFile}`)
  }

  const id = nextLessonId(content)
  const date = new Date().toISOString().slice(0, 10)

  const block = formatLesson({
    id,
    title: input.title,
    category,
    severity,
    date,
    problem: input.problem,
    wrong: input.wrong,
    correct: input.correct,
    why: input.why,
  })

  let updated = insertLesson(content, block)
  updated = updateIndex(updated, category, id)

  await writeFile(lessonsFile, updated, 'utf8')
  return id
}

export default async function lesson({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }

  const dryRun = args.includes('--dry-run') || args.includes('--dryRun')
  let title: string | null = null
  let category: string | null = null
  let severity: string | null = null
  let problem: string | null = null
  let wrong: string | undefined
  let correct: string | undefined
  let why: string | undefined
  let customizationsDir: string | null = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case '--title':
        if (i + 1 >= args.length) { console.error('  \u2717 --title requires a value'); process.exit(1) }
        title = args[++i]
        if (!title.trim()) { console.error('  \u2717 --title cannot be empty'); process.exit(1) }
        break
      case '--category':
        if (i + 1 >= args.length) { console.error('  \u2717 --category requires a value'); process.exit(1) }
        category = args[++i]
        if (!category.trim()) { console.error('  \u2717 --category cannot be empty'); process.exit(1) }
        break
      case '--severity':
        if (i + 1 >= args.length) { console.error('  \u2717 --severity requires a value'); process.exit(1) }
        severity = args[++i]
        if (!severity.trim()) { console.error('  \u2717 --severity cannot be empty'); process.exit(1) }
        break
      case '--problem':
        if (i + 1 >= args.length) { console.error('  \u2717 --problem requires a value'); process.exit(1) }
        problem = args[++i]
        if (!problem.trim()) { console.error('  \u2717 --problem cannot be empty'); process.exit(1) }
        break
      case '--wrong':
        if (i + 1 >= args.length) { console.error('  \u2717 --wrong requires a value'); process.exit(1) }
        wrong = args[++i]
        if (!wrong.trim()) { console.error('  \u2717 --wrong cannot be empty'); process.exit(1) }
        break
      case '--correct':
        if (i + 1 >= args.length) { console.error('  \u2717 --correct requires a value'); process.exit(1) }
        correct = args[++i]
        if (!correct.trim()) { console.error('  \u2717 --correct cannot be empty'); process.exit(1) }
        break
      case '--why':
        if (i + 1 >= args.length) { console.error('  \u2717 --why requires a value'); process.exit(1) }
        why = args[++i]
        if (!why.trim()) { console.error('  \u2717 --why cannot be empty'); process.exit(1) }
        break
      case '--customizations-dir':
        if (i + 1 >= args.length) { console.error('  \u2717 --customizations-dir requires a path'); process.exit(1) }
        customizationsDir = args[++i]
        if (!customizationsDir.trim()) { console.error('  \u2717 --customizations-dir cannot be empty'); process.exit(1) }
        break
    }
  }

  const missing: string[] = []
  if (!title) missing.push('--title')
  if (!category) missing.push('--category')
  if (!severity) missing.push('--severity')
  if (!problem) missing.push('--problem')

  if (missing.length > 0) {
    console.error(`  \u2717 Missing required flags: ${missing.join(', ')}`)
    console.error('  Run "opencastle lesson --help" for usage.')
    process.exit(1)
  }

  if (!isCategory(category!)) {
    console.error(`  \u2717 Invalid --category "${category}". Must be one of: ${CATEGORIES.join(', ')}`)
    process.exit(1)
  }

  if (!isSeverity(severity!)) {
    console.error(`  \u2717 Invalid --severity "${severity}". Must be one of: ${SEVERITIES.join(', ')}`)
    process.exit(1)
  }

  if (dryRun) {
    console.log(`  [dry-run] Would append lesson to LESSONS-LEARNED.md:`)
    console.log(`  Title: ${title}`)
    return
  }

  try {
    const id = await appendLesson(
      { title: title!, category: category!, severity: severity!, problem: problem!, wrong, correct, why },
      customizationsDir,
    )
    console.log(`${id}: ${title}`)
  } catch (err: unknown) {
    console.error(`  \u2717 ${(err as Error).message}`)
    process.exit(1)
  }
}
