import { describe, it, expect } from 'vitest'
import { buildPhases, filesOverlap, formatDuration, pickStartable, taskFiles } from './schedule.js'
import type { Task } from './spec-types.js'
import type { TaskRecord } from './types.js'

const rec = (id: string, files: string[] = []) => ({ id, files: files.length ? JSON.stringify(files) : null }) as TaskRecord
const task = (id: string, depends_on: string[] = []) => ({ id, depends_on }) as Task

describe('buildPhases', () => {
  it('groups tasks by dependency depth', () => {
    const phases = buildPhases([task('a'), task('b', ['a']), task('c'), task('d', ['b', 'c'])])
    expect(phases.map(p => p.map(t => t.id))).toEqual([['a', 'c'], ['b'], ['d']])
  })

  it('throws on a cycle', () => {
    expect(() => buildPhases([task('a', ['b']), task('b', ['a'])])).toThrow(/circular/)
  })
})

describe('pickStartable', () => {
  it('fills the free slots in order', () => {
    expect(pickStartable([rec('a'), rec('b'), rec('c')], [], 2).map(t => t.id)).toEqual(['a', 'b'])
  })

  it('holds back a task whose files overlap a running one, and lets the next one through', () => {
    const picked = pickStartable([rec('b', ['src/api.ts']), rec('c', ['docs/'])], [rec('a', ['src/'])], 2)
    expect(picked.map(t => t.id)).toEqual(['c'])
  })

  it('checks two picks against each other too', () => {
    const picked = pickStartable([rec('a', ['x.ts']), rec('b', ['x.ts']), rec('c', ['y.ts'])], [], 3)
    expect(picked.map(t => t.id)).toEqual(['a', 'c'])
  })

  it('never blocks tasks that declare no files', () => {
    expect(pickStartable([rec('b')], [rec('a', ['src/'])], 1).map(t => t.id)).toEqual(['b'])
  })
})

describe('helpers', () => {
  it('normalises declared files', () => {
    expect(taskFiles(rec('a', ['./src/a.ts', 'src\\b.ts']))).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('treats a directory as overlapping the files under it, in either case', () => {
    expect(filesOverlap(['src/'], ['src/x.ts'])).toBe(true)
    expect(filesOverlap(['README.md'], ['readme.md'])).toBe(true)
    expect(filesOverlap(['a.ts'], ['b.ts'])).toBe(false)
  })

  it('formats durations', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(252_000)).toBe('4m 12s')
    expect(formatDuration(3_780_000)).toBe('1h 3m')
  })
})
