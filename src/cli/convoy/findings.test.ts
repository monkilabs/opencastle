import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectFindings, extractFindings, recordLessons } from './findings.js'
import { readLessons, renderLesson, syncLessons } from '../lessons.js'

describe('reading a worker’s answer', () => {
  it('reads a lesson in each shape a worker writes one', () => {
    const out = [
      '[LESSON terminal] Quote paths in shell commands — the repo has a folder with a space',
      '- [LESSON git] Rebase onto main before pushing -- CI checks the merge result',
      '* **[LESSON]** Run the seed script before the e2e tests',
      '[LESSON: database] Use the pooled URL in serverless functions – direct connections run out',
      'Not a lesson: [LESSON terminal] in the middle of a line',
    ].join('\n')
    expect(extractFindings('t1', out).lessons).toEqual([
      { taskId: 't1', category: 'terminal', title: 'Quote paths in shell commands', detail: 'Quote paths in shell commands — the repo has a folder with a space' },
      { taskId: 't1', category: 'git', title: 'Rebase onto main before pushing', detail: 'Rebase onto main before pushing -- CI checks the merge result' },
      { taskId: 't1', category: 'general', title: 'Run the seed script before the e2e tests', detail: 'Run the seed script before the e2e tests' },
      { taskId: 't1', category: 'database', title: 'Use the pooled URL in serverless functions', detail: 'Use the pooled URL in serverless functions – direct connections run out' },
    ])
  })

  it('files a lesson under general when its category is not one there is', () => {
    expect(extractFindings('t1', '[LESSON tooling] Use pnpm, not npm').lessons[0].category).toBe('general')
  })

  it('reads issues', () => {
    expect(extractFindings('t2', 'ok\n- [ISSUE] src/a.ts: off by one in the pager\n[ISSUE]\n').issues).toEqual([
      { taskId: 't2', text: 'src/a.ts: off by one in the pager' },
    ])
  })

  it('keeps a lesson two workers reported once, and every issue', () => {
    const found = collectFindings([
      { id: 'a', output: '[LESSON] Run codegen first\n[ISSUE] x' },
      { id: 'b', output: '[LESSON] run codegen first — again\n[ISSUE] y' },
      { id: 'c', output: null },
    ])
    expect(found.lessons.map((l) => l.taskId)).toEqual(['a'])
    expect(found.issues.map((i) => i.text)).toEqual(['x', 'y'])
  })
})

describe('recording the lessons', () => {
  let dir: string

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'oc-findings-')), '.opencastle')
    mkdirSync(dir)
  })

  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

  const reported = (title: string, detail = title) => ({ taskId: 'a', category: 'terminal', title, detail })

  it('writes a lesson file with where it came from, and lists it in the index', () => {
    const written = recordLessons(dir, [reported('Run codegen first', 'Run codegen first — types are generated')], 'cv-1')
    expect(written).toHaveLength(1)
    const [lesson] = readLessons(dir).lessons
    expect(lesson).toMatchObject({ title: 'Run codegen first', category: 'terminal', severity: 'medium', source: 'convoy cv-1, task a', status: 'active' })
    expect(lesson.body).toBe('**Problem:** Run codegen first — types are generated')
    expect(readFileSync(join(dir, 'LESSONS-LEARNED.md'), 'utf8')).toContain('Run codegen first')
  })

  it('skips a lesson the project already has, so a resumed run adds nothing twice', () => {
    mkdirSync(join(dir, 'lessons'))
    writeFileSync(join(dir, 'lessons', 'x.md'), renderLesson({
      id: 'x', title: 'Run codegen first', category: 'terminal', severity: 'high', added: '2026-10-01', citations: [], status: 'active', body: '**Problem:** p',
    }))
    syncLessons(dir)
    expect(recordLessons(dir, [reported('run codegen first')], 'cv-1')).toEqual([])
    expect(readdirSync(join(dir, 'lessons'))).toEqual(['x.md'])
  })

  it('skips a lesson that looks like it holds a credential', () => {
    const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')
    expect(recordLessons(dir, [reported('Use the deploy key', `Use the deploy key ${key}`)], 'cv-1')).toEqual([])
  })

  it('writes nothing where there is no .opencastle/', () => {
    rmSync(dir, { recursive: true })
    expect(recordLessons(dir, [reported('Run codegen first')], 'cv-1')).toEqual([])
  })
})
