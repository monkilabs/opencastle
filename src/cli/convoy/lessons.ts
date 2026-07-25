import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanForSecrets } from './gates.js'

const LESSONS_PATH = '.opencastle/LESSONS-LEARNED.md'

function parseLessonEntries(content: string): string[] {
  const parts = content.split(/(?=### LES-\d+:)/)
  return parts.filter(p => p.trim().startsWith('### LES-'))
}

function getNextLessonNumber(entries: string[]): number {
  let max = 0
  for (const entry of entries) {
    const m = entry.match(/### LES-(\d+):/)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n > max) max = n
    }
  }
  return max + 1
}

export function readLessons(agentName: string, filePaths: string[], basePath?: string): string[] {
  const base = basePath ?? process.cwd()
  const filePath = join(base, LESSONS_PATH)
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf8')
  const entries = parseLessonEntries(content)
  if (entries.length === 0) return []
  const agentLower = agentName.toLowerCase()
  const scored: Array<{ entry: string; score: number }> = []
  for (const entry of entries) {
    const entryLower = entry.toLowerCase()
    const matchesAgent = entryLower.includes(agentLower)
    const matchesFiles =
      filePaths.length > 0 && filePaths.some(fp => entryLower.includes(fp.toLowerCase()))
    if (matchesAgent && matchesFiles) {
      scored.push({ entry, score: 2 })
    } else if (matchesAgent) {
      scored.push({ entry, score: 1 })
    } else if (matchesFiles) {
      scored.push({ entry, score: 0.5 })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 5).map(s => s.entry.trim())
}

export function captureLessons(
  lesson: {
    title: string
    category: string
    agent: string
    problem: string
    solution: string
    files?: string[]
  },
  basePath?: string,
): { captured: boolean; reason?: string } {
  const base = basePath ?? process.cwd()
  const filePath = join(base, LESSONS_PATH)
  const existingContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const entries = parseLessonEntries(existingContent)
  const nextNum = getNextLessonNumber(entries)
  const lesNum = String(nextNum).padStart(3, '0')
  const date = new Date().toISOString().slice(0, 10)
  const filesNote =
    lesson.files && lesson.files.length > 0
      ? `\n**Files:** ${lesson.files.join(', ')}`
      : ''
  const entry =
    `\n### LES-${lesNum}: ${lesson.title}\n\n` +
    '| Field | Value |\n|-------|-------|\n' +
    `| **Category** | \`${lesson.category}\` |\n` +
    `| **Added** | ${date} |\n` +
    `| **Agent** | ${lesson.agent} |\n` +
    '| **Severity** | `medium` |\n\n' +
    `**Problem:** ${lesson.problem}\n\n` +
    `**Correct approach:** ${lesson.solution}${filesNote}\n`
  const scanResult = scanForSecrets(entry, 'lessons')
  if (!scanResult.clean) {
    return { captured: false, reason: 'secrets_detected' }
  }
  if (!existsSync(filePath)) {
    writeFileSync(
      filePath,
      '# Lessons Learned\n\nStructured log of pitfalls and correct approaches.\n\n## Lessons\n',
      'utf8',
    )
  }
  appendFileSync(filePath, entry, 'utf8')
  return { captured: true }
}

function extractDate(entry: string): string {
  const m = entry.match(/\*\*Added\*\*\s*\|\s*(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : '0000-00-00'
}

function extractCategory(entry: string): string {
  const m = entry.match(/\*\*Category\*\*\s*\|\s*`([^`]+)`/)
  return m ? m[1] : ''
}

function extractTitle(entry: string): string {
  const m = entry.match(/### LES-\d+:\s*(.+)/)
  return m ? m[1].trim() : ''
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.split(/\s+/).filter(Boolean))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++
  }
  return overlap / Math.max(wordsA.size, wordsB.size)
}

export function consolidateLessons(basePath?: string): { merged: number; remaining: number } {
  const base = basePath ?? process.cwd()
  const filePath = join(base, LESSONS_PATH)
  if (!existsSync(filePath)) return { merged: 0, remaining: 0 }
  const content = readFileSync(filePath, 'utf8')
  const entries = parseLessonEntries(content)
  if (entries.length === 0) return { merged: 0, remaining: 0 }
  const firstLessonIdx = content.indexOf('### LES-')
  const header = firstLessonIdx > 0 ? content.slice(0, firstLessonIdx) : ''
  const kept: string[] = []
  let mergedCount = 0
  const processed = new Set<number>()
  for (let i = 0; i < entries.length; i++) {
    if (processed.has(i)) continue
    const catI = extractCategory(entries[i])
    const titleI = normalizeTitle(extractTitle(entries[i]))
    let bestIdx = i
    let bestDate = extractDate(entries[i])
    for (let j = i + 1; j < entries.length; j++) {
      if (processed.has(j)) continue
      const catJ = extractCategory(entries[j])
      if (catI !== catJ) continue
      const titleJ = normalizeTitle(extractTitle(entries[j]))
      if (wordOverlap(titleI, titleJ) >= 0.8) {
        const dateJ = extractDate(entries[j])
        if (dateJ > bestDate) {
          bestDate = dateJ
          bestIdx = j
        }
        processed.add(j)
        mergedCount++
      }
    }
    processed.add(i)
    kept.push(entries[bestIdx])
  }
  // Entries keep the whitespace that preceded the next heading, so joining them
  // verbatim re-adds a blank line on every consolidation run. Trim each entry and
  // use a fixed separator, otherwise the file grows without bound.
  const body = kept.map(e => e.trim()).join('\n\n')
  writeFileSync(filePath, `${header.trimEnd()}\n\n${body}\n`, 'utf8')
  return { merged: mergedCount, remaining: kept.length }
}
