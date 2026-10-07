import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LESSONS_DIR, readLessons, syncLessons, type Lesson, type LessonsSync } from './lessons.js'

/**
 * The team's lessons, in a file each assistant loads before every task on its
 * own.
 *
 * Lessons used to reach agents through a sentence in their instructions —
 * "read the index before you start" — which an agent follows when it decides
 * to. Project facts stopped depending on that by being compiled into what
 * every assistant loads; this does the same for lessons, through the place
 * each assistant loads rules from with no instruction at all: Claude Code's
 * `.claude/rules/` (a rule with no `paths` loads at launch), VS Code's
 * instructions with `applyTo: '**'`, and Cursor's and Windsurf's always-on
 * rules. Codex, OpenCode and Antigravity have one root file and no such place;
 * their agents still read the index by instruction.
 *
 * The file is derived from the lessons, like the index, so whatever writes a
 * lesson — `opencastle lesson`, `promote memory`, a convoy run, `sync` —
 * rewrites it at once, and `sync --check` holds it to the lessons, not to the
 * compile.
 */

export const LESSON_RULES: Readonly<Record<string, { path: string; frontmatter: string }>> = {
  'claude-code': { path: '.claude/rules/opencastle-lessons.md', frontmatter: '' },
  vscode: { path: '.github/instructions/opencastle-lessons.instructions.md', frontmatter: "---\napplyTo: '**'\n---\n\n" },
  cursor: {
    path: '.cursor/rules/opencastle-lessons.mdc',
    frontmatter: '---\ndescription: "What this team learned the hard way. Read before any task."\nalwaysApply: true\n---\n\n',
  },
  windsurf: { path: '.windsurf/rules/opencastle-lessons.md', frontmatter: '---\ntrigger: always_on\n---\n\n' },
}

/** True for a path one of these files sits at, which the compile does not produce. */
export function isLessonRule(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  return Object.values(LESSON_RULES).some((r) => r.path === norm)
}

/** The rule's text: the active lessons, titles and paths, newest first in each category. */
export function renderLessonsRule(ide: string, lessons: Lesson[]): string | null {
  const rule = LESSON_RULES[ide]
  if (!rule) return null
  const active = lessons.filter((l) => l.status === 'active').sort((a, b) => (a.added < b.added ? 1 : -1))
  const lines = [
    '<!-- Written by OpenCastle from .opencastle/lessons/ — edit the lessons, not this file. -->',
    '',
    '# Team lessons',
    '',
    'What agents on this team confirmed the hard way, each reviewed in a pull request.',
    'Before a task, open the lessons that touch it.',
    '',
  ]
  if (active.length === 0) lines.push('No lessons yet.')
  for (const l of active) {
    lines.push(`- **${l.title.replace(/\s+/g, ' ').trim()}** — \`${l.severity}\`, ${l.category} · \`.opencastle/${LESSONS_DIR}/${l.file}\``)
  }
  return `${rule.frontmatter}${lines.join('\n')}\n`
}

/** The assistants this project compiles for, from its manifest. */
export function manifestIdes(projectRoot: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(projectRoot, '.opencastle', 'manifest.json'), 'utf8')) as { ides?: unknown }
    return Array.isArray(manifest.ides) ? manifest.ides.filter((i): i is string => typeof i === 'string') : []
  } catch {
    return []
  }
}

/** Write each assistant's lessons rule that differs from the lessons; returns the paths written. */
export function writeLessonRules(projectRoot: string, ides: readonly string[]): string[] {
  const { lessons } = readLessons(join(projectRoot, '.opencastle'))
  const written: string[] = []
  for (const ide of ides) {
    const text = renderLessonsRule(ide, lessons)
    if (text === null) continue
    const abs = join(projectRoot, LESSON_RULES[ide].path)
    let current: string | null = null
    try {
      current = readFileSync(abs, 'utf8')
    } catch {
      current = null
    }
    if (current === text) continue
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
    written.push(LESSON_RULES[ide].path)
  }
  return written
}

/** Each assistant's lessons rule that is missing or no longer matches the lessons. */
export function lessonRulesDrift(projectRoot: string, ides: readonly string[]): Array<{ ide: string; path: string; detail: string }> {
  const { lessons } = readLessons(join(projectRoot, '.opencastle'))
  const out: Array<{ ide: string; path: string; detail: string }> = []
  for (const ide of ides) {
    const text = renderLessonsRule(ide, lessons)
    if (text === null) continue
    const rel = LESSON_RULES[ide].path
    const abs = join(projectRoot, rel)
    if (!existsSync(abs)) {
      out.push({ ide, path: rel, detail: 'the lessons rule this assistant loads is missing' })
      continue
    }
    let current = ''
    try {
      current = readFileSync(abs, 'utf8')
    } catch {
      current = ''
    }
    if (current !== text) out.push({ ide, path: rel, detail: 'no longer lists the lessons in .opencastle/lessons/' })
  }
  return out
}

/**
 * Rewrite everything derived from the lessons: the index agents read, and each
 * assistant's rule. What every writer of a lesson calls instead of the index
 * alone, so the two can never disagree.
 */
export function refreshLessons(customizationsDir: string): LessonsSync {
  const outcome = syncLessons(customizationsDir)
  const projectRoot = dirname(customizationsDir)
  writeLessonRules(projectRoot, manifestIdes(projectRoot))
  return outcome
}
