#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '')
const DIRS = ['src/orchestrator/skills', 'src/orchestrator/plugins']
const OUTPUT = process.argv[2] ?? 'skill-review-report.md'

interface ReviewResult {
  path: string
  score: number | null
  passed: boolean
  suggestions: string[]
  rawOutput: string
}

function discoverSkills(): string[] {
  const paths: string[] = []
  for (const dir of DIRS) {
    const abs = join(ROOT, dir)
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry)
      if (statSync(full).isDirectory()) {
        const skillFile = join(full, 'SKILL.md')
        try {
          statSync(skillFile)
          paths.push(relative(ROOT, full))
        } catch {
          // no SKILL.md — skip
        }
      }
    }
  }
  return paths.sort()
}

function reviewSkill(skillPath: string): ReviewResult {
  let raw: string
  try {
    raw = execSync(`npx tessl skill review ${skillPath}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string }
    raw = (execErr.stdout ?? '') + (execErr.stderr ?? '')
  }

  const scoreMatch = raw.match(/Review Score:\s*(\d+)%/)
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null

  const passed = raw.includes('PASSED')

  const suggestions: string[] = []
  const lines = raw.split('\n')
  let inSuggestions = false
  for (const line of lines) {
    if (line.trim().startsWith('Suggestions:')) {
      inSuggestions = true
      continue
    }
    if (inSuggestions) {
      const trimmed = line.trim()
      if (trimmed.startsWith('- ')) {
        suggestions.push(trimmed.slice(2))
      } else if (trimmed === '' || (!trimmed.startsWith('-') && !trimmed.startsWith(' '))) {
        inSuggestions = false
      }
    }
  }

  return { path: skillPath, score, passed, suggestions, rawOutput: raw }
}

function buildReport(results: ReviewResult[]): string {
  const lines: string[] = []
  const now = new Date().toISOString().split('T')[0]

  lines.push(`# Skill Review Report — ${now}`)
  lines.push('')

  // Summary table
  const perfect = results.filter(r => r.score === 100).length
  const above90 = results.filter(r => r.score !== null && r.score >= 90).length
  const below80 = results.filter(r => r.score !== null && r.score < 80)
  const scored = results.filter(r => r.score !== null)
  const avg = scored.length > 0 ? scored.reduce((s, r) => s + r.score!, 0) / scored.length : 0

  lines.push(`## Summary`)
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Total skills | ${results.length} |`)
  lines.push(`| Average score | ${avg.toFixed(0)}% |`)
  lines.push(`| Perfect (100%) | ${perfect} |`)
  lines.push(`| ≥90% | ${above90} |`)
  lines.push(`| <80% (needs work) | ${below80.length} |`)
  lines.push('')

  // Scores table sorted by score ascending
  const sorted = [...results].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
  lines.push(`## All Scores`)
  lines.push('')
  lines.push(`| Score | Skill | Status |`)
  lines.push(`|-------|-------|--------|`)
  for (const r of sorted) {
    const icon = r.score === 100 ? '✅' : r.score !== null && r.score >= 90 ? '🟢' : r.score !== null && r.score >= 80 ? '🟡' : '🔴'
    lines.push(`| ${r.score ?? '?'}% | ${r.path} | ${icon} |`)
  }
  lines.push('')

  // Suggestions for skills below 100%
  const needWork = results.filter(r => r.score !== 100 && r.suggestions.length > 0)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))

  if (needWork.length > 0) {
    lines.push(`## Suggestions`)
    lines.push('')
    for (const r of needWork) {
      lines.push(`### ${r.path} (${r.score}%)`)
      lines.push('')
      for (const s of r.suggestions) {
        lines.push(`- ${s}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

// Main
console.log('Discovering skills...')
const skills = discoverSkills()
console.log(`Found ${skills.length} skills. Reviewing...\n`)

const results: ReviewResult[] = []
for (const skill of skills) {
  process.stdout.write(`  ${skill} ... `)
  const result = reviewSkill(skill)
  results.push(result)
  console.log(result.score !== null ? `${result.score}%` : 'ERROR')
}

const report = buildReport(results)
const outPath = join(ROOT, OUTPUT)
writeFileSync(outPath, report, 'utf-8')
console.log(`\nReport written to ${OUTPUT}`)

const below100 = results.filter(r => r.score !== 100).length
if (below100 > 0) {
  console.log(`${below100} skill(s) below 100% — see report for suggestions.`)
}
