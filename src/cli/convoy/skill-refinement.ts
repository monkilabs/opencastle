import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanForSecrets } from './gates.js'

const SKILL_FAILURES_PATH = '.opencastle/telemetry/skill-failures.ndjson'
const STOP_WORDS = new Set(['the', 'a', 'is', 'to', 'and', 'in', 'for', 'of', 'with'])

export interface SkillFailureRecord {
  skill_name: string
  agent: string
  task_id: string
  convoy_id: string
  failure_reason: string
  retry_count: number
  eventually_succeeded: boolean
  timestamp: string
}

export interface SkillRefinementProposal {
  skill_name: string
  skill_path: string
  failure_count: number
  common_failure_patterns: string[]
  proposed_additions: string[]
  confidence: 'low' | 'medium' | 'high'
  generated_at: string
}

export function trackSkillFailure(record: SkillFailureRecord, basePath?: string): void {
  const base = basePath ?? process.cwd()
  const filePath = join(base, SKILL_FAILURES_PATH)
  mkdirSync(join(base, '.opencastle', 'telemetry'), { recursive: true })
  const line = JSON.stringify(record) + '\n'
  const scan = scanForSecrets(line, 'skill-failures.ndjson')
  if (!scan.clean) return
  appendFileSync(filePath, line, 'utf8')
}

export function getSkillFailures(skillName: string, basePath?: string, since?: string): SkillFailureRecord[] {
  const base = basePath ?? process.cwd()
  const filePath = join(base, SKILL_FAILURES_PATH)
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf8')
  const records: SkillFailureRecord[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as SkillFailureRecord
      if (record.skill_name !== skillName) continue
      if (since && record.timestamp < since) continue
      records.push(record)
    } catch {
      // skip malformed lines
    }
  }
  return records
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w)),
  )
}

export function detectFailurePatterns(failures: SkillFailureRecord[]): {
  should_refine: boolean
  patterns: string[]
  threshold_met: boolean
} {
  if (failures.length < 2) {
    return { should_refine: false, patterns: [], threshold_met: false }
  }

  const uniqueConvoys = new Set(failures.map(f => f.convoy_id))
  const uniqueAgents = new Set(failures.map(f => f.agent))

  const agentCounts = new Map<string, number>()
  for (const f of failures) {
    agentCounts.set(f.agent, (agentCounts.get(f.agent) ?? 0) + 1)
  }
  const sameAgentDoubleFailure = [...agentCounts.values()].some(c => c >= 2)

  // threshold: 3+ different convoys, OR same agent 2+ failures,
  // OR 2+ different agents each from distinct convoys
  const threshold_met =
    uniqueConvoys.size >= 3 ||
    sameAgentDoubleFailure ||
    (uniqueAgents.size >= 2 && uniqueConvoys.size >= 2)

  // Group failure_reasons by word overlap
  const groups: string[][] = []
  for (const failure of failures) {
    const words = tokenize(failure.failure_reason)
    let matched = false
    for (const group of groups) {
      const groupWords = tokenize(group[0])
      const intersection = [...words].filter(w => groupWords.has(w))
      const minSize = Math.min(words.size, groupWords.size)
      if (minSize > 0 && intersection.length / minSize >= 0.5) {
        group.push(failure.failure_reason)
        matched = true
        break
      }
    }
    if (!matched) {
      groups.push([failure.failure_reason])
    }
  }

  groups.sort((a, b) => b.length - a.length)

  const patterns: string[] = []
  for (const group of groups) {
    const wordSets = group.map(r => tokenize(r))
    let shared = new Set(wordSets[0])
    for (const ws of wordSets.slice(1)) {
      shared = new Set([...shared].filter(w => ws.has(w)))
    }
    if (shared.size > 0) {
      patterns.push([...shared].slice(0, 5).join(', '))
    } else if (group.length > 1) {
      patterns.push(group[0].slice(0, 60))
    }
  }

  const should_refine = threshold_met && patterns.length > 0

  return { should_refine, patterns, threshold_met }
}

export function generateRefinementProposal(
  skillName: string,
  failures: SkillFailureRecord[],
  basePath?: string,
): SkillRefinementProposal {
  const base = basePath ?? process.cwd()
  const skillFilePath = join(base, '.github', 'skills', skillName, 'SKILL.md')
  const skill_path = existsSync(skillFilePath) ? skillFilePath : 'unknown'

  const { patterns } = detectFailurePatterns(failures)

  const count = failures.length
  const confidence: 'low' | 'medium' | 'high' =
    count >= 5 ? 'high' : count >= 3 ? 'medium' : 'low'

  const proposed_additions = patterns.map(
    p => `Add to ## Common Pitfalls: '${p}'`,
  )

  return {
    skill_name: skillName,
    skill_path,
    failure_count: count,
    common_failure_patterns: patterns,
    proposed_additions,
    confidence,
    generated_at: new Date().toISOString(),
  }
}

function buildProposalMarkdown(proposal: SkillRefinementProposal, failures: SkillFailureRecord[]): string {
  const date = proposal.generated_at.slice(0, 10)
  const patternList =
    proposal.common_failure_patterns.map(p => `- ${p}`).join('\n') || '- (none detected)'
  const additionsList =
    proposal.proposed_additions.map(a => `- ${a}`).join('\n') || '- (none)'
  const evidenceRows = failures
    .slice(0, 20)
    .map(f => `| ${f.convoy_id} | ${f.task_id} | ${f.agent} | ${f.failure_reason.slice(0, 80)} |`)
    .join('\n')

  return `# Skill Refinement Proposal: ${proposal.skill_name}

**Generated:** ${date}  
**Failures analyzed:** ${proposal.failure_count}  
**Confidence:** ${proposal.confidence}

## Failure Pattern Summary

${patternList}

## Proposed Changes

${additionsList}

## Evidence

| Convoy | Task | Agent | Failure Reason |
|--------|------|-------|---------------|
${evidenceRows}

## Action

- [ ] Apply this proposal: edit \`${proposal.skill_path}\` manually
- [ ] Reject: delete this file
`
}

export function saveProposal(
  proposal: SkillRefinementProposal,
  basePath?: string,
  failures: SkillFailureRecord[] = [],
): string {
  const base = basePath ?? process.cwd()
  const dir = join(base, '.opencastle', 'proposals')
  mkdirSync(dir, { recursive: true })

  const date = proposal.generated_at.slice(0, 10)
  let filePath = join(dir, `skill-${proposal.skill_name}-${date}.md`)

  if (existsSync(filePath)) {
    let counter = 2
    while (existsSync(join(dir, `skill-${proposal.skill_name}-${date}-${counter}.md`))) {
      counter++
    }
    filePath = join(dir, `skill-${proposal.skill_name}-${date}-${counter}.md`)
  }

  writeFileSync(filePath, buildProposalMarkdown(proposal, failures), 'utf8')
  return filePath
}

export function getFailureStats(
  basePath?: string,
): Array<{ skill_name: string; count: number; agents: string[]; latest: string }> {
  const base = basePath ?? process.cwd()
  const filePath = join(base, SKILL_FAILURES_PATH)
  if (!existsSync(filePath)) return []

  const content = readFileSync(filePath, 'utf8')
  const statsMap = new Map<string, { count: number; agents: Set<string>; latest: string }>()

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as SkillFailureRecord
      const existing = statsMap.get(record.skill_name)
      if (existing) {
        existing.count++
        existing.agents.add(record.agent)
        if (record.timestamp > existing.latest) existing.latest = record.timestamp
      } else {
        statsMap.set(record.skill_name, {
          count: 1,
          agents: new Set([record.agent]),
          latest: record.timestamp,
        })
      }
    } catch {
      // skip malformed lines
    }
  }

  return [...statsMap.entries()]
    .map(([skill_name, s]) => ({
      skill_name,
      count: s.count,
      agents: [...s.agents],
      latest: s.latest,
    }))
    .sort((a, b) => b.count - a.count)
}

export function runSkillRefinementCheck(
  convoyId: string,
  basePath?: string,
): Array<{ skill: string; proposalPath: string }> {
  const base = basePath ?? process.cwd()
  const filePath = join(base, SKILL_FAILURES_PATH)
  if (!existsSync(filePath)) return []

  const content = readFileSync(filePath, 'utf8')
  const allRecords: SkillFailureRecord[] = []

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      allRecords.push(JSON.parse(line) as SkillFailureRecord)
    } catch {
      // skip malformed
    }
  }

  const convoySkills = new Set(
    allRecords.filter(r => r.convoy_id === convoyId).map(r => r.skill_name),
  )

  if (convoySkills.size === 0) return []

  const results: Array<{ skill: string; proposalPath: string }> = []

  for (const skillName of convoySkills) {
    const allSkillFailures = allRecords.filter(r => r.skill_name === skillName)
    const { threshold_met } = detectFailurePatterns(allSkillFailures)
    if (!threshold_met) continue

    const proposal = generateRefinementProposal(skillName, allSkillFailures, base)
    const proposalPath = saveProposal(proposal, base, allSkillFailures)
    results.push({ skill: skillName, proposalPath })
  }

  return results
}
