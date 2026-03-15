import type { TaskRecord } from './types.js'
import type { ReviewStage, StageVerdict, TwoStageReviewResult } from './types.js'
import type { ReviewLevel, ReviewResult } from './engine.js'

export type ReviewRunnerFn = (
  task: TaskRecord,
  level: ReviewLevel,
  model: string,
) => Promise<ReviewResult>

// ── Stage prompt builders ─────────────────────────────────────────────────────

export function buildSpecCompliancePrompt(task: TaskRecord, diff?: string): string {
  const diffSection = diff ? `\n\n## Diff\n\`\`\`\n${diff}\n\`\`\`` : ''
  const filesSection = task.files ? `\n\n## File Partition\n${task.files}` : ''

  return `You are a spec-compliance reviewer. Your job is to verify the implementation matches the original specification.

## Task Prompt
${task.prompt}
${filesSection}${diffSection}

## Review Criteria (Stage 1 — Spec Compliance)

1. Does the implementation match ALL acceptance criteria from the task prompt?
2. Are all required deliverables present and complete?
3. Do tests exist for all new functionality?
4. Is the change confined to the assigned file partition (no out-of-scope files modified)?

Respond with a single HTML comment containing a JSON verdict. Do not include any other text after the verdict comment.

<!-- REVIEW_VERDICT { "stage": "spec-compliance", "verdict": "pass", "issues": [] } -->

Use "block" if ANY criterion fails, and list the specific issues. Example:

<!-- REVIEW_VERDICT { "stage": "spec-compliance", "verdict": "block", "issues": ["Missing tests for edge case X", "File src/other.ts is outside the partition"] } -->`
}

export function buildCodeQualityPrompt(task: TaskRecord, diff?: string): string {
  const diffSection = diff ? `\n\n## Diff\n\`\`\`\n${diff}\n\`\`\`` : ''

  return `You are a code-quality reviewer. The implementation has already passed spec compliance. Now review for code quality.

## Task Prompt
${task.prompt}
${diffSection}

## Review Criteria (Stage 2 — Code Quality)

1. Is the code idiomatic for the project conventions (TypeScript-first, no \`as any\`, proper types)?
2. Are there type safety issues (missing types, unsafe casts, untyped props)?
3. Are there obvious bugs, race conditions, or error handling gaps?
4. Are there DRY violations, dead code, or unnecessary complexity?

Respond with a single HTML comment containing a JSON verdict. Do not include any other text after the verdict comment.

<!-- REVIEW_VERDICT { "stage": "code-quality", "verdict": "pass", "issues": [] } -->

Use "block" if ANY criterion fails, and list the specific issues. Example:

<!-- REVIEW_VERDICT { "stage": "code-quality", "verdict": "block", "issues": ["Uses 'as any' cast on line 42", "Swallowed exception in catch block"] } -->`
}

// ── Verdict parser ────────────────────────────────────────────────────────────

export function parseStageVerdict(output: string, expectedStage: ReviewStage): StageVerdict {
  const fallback: StageVerdict = {
    stage: expectedStage,
    verdict: 'block',
    issues: ['Failed to parse reviewer output'],
    tokens_used: 0,
  }

  const match = output.match(/<!--\s*REVIEW_VERDICT\s*(\{[\s\S]*?\})\s*-->/)
  if (!match) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return fallback
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('stage' in parsed) ||
    !('verdict' in parsed) ||
    !('issues' in parsed)
  ) {
    return fallback
  }

  const p = parsed as Record<string, unknown>
  const verdict = p['verdict'] === 'pass' ? 'pass' : 'block'
  const issues = Array.isArray(p['issues'])
    ? (p['issues'] as unknown[]).filter((i): i is string => typeof i === 'string')
    : []

  return {
    stage: expectedStage,
    verdict,
    issues,
    tokens_used: 0,
  }
}

// ── Two-stage runner ──────────────────────────────────────────────────────────

export async function runTwoStageReview(
  task: TaskRecord,
  reviewRunner: ReviewRunnerFn,
  reviewerModel: string,
): Promise<TwoStageReviewResult> {
  // Stage 1: spec compliance
  const stage1Result = await reviewRunner(task, 'fast', reviewerModel)
  // Use ReviewResult.verdict as authoritative gate; parseStageVerdict extracts issues only on successful parse
  const stage1Parsed = parseStageVerdict(stage1Result.feedback, 'spec-compliance')
  const stage1Issues = resolveIssues(stage1Parsed, stage1Result)
  const stage1Verdict: StageVerdict = {
    stage: 'spec-compliance',
    verdict: stage1Result.verdict,
    issues: stage1Issues,
    tokens_used: stage1Result.tokens,
  }

  if (stage1Verdict.verdict === 'block') {
    return {
      stages: [stage1Verdict],
      overall_verdict: 'block',
      total_tokens: stage1Verdict.tokens_used,
    }
  }

  // Stage 2: code quality (only runs if stage 1 passes)
  const stage2Result = await reviewRunner(task, 'fast', reviewerModel)
  const stage2Parsed = parseStageVerdict(stage2Result.feedback, 'code-quality')
  const stage2Issues = resolveIssues(stage2Parsed, stage2Result)
  const stage2Verdict: StageVerdict = {
    stage: 'code-quality',
    verdict: stage2Result.verdict,
    issues: stage2Issues,
    tokens_used: stage2Result.tokens,
  }

  return {
    stages: [stage1Verdict, stage2Verdict],
    overall_verdict: stage2Verdict.verdict,
    total_tokens: stage1Verdict.tokens_used + stage2Verdict.tokens_used,
  }
}

/**
 * Resolve issues from stage verdict, falling back to raw feedback when
 * structured parsing failed (e.g. legacy reviewers or test mocks).
 */
function resolveIssues(parsed: StageVerdict, raw: ReviewResult): string[] {
  if (
    parsed.issues.length === 1 &&
    parsed.issues[0] === 'Failed to parse reviewer output' &&
    raw.feedback
  ) {
    return [raw.feedback]
  }
  return parsed.issues
}
