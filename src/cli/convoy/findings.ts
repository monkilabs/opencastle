/**
 * What workers found outside their task: lessons for the next agent, and bugs.
 *
 * A worker may not write under `.opencastle/` — several run at once, and each
 * such edit is a change outside its task that review sends back — so it was
 * told to put a lesson or an issue "in your answer instead". Nothing read the
 * answer for them, and every one was lost. Workers now mark them on a line of
 * their own; the engine reads them back from each finished task's stored
 * output when the run ends, so a resumed run loses none either.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanForSecrets } from '../secret-scan.js'
import {
  LESSONS_DIR,
  LESSONS_INDEX,
  isLessonCategory,
  lessonBody,
  newLessonId,
  readLessons,
  renderLesson,
  syncLessons,
  today,
} from '../lessons.js'

export interface ReportedLesson {
  taskId: string
  category: string
  title: string
  detail: string
}

export interface ReportedIssue {
  taskId: string
  text: string
}

export interface Findings {
  lessons: ReportedLesson[]
  issues: ReportedIssue[]
}

/** A marker on a line of its own, optionally a list item or in bold. */
const LESSON = /^[ \t]*(?:[-*][ \t]+)?\**\[LESSON(?:[ \t:]+([a-z-]+))?\]\**[ \t]*(.+)$/gm
const ISSUE = /^[ \t]*(?:[-*][ \t]+)?\**\[ISSUE\]\**[ \t]*(.+)$/gm

/** The lesson and issue lines in one worker's answer. */
export function extractFindings(taskId: string, output: string): Findings {
  const lessons: ReportedLesson[] = []
  for (const m of output.matchAll(LESSON)) {
    const text = m[2].trim()
    // `<what to do> — <why>`: the first half names the lesson in the index.
    const split = /\s+(?:—|--|–)\s+/.exec(text)
    const title = (split ? text.slice(0, split.index) : text).replace(/[.:]$/, '').trim()
    if (!title) continue
    const category = m[1] && isLessonCategory(m[1]) ? m[1] : 'general'
    lessons.push({ taskId, category, title, detail: text })
  }
  const issues = [...output.matchAll(ISSUE)].map((m) => ({ taskId, text: m[1].trim() })).filter((i) => i.text)
  return { lessons, issues }
}

/** Every finding across the tasks, a lesson reported twice kept once. */
export function collectFindings(tasks: Array<{ id: string; output: string | null }>): Findings {
  const lessons: ReportedLesson[] = []
  const issues: ReportedIssue[] = []
  const seen = new Set<string>()
  for (const t of tasks) {
    const found = extractFindings(t.id, t.output ?? '')
    for (const l of found.lessons) {
      const key = l.title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      lessons.push(l)
    }
    issues.push(...found.issues)
  }
  return { lessons, issues }
}

/** What `recordLessons` changes, for the commit that adds them: the files and the index. */
export const LESSON_PATHS = [`.opencastle/${LESSONS_DIR}`, `.opencastle/${LESSONS_INDEX}`]

/**
 * Write each lesson as a file under `<customizationsDir>/lessons/` and rewrite
 * the index. Skips one an active lesson already has the title of — a resumed
 * run reads the same answers again — and one that looks like it holds a
 * credential, since lessons are committed. Nothing is written when there is no
 * `.opencastle/` to write to.
 */
export function recordLessons(
  customizationsDir: string,
  lessons: ReportedLesson[],
  convoyId: string,
): Array<{ id: string; title: string }> {
  if (lessons.length === 0 || !existsSync(customizationsDir)) return []
  const existing = readLessons(customizationsDir).lessons
  const titles = new Set(existing.filter((l) => l.status === 'active').map((l) => l.title.toLowerCase()))
  const taken = new Set(existing.map((l) => l.id))
  const date = today()
  const written: Array<{ id: string; title: string }> = []
  for (const r of lessons) {
    if (titles.has(r.title.toLowerCase())) continue
    const id = newLessonId(r.title, date, taken)
    const text = renderLesson({
      id,
      title: r.title,
      category: r.category,
      // Nobody has checked a worker's lesson yet: `medium` until the person
      // reviewing the branch says otherwise.
      severity: 'medium',
      added: date,
      citations: [],
      status: 'active',
      source: `convoy ${convoyId}, task ${r.taskId}`,
      body: lessonBody({ problem: r.detail }),
    })
    if (!scanForSecrets(text, `${LESSONS_DIR}/${id}.md`).clean) continue
    mkdirSync(join(customizationsDir, LESSONS_DIR), { recursive: true })
    writeFileSync(join(customizationsDir, LESSONS_DIR, `${id}.md`), text)
    taken.add(id)
    titles.add(r.title.toLowerCase())
    written.push({ id, title: r.title })
  }
  // Also moves an old single-file log into lesson files, which is why the
  // commit takes the whole folder and not only the files written here.
  if (written.length > 0) syncLessons(customizationsDir)
  return written
}
