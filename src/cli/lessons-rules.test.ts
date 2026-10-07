import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderLesson, type Lesson } from './lessons.js'
import { LESSON_RULES, isLessonRule, lessonRulesDrift, refreshLessons, renderLessonsRule, writeLessonRules } from './lessons-rules.js'

const lesson = (over: Partial<Lesson> = {}): Omit<Lesson, 'file'> => ({
  id: '2026-10-07-quote-paths',
  title: 'Quote paths with spaces',
  category: 'terminal',
  severity: 'medium',
  added: '2026-10-07',
  citations: [],
  status: 'active',
  body: 'Unquoted paths break.',
  ...over,
})

describe('the lessons every assistant loads', () => {
  let dir: string
  const addLesson = (l: Omit<Lesson, 'file'>): void => {
    mkdirSync(join(dir, '.opencastle', 'lessons'), { recursive: true })
    writeFileSync(join(dir, '.opencastle', 'lessons', `${l.id}.md`), renderLesson(l))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-lessons-rules-'))
    mkdirSync(join(dir, '.opencastle'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists the active lessons in each assistant’s own always-on form, and none for a root-file-only one', () => {
    const lessons: Lesson[] = [
      { ...lesson(), file: '2026-10-07-quote-paths.md' },
      { ...lesson({ id: 'old', title: 'Merged long ago', status: 'archived', mergedInto: 'skills/x' }), file: 'old.md' },
    ]
    const vscode = renderLessonsRule('vscode', lessons) ?? ''
    expect(vscode.startsWith("---\napplyTo: '**'\n---\n")).toBe(true)
    expect(vscode).toContain('- **Quote paths with spaces** — `medium`, terminal · `.opencastle/lessons/2026-10-07-quote-paths.md`')
    expect(vscode).not.toContain('Merged long ago')
    expect(renderLessonsRule('claude-code', lessons)?.startsWith('<!--')).toBe(true)
    expect(renderLessonsRule('cursor', lessons)).toContain('alwaysApply: true')
    expect(renderLessonsRule('windsurf', lessons)).toContain('trigger: always_on')
    expect(renderLessonsRule('codex', lessons)).toBeNull()
  })

  it('writes what differs, and holds each file to the lessons', () => {
    addLesson(lesson())
    expect(writeLessonRules(dir, ['claude-code', 'vscode', 'codex'])).toEqual([LESSON_RULES['claude-code'].path, LESSON_RULES.vscode.path])
    expect(writeLessonRules(dir, ['claude-code', 'vscode'])).toEqual([])
    expect(lessonRulesDrift(dir, ['claude-code', 'vscode'])).toEqual([])
    addLesson(lesson({ id: '2026-10-08-ci-flag', title: 'Set CI=1 before the build' }))
    expect(lessonRulesDrift(dir, ['claude-code', 'vscode']).map((d) => d.path)).toEqual([LESSON_RULES['claude-code'].path, LESSON_RULES.vscode.path])
  })

  it('refreshes the index and the rules of the assistants the manifest names, in one call', () => {
    writeFileSync(join(dir, '.opencastle', 'manifest.json'), JSON.stringify({ version: '1.8.0', ides: ['vscode'] }))
    addLesson(lesson())
    refreshLessons(join(dir, '.opencastle'))
    expect(readFileSync(join(dir, '.opencastle', 'LESSONS-LEARNED.md'), 'utf8')).toContain('Quote paths with spaces')
    expect(readFileSync(join(dir, LESSON_RULES.vscode.path), 'utf8')).toContain('Quote paths with spaces')
    expect(lessonRulesDrift(dir, ['vscode'])).toEqual([])
  })

  it('knows its own paths, which the compile does not produce', () => {
    expect(isLessonRule('.github/instructions/opencastle-lessons.instructions.md')).toBe(true)
    expect(isLessonRule('./.cursor/rules/opencastle-lessons.mdc')).toBe(true)
    expect(isLessonRule('.github/instructions/general.instructions.md')).toBe(false)
  })
})
