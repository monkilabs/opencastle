import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  INDEX_MARKER,
  checkLessons,
  citedPath,
  fingerprintsOf,
  lessonsIndexDrift,
  newLessonId,
  parseLegacyLessons,
  parseLesson,
  readLessons,
  renderIndex,
  renderLesson,
  slugOf,
  staleCitations,
  syncLessons,
  type Lesson,
} from './lessons.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')

/** The shape agents actually left the old file in: entries after the index, odd categories, a stray fence. */
const LEGACY = `\`\`\`\`markdown
# Lessons Learned

Intro the team wrote.

### LES-001: Observability logging is mandatory

| Field | Value |
|-------|-------|
| **Category** | \`general\` |
| **Added** | 2026-03-01 |
| **Severity** | \`high\` (blocks work) |

**Problem:** Nothing was logged.

**Correct approach:** Log every session.

---

### LES-002: Writing files via terminal fails when content contains \`!\`

| Field | Value |
|-------|-------|
| **Category** | \`tooling\` |
| **Added** | 2026-03-16 |
| **Severity** | \`high\` (blocks file creation) |

**Problem:** zsh history expansion.

**Wrong approach:**
- heredocs

## Index by Category

| Category | Lessons |
|----------|---------|
| \`general\` | LES-001, LES-002 |

\`\`\`\`

### LES-007: Use N/A for tracker_issue when no tracker is configured

| Field | Value |
|-------|-------|
| **Category** | \`general\` |
| **Added** | 2026-03-05 |
| **Severity** | \`medium\` (wastes 5+ min) |

**Problem:** TAS-PENDING everywhere.
`

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: '2026-10-02-quote-shell-variables',
    title: 'Always quote shell variables',
    category: 'terminal',
    severity: 'medium',
    added: '2026-10-02',
    citations: [],
    status: 'active',
    body: '**Problem:** Paths with spaces break.',
    file: '2026-10-02-quote-shell-variables.md',
    ...over,
  }
}

describe('naming a lesson', () => {
  it('slugs a title to lowercase words, under 50 characters', () => {
    expect(slugOf('Always quote $SHELL variables — even in CI!')).toBe('always-quote-shell-variables-even-in-ci')
    expect(slugOf('a'.repeat(80))).toBe('lesson')
    expect(slugOf('Café au lait')).toBe('cafe-au-lait')
  })

  it('gives two lessons with the same title on the same day different ids', () => {
    const taken = new Set(['2026-10-02-quote-shell-variables'])
    expect(newLessonId('Quote shell variables', '2026-10-02', taken)).toBe('2026-10-02-quote-shell-variables-2')
  })
})

describe('a lesson file', () => {
  it('round-trips through its frontmatter, keeping dates as strings', () => {
    const l = lesson({ citations: ['scripts/a.sh:12'], verified: '2026-10-02', fingerprints: { 'scripts/a.sh': '0123456789ab' } })
    const parsed = parseLesson(renderLesson(l), l.file)
    expect(parsed).toEqual(l)
  })

  it('names what is wrong with a file that is not a lesson', () => {
    expect(parseLesson('just text', 'x.md')).toBe('has no frontmatter')
    expect(parseLesson('---\nid: x\n---\nbody', 'x.md')).toBe('has no title')
  })

  it('cites a path, with or without a line', () => {
    expect(citedPath('src/a.ts:12')).toBe('src/a.ts')
    expect(citedPath('./src/a.ts#L3-L9')).toBe('src/a.ts')
    expect(citedPath('src/a.ts')).toBe('src/a.ts')
  })
})

describe('the old single-file log', () => {
  it('reads every entry wherever it sits, with what it says', () => {
    const found = parseLegacyLessons(LEGACY)
    expect(found.map((l) => l.id)).toEqual(['LES-001', 'LES-002', 'LES-007'])
    expect(found[1]).toMatchObject({ category: 'tooling', severity: 'high', added: '2026-03-16' })
    expect(found[0].body).toBe('**Problem:** Nothing was logged.\n\n**Correct approach:** Log every session.')
    expect(found[1].body).toContain('- heredocs')
    expect(found[1].body).not.toContain('````')
  })
})

describe('syncing lessons', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-lessons-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('moves an old log into one file per lesson, keeps a backup, and indexes them', () => {
    writeFileSync(join(dir, 'LESSONS-LEARNED.md'), LEGACY)
    const out = syncLessons(dir)
    expect(out.migrated).toBe(3)
    expect(out.backup).toMatch(/LESSONS-LEARNED\.md\.opencastle-backup$/)
    expect(readFileSync(join(dir, 'LESSONS-LEARNED.md.opencastle-backup'), 'utf8')).toBe(LEGACY)
    expect(readdirSync(join(dir, 'lessons')).sort()).toEqual([
      'LES-001-observability-logging-is-mandatory.md',
      'LES-002-writing-files-via-terminal-fails-when-content.md',
      'LES-007-use-n-a-for-tracker-issue-when-no-tracker-is.md',
    ])
    const index = readFileSync(join(dir, 'LESSONS-LEARNED.md'), 'utf8')
    expect(index.startsWith(INDEX_MARKER)).toBe(true)
    expect(index).toContain('## tooling')
    expect(lessonsIndexDrift(dir)).toBeNull()
  })

  it('does it once: a second sync changes nothing', () => {
    writeFileSync(join(dir, 'LESSONS-LEARNED.md'), LEGACY)
    syncLessons(dir)
    const before = readFileSync(join(dir, 'LESSONS-LEARNED.md'), 'utf8')
    expect(syncLessons(dir)).toMatchObject({ migrated: 0, index: 'unchanged' })
    expect(readFileSync(join(dir, 'LESSONS-LEARNED.md'), 'utf8')).toBe(before)
  })

  it('replaces an untouched template without a backup', () => {
    // As 1.0.0 shipped it, kept as a fixture: CI's shallow clone has no history to read it from.
    const template = readFileSync(join(import.meta.dirname, 'fixtures', 'lessons-template-1.0.md'), 'utf8')
    writeFileSync(join(dir, 'LESSONS-LEARNED.md'), template)
    const out = syncLessons(dir)
    expect(out).toMatchObject({ migrated: 0, index: 'updated' })
    expect(out.backup).toBeUndefined()
    expect(existsSync(join(dir, 'LESSONS-LEARNED.md.opencastle-backup'))).toBe(false)
  })

  it('leaves a project that removed the index alone', () => {
    expect(syncLessons(dir).index).toBe('absent')
    expect(existsSync(join(dir, 'LESSONS-LEARNED.md'))).toBe(false)
  })

  it('reports an index a merge left behind, and sync rebuilds it', () => {
    writeFileSync(join(dir, 'LESSONS-LEARNED.md'), renderIndex([]))
    mkdirSync(join(dir, 'lessons'))
    writeFileSync(join(dir, 'lessons', 'a.md'), renderLesson(lesson()))
    expect(lessonsIndexDrift(dir)).toMatch(/does not list/)
    syncLessons(dir)
    expect(lessonsIndexDrift(dir)).toBeNull()
    expect(readFileSync(join(dir, 'LESSONS-LEARNED.md'), 'utf8')).toContain('Always quote shell variables')
  })

  it('lists archived lessons apart, with where they went', () => {
    const index = renderIndex([lesson(), lesson({ id: 'b', file: 'b.md', title: 'Old', status: 'archived', mergedInto: 'skills/x/SKILL.md' })])
    expect(index).toMatch(/## Archived[\s\S]*\*\*Old\*\* → `skills\/x\/SKILL\.md`/)
    expect(index.split('## Archived')[0]).not.toContain('**Old**')
  })
})

describe('the shipped template', () => {
  it('is the index of no lessons, exactly as sync writes it', () => {
    const shipped = readFileSync(join(pkgRoot, 'src', 'orchestrator', 'customizations', 'LESSONS-LEARNED.md'), 'utf8')
    expect(shipped).toBe(renderIndex([]))
  })
})

describe('citations against the code', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-cite-'))
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(project, 'src', 'b.ts'), 'export const b = 1\n')
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  const verifiedNow = (citations: string[], over: Partial<Lesson> = {}): Lesson =>
    lesson({ citations, verified: '2026-10-01', fingerprints: fingerprintsOf(project, citations), ...over })

  it('says nothing while the cited code is as it was verified', () => {
    expect(staleCitations(project, [verifiedNow(['src/a.ts:1'])])).toEqual([])
  })

  it('names a cited file that changed since, and one that is gone', () => {
    const l = verifiedNow(['src/a.ts:1', 'src/b.ts'])
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 2\n')
    rmSync(join(project, 'src', 'b.ts'))
    expect(staleCitations(project, [l]).map((s) => `${s.citation}:${s.why}`)).toEqual(['src/a.ts:1:changed', 'src/b.ts:missing'])
  })

  it('does not read a checkout with CRLF line endings as a change', () => {
    const l = verifiedNow(['src/a.ts'])
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\r\n')
    expect(staleCitations(project, [l])).toEqual([])
  })

  it('checks a citation with no fingerprint for existence only', () => {
    writeFileSync(join(project, 'src', 'a.ts'), 'anything\n')
    expect(staleCitations(project, [lesson({ citations: ['src/a.ts'] })])).toEqual([])
  })

  it('doctor warns with the lesson, the citation and the command that clears it', () => {
    const dir = join(project, '.opencastle')
    mkdirSync(join(dir, 'lessons'), { recursive: true })
    writeFileSync(join(dir, 'lessons', 'a.md'), renderLesson(verifiedNow(['src/a.ts'], { id: 'a' })))
    syncLessons(dir)
    expect(checkLessons(project).warning).toBeUndefined()
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 3\n')
    const result = checkLessons(project)
    expect(result.warning).toBe(true)
    expect(result.detail).toBe('a cites src/a.ts, which has changed since it was verified on 2026-10-01')
    expect(result.fix).toContain('opencastle lesson verify a')
    expect(readLessons(dir).lessons).toHaveLength(1)
  })
})
