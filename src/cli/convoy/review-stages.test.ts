import { describe, it, expect, vi } from 'vitest'
import {
  buildSpecCompliancePrompt,
  buildCodeQualityPrompt,
  parseStageVerdict,
  runTwoStageReview,
} from './review-stages.js'
import type { ReviewRunnerFn } from './review-stages.js'
import type { TaskRecord } from './types.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    convoy_id: 'convoy-1',
    phase: 1,
    prompt: 'Implement the feature.\n\n## Acceptance Criteria\n- Feature works\n- Tests pass',
    agent: 'developer',
    adapter: null,
    model: null,
    timeout_ms: 30000,
    status: 'done',
    worker_id: null,
    worktree: null,
    output: 'Done.',
    exit_code: 0,
    started_at: null,
    finished_at: null,
    retries: 0,
    max_retries: 3,
    files: 'src/feature.ts',
    depends_on: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    cost_usd: null,
    gates: null,
    on_exhausted: 'dlq',
    injected: 0,
    provenance: null,
    idempotency_key: null,
    current_step: null,
    total_steps: null,
    review_level: null,
    review_verdict: null,
    review_tokens: null,
    review_model: null,
    panel_attempts: 0,
    dispute_id: null,
    drift_score: null,
    drift_retried: 0,
    ...overrides,
  } as TaskRecord
}

function makePassVerdict(stage: 'spec-compliance' | 'code-quality'): string {
  return `Analysis done.\n<!-- REVIEW_VERDICT { "stage": "${stage}", "verdict": "pass", "issues": [] } -->`
}

function makeBlockVerdict(stage: 'spec-compliance' | 'code-quality', issues: string[]): string {
  return `Analysis done.\n<!-- REVIEW_VERDICT { "stage": "${stage}", "verdict": "block", "issues": ${JSON.stringify(issues)} } -->`
}

// ── parseStageVerdict ─────────────────────────────────────────────────────────

describe('parseStageVerdict', () => {
  it('parses a valid pass verdict', () => {
    const output = makePassVerdict('spec-compliance')
    const result = parseStageVerdict(output, 'spec-compliance')
    expect(result.stage).toBe('spec-compliance')
    expect(result.verdict).toBe('pass')
    expect(result.issues).toEqual([])
  })

  it('parses a valid block verdict with issues', () => {
    const output = makeBlockVerdict('code-quality', ['Missing types', 'Unsafe cast'])
    const result = parseStageVerdict(output, 'code-quality')
    expect(result.stage).toBe('code-quality')
    expect(result.verdict).toBe('block')
    expect(result.issues).toEqual(['Missing types', 'Unsafe cast'])
  })

  it('falls back to block verdict on invalid/missing comment', () => {
    const result = parseStageVerdict('No verdict here.', 'spec-compliance')
    expect(result.stage).toBe('spec-compliance')
    expect(result.verdict).toBe('block')
    expect(result.issues).toEqual(['Failed to parse reviewer output'])
  })

  it('falls back to block verdict on malformed JSON', () => {
    const output = '<!-- REVIEW_VERDICT { invalid json } -->'
    const result = parseStageVerdict(output, 'code-quality')
    expect(result.verdict).toBe('block')
    expect(result.issues).toEqual(['Failed to parse reviewer output'])
  })
})

// ── buildSpecCompliancePrompt ─────────────────────────────────────────────────

describe('buildSpecCompliancePrompt', () => {
  it('includes acceptance criteria context from task prompt', () => {
    const task = makeTask()
    const prompt = buildSpecCompliancePrompt(task)
    expect(prompt).toContain('Acceptance Criteria')
    expect(prompt).toContain('spec-compliance')
    expect(prompt).toContain('REVIEW_VERDICT')
  })

  it('includes diff section when diff is provided', () => {
    const task = makeTask()
    const prompt = buildSpecCompliancePrompt(task, '+ added line')
    expect(prompt).toContain('## Diff')
    expect(prompt).toContain('+ added line')
  })

  it('includes file partition section when task has files', () => {
    const task = makeTask({ files: 'src/feature.ts\nsrc/feature.test.ts' })
    const prompt = buildSpecCompliancePrompt(task)
    expect(prompt).toContain('File Partition')
    expect(prompt).toContain('src/feature.ts')
  })
})

// ── buildCodeQualityPrompt ────────────────────────────────────────────────────

describe('buildCodeQualityPrompt', () => {
  it('includes code quality focus areas', () => {
    const task = makeTask()
    const prompt = buildCodeQualityPrompt(task)
    expect(prompt).toContain('code-quality')
    expect(prompt).toContain('TypeScript')
    expect(prompt).toContain('as any')
    expect(prompt).toContain('REVIEW_VERDICT')
  })

  it('includes diff section when diff is provided', () => {
    const task = makeTask()
    const prompt = buildCodeQualityPrompt(task, '- old line\n+ new line')
    expect(prompt).toContain('## Diff')
    expect(prompt).toContain('- old line')
  })
})

// ── runTwoStageReview ─────────────────────────────────────────────────────────

describe('runTwoStageReview', () => {
  it('Stage 1 PASS → Stage 2 runs, both stages in result', async () => {
    const task = makeTask()
    let callCount = 0
    const runner: ReviewRunnerFn = vi.fn().mockImplementation((_t, _l, m) => {
      callCount++
      const stage = callCount === 1 ? 'spec-compliance' : 'code-quality'
      return Promise.resolve({ verdict: 'pass' as const, feedback: makePassVerdict(stage), tokens: 50, model: m })
    })

    const result = await runTwoStageReview(task, runner, 'test-model')

    expect(runner).toHaveBeenCalledTimes(2)
    expect(result.stages).toHaveLength(2)
    expect(result.stages[0].stage).toBe('spec-compliance')
    expect(result.stages[0].verdict).toBe('pass')
    expect(result.stages[1].stage).toBe('code-quality')
    expect(result.overall_verdict).toBe('pass')
  })

  it('Stage 1 BLOCK → Stage 2 skipped, overall is block', async () => {
    const task = makeTask()
    const runner: ReviewRunnerFn = vi.fn().mockResolvedValue({
      verdict: 'block' as const,
      feedback: makeBlockVerdict('spec-compliance', ['Missing tests']),
      tokens: 75,
      model: 'test-model',
    })

    const result = await runTwoStageReview(task, runner, 'test-model')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(result.stages).toHaveLength(1)
    expect(result.stages[0].stage).toBe('spec-compliance')
    expect(result.stages[0].verdict).toBe('block')
    expect(result.overall_verdict).toBe('block')
  })

  it('Stage 1 PASS + Stage 2 BLOCK → overall BLOCK with 2 stages', async () => {
    const task = makeTask()
    let callCount = 0
    const runner: ReviewRunnerFn = vi.fn().mockImplementation((_t, _l, m) => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({ verdict: 'pass' as const, feedback: makePassVerdict('spec-compliance'), tokens: 60, model: m })
      }
      return Promise.resolve({ verdict: 'block' as const, feedback: makeBlockVerdict('code-quality', ['Uses as any']), tokens: 80, model: m })
    })

    const result = await runTwoStageReview(task, runner, 'test-model')

    expect(result.stages).toHaveLength(2)
    expect(result.stages[1].verdict).toBe('block')
    expect(result.overall_verdict).toBe('block')
  })

  it('Stage 1 PASS + Stage 2 PASS → overall PASS (happy path)', async () => {
    const task = makeTask()
    let callCount = 0
    const runner: ReviewRunnerFn = vi.fn().mockImplementation((_t, _l, m) => {
      callCount++
      const stage = callCount === 1 ? 'spec-compliance' : 'code-quality'
      return Promise.resolve({ verdict: 'pass' as const, feedback: makePassVerdict(stage), tokens: 40, model: m })
    })

    const result = await runTwoStageReview(task, runner, 'test-model')

    expect(result.overall_verdict).toBe('pass')
    expect(result.stages).toHaveLength(2)
    expect(result.stages.every(s => s.verdict === 'pass')).toBe(true)
  })

  it('total_tokens is sum of both stage tokens', async () => {
    const task = makeTask()
    let callCount = 0
    const runner: ReviewRunnerFn = vi.fn().mockImplementation((_t, _l, m) => {
      callCount++
      const stage = callCount === 1 ? 'spec-compliance' : 'code-quality'
      const tokens = callCount === 1 ? 100 : 150
      return Promise.resolve({ verdict: 'pass' as const, feedback: makePassVerdict(stage), tokens, model: m })
    })

    const result = await runTwoStageReview(task, runner, 'test-model')

    expect(result.total_tokens).toBe(250)
    expect(result.stages[0].tokens_used).toBe(100)
    expect(result.stages[1].tokens_used).toBe(150)
  })
})
