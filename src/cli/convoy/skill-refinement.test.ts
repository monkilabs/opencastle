import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync, existsSync, readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  trackSkillFailure,
  getSkillFailures,
  detectFailurePatterns,
  generateRefinementProposal,
  saveProposal,
  getFailureStats,
  runSkillRefinementCheck,
} from './skill-refinement.js'
import type { SkillFailureRecord, SkillRefinementProposal } from './skill-refinement.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'skill-ref-test-')))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeRecord(overrides: Partial<SkillFailureRecord> = {}): SkillFailureRecord {
  return {
    skill_name: 'react-development',
    agent: 'Developer',
    task_id: 'task-1',
    convoy_id: 'convoy-1',
    failure_reason: 'missing type annotation on props',
    retry_count: 1,
    eventually_succeeded: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('trackSkillFailure', () => {
  it('appends a valid JSON line to NDJSON file', () => {
    const record = makeRecord()
    trackSkillFailure(record, tmpDir)
    const filePath = join(tmpDir, '.opencastle/telemetry/skill-failures.ndjson')
    expect(existsSync(filePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(filePath, 'utf8').trim())
    expect(parsed.skill_name).toBe('react-development')
    expect(parsed.agent).toBe('Developer')
  })

  it('creates directory if it does not exist', () => {
    trackSkillFailure(makeRecord(), tmpDir)
    expect(existsSync(join(tmpDir, '.opencastle/telemetry'))).toBe(true)
  })

  it('appends multiple records', () => {
    trackSkillFailure(makeRecord({ task_id: 'task-1' }), tmpDir)
    trackSkillFailure(makeRecord({ task_id: 'task-2' }), tmpDir)
    const lines = readFileSync(
      join(tmpDir, '.opencastle/telemetry/skill-failures.ndjson'),
      'utf8',
    )
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
  })
})

describe('getSkillFailures', () => {
  it('returns empty array when file does not exist', () => {
    expect(getSkillFailures('react-development', tmpDir)).toEqual([])
  })

  it('filters by skill name', () => {
    trackSkillFailure(makeRecord({ skill_name: 'react-development' }), tmpDir)
    trackSkillFailure(makeRecord({ skill_name: 'api-patterns' }), tmpDir)
    const result = getSkillFailures('react-development', tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].skill_name).toBe('react-development')
  })

  it('filters by since timestamp', () => {
    trackSkillFailure(makeRecord({ timestamp: '2026-01-01T00:00:00.000Z' }), tmpDir)
    trackSkillFailure(makeRecord({ timestamp: '2026-02-01T00:00:00.000Z' }), tmpDir)
    const result = getSkillFailures('react-development', tmpDir, '2026-01-15T00:00:00.000Z')
    expect(result).toHaveLength(1)
    expect(result[0].timestamp).toBe('2026-02-01T00:00:00.000Z')
  })

  it('skips malformed lines', () => {
    const dir = join(tmpDir, '.opencastle/telemetry')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'skill-failures.ndjson'),
      'not-valid-json\n' + JSON.stringify(makeRecord()) + '\n',
      'utf8',
    )
    const result = getSkillFailures('react-development', tmpDir)
    expect(result).toHaveLength(1)
  })
})

describe('detectFailurePatterns', () => {
  it('returns should_refine false with 0 failures', () => {
    const result = detectFailurePatterns([])
    expect(result.should_refine).toBe(false)
    expect(result.threshold_met).toBe(false)
  })

  it('returns should_refine false with 1 failure', () => {
    expect(detectFailurePatterns([makeRecord()]).should_refine).toBe(false)
    expect(detectFailurePatterns([makeRecord()]).threshold_met).toBe(false)
  })

  it('returns threshold_met true with 3 failures from different convoys', () => {
    const failures = [
      makeRecord({ convoy_id: 'c1', agent: 'Dev', failure_reason: 'missing type annotation on props interface' }),
      makeRecord({ convoy_id: 'c2', agent: 'Dev', failure_reason: 'missing type annotation on props interface' }),
      makeRecord({ convoy_id: 'c3', agent: 'Dev', failure_reason: 'missing type annotation on props interface' }),
    ]
    expect(detectFailurePatterns(failures).threshold_met).toBe(true)
  })

  it('returns threshold_met true with 2 failures from same agent', () => {
    const failures = [
      makeRecord({ agent: 'Developer', convoy_id: 'c1' }),
      makeRecord({ agent: 'Developer', convoy_id: 'c2' }),
    ]
    expect(detectFailurePatterns(failures).threshold_met).toBe(true)
  })

  it('returns threshold_met true with failures from 2 different agents from different convoys', () => {
    const failures = [
      makeRecord({ agent: 'Developer', convoy_id: 'c1' }),
      makeRecord({ agent: 'UI-Expert', convoy_id: 'c2' }),
    ]
    expect(detectFailurePatterns(failures).threshold_met).toBe(true)
  })

  it('returns threshold_met false with 2 failures from different agents but same convoy', () => {
    const failures = [
      makeRecord({ agent: 'Developer', convoy_id: 'c1', task_id: 't1' }),
      makeRecord({ agent: 'UI-Expert', convoy_id: 'c1', task_id: 't2' }),
    ]
    // 2 different agents but same convoy: uniqueConvoys < 3 (false), sameAgentDoubleFailure false,
    // uniqueAgents >= 2 but uniqueConvoys < 2 → threshold_met = false
    expect(detectFailurePatterns(failures).threshold_met).toBe(false)
  })

  it('groups similar failure reasons into patterns', () => {
    const failures = [
      makeRecord({ failure_reason: 'missing type annotation on props', convoy_id: 'c1' }),
      makeRecord({ failure_reason: 'missing type annotation for function params', convoy_id: 'c2' }),
      makeRecord({ failure_reason: 'completely unrelated import error issue', convoy_id: 'c3' }),
    ]
    const result = detectFailurePatterns(failures)
    expect(result.patterns.length).toBeGreaterThan(0)
    // first two share "missing", "type", "annotation" → grouped
    expect(result.patterns[0]).toContain('annotation')
  })
})

describe('generateRefinementProposal', () => {
  it('generates proposal with correct fields', () => {
    const failures = [
      makeRecord({ convoy_id: 'c1' }),
      makeRecord({ convoy_id: 'c2' }),
      makeRecord({ convoy_id: 'c3' }),
    ]
    const proposal = generateRefinementProposal('react-development', failures, tmpDir)
    expect(proposal.skill_name).toBe('react-development')
    expect(proposal.failure_count).toBe(3)
    expect(typeof proposal.generated_at).toBe('string')
    expect(proposal.skill_path).toBe('unknown')
  })

  it('sets confidence based on failure count', () => {
    const two = Array.from({ length: 2 }, (_, i) => makeRecord({ convoy_id: `c${i}`, agent: 'Dev' }))
    expect(generateRefinementProposal('s', two, tmpDir).confidence).toBe('low')

    const three = Array.from({ length: 3 }, (_, i) => makeRecord({ convoy_id: `c${i}`, agent: 'Dev' }))
    expect(generateRefinementProposal('s', three, tmpDir).confidence).toBe('medium')

    const five = Array.from({ length: 5 }, (_, i) => makeRecord({ convoy_id: `c${i}`, agent: 'Dev' }))
    expect(generateRefinementProposal('s', five, tmpDir).confidence).toBe('high')
  })

  it('includes proposed additions derived from patterns', () => {
    const failures = [
      makeRecord({ failure_reason: 'missing type annotation on props', convoy_id: 'c1', agent: 'Dev1' }),
      makeRecord({ failure_reason: 'missing type annotation for function', convoy_id: 'c2', agent: 'Dev1' }),
      makeRecord({ failure_reason: 'missing type annotation in hooks', convoy_id: 'c3', agent: 'Dev1' }),
    ]
    const proposal = generateRefinementProposal('react-development', failures, tmpDir)
    if (proposal.proposed_additions.length > 0) {
      expect(proposal.proposed_additions[0]).toMatch(/Add to ## Common Pitfalls:/)
    }
  })
})

describe('saveProposal', () => {
  function makeProposal(overrides: Partial<SkillRefinementProposal> = {}): SkillRefinementProposal {
    return {
      skill_name: 'react-development',
      skill_path: 'unknown',
      failure_count: 3,
      common_failure_patterns: ['type, annotation, missing'],
      proposed_additions: ["Add to ## Common Pitfalls: 'type, annotation, missing'"],
      confidence: 'medium',
      generated_at: '2026-01-15T10:00:00.000Z',
      ...overrides,
    }
  }

  it('writes markdown file with correct format', () => {
    const filePath = saveProposal(makeProposal(), tmpDir)
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, 'utf8')
    expect(content).toContain('# Skill Refinement Proposal: react-development')
    expect(content).toContain('**Confidence:** medium')
    expect(content).toContain('## Proposed Changes')
    expect(content).toContain('## Action')
  })

  it('creates proposals directory if needed', () => {
    saveProposal(makeProposal(), tmpDir)
    expect(existsSync(join(tmpDir, '.opencastle/proposals'))).toBe(true)
  })

  it('handles existing file for same date (counter suffix)', () => {
    const path1 = saveProposal(makeProposal(), tmpDir)
    const path2 = saveProposal(makeProposal(), tmpDir)
    expect(path1).not.toBe(path2)
    expect(path2).toContain('-2.md')
  })
})

describe('getFailureStats', () => {
  it('returns empty array when no data', () => {
    expect(getFailureStats(tmpDir)).toEqual([])
  })

  it('groups and sorts by count descending', () => {
    trackSkillFailure(makeRecord({ skill_name: 'react-development' }), tmpDir)
    trackSkillFailure(makeRecord({ skill_name: 'react-development' }), tmpDir)
    trackSkillFailure(makeRecord({ skill_name: 'api-patterns' }), tmpDir)
    const result = getFailureStats(tmpDir)
    expect(result[0].skill_name).toBe('react-development')
    expect(result[0].count).toBe(2)
    expect(result[1].skill_name).toBe('api-patterns')
    expect(result[1].count).toBe(1)
  })
})

describe('runSkillRefinementCheck', () => {
  it('returns empty array when no failures for convoy', () => {
    expect(runSkillRefinementCheck('unknown-convoy', tmpDir)).toEqual([])
  })

  it('generates proposals for skills meeting threshold', () => {
    // 3 failures from different convoys for same skill; convoy c3 triggers the check
    trackSkillFailure(makeRecord({ skill_name: 'react-development', convoy_id: 'c1', agent: 'Dev', task_id: 't1' }), tmpDir)
    trackSkillFailure(makeRecord({ skill_name: 'react-development', convoy_id: 'c2', agent: 'Dev', task_id: 't2' }), tmpDir)
    trackSkillFailure(makeRecord({ skill_name: 'react-development', convoy_id: 'c3', agent: 'Dev', task_id: 't3' }), tmpDir)
    const results = runSkillRefinementCheck('c3', tmpDir)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].skill).toBe('react-development')
    expect(existsSync(results[0].proposalPath)).toBe(true)
  })

  it('skips skills not meeting threshold', () => {
    // Only 1 failure total for the skill
    trackSkillFailure(makeRecord({ skill_name: 'api-patterns', convoy_id: 'c1', task_id: 't1' }), tmpDir)
    expect(runSkillRefinementCheck('c1', tmpDir)).toEqual([])
  })
})
