import type { ReviewHeuristics, Task, ExecuteOptions, ExecuteResult } from './spec-types.js'
import type { TaskRecord } from './types.js'

/**
 * Reviewing a task's change before it is merged.
 *
 * No reviewer was ever wired into the CLI, so every `review: fast` was stored
 * as a pass with 0 tokens and every panel as three passes — reviews counted on
 * the dashboard that never ran. The default reviewer is now the task's own
 * runtime, read-only, in the task's worktree. When it cannot run, or says
 * nothing that parses, the review is recorded as skipped: never as a pass.
 */

export interface DiffStats {
  linesChanged: number
  filesChanged: number
  filePaths: string[]
}

export type ReviewLevel = 'auto-pass' | 'fast' | 'panel'

export interface ReviewResult {
  /** `skipped` means no verdict was reached; the change is neither passed nor blocked by it. */
  verdict: 'pass' | 'block' | 'skipped'
  feedback: string
  tokens: number
  model: string | null
  costUsd?: number
}

/** What the engine hands a reviewer besides the task. */
export interface ReviewContext {
  /** The task's own prompt, without retry notes or the shared context. */
  prompt: string
  files: string[]
  diff: string
  cwd: string
  adapterName: string
  /** Runs one agent session; the engine tracks it so Ctrl+C can stop it. */
  execute: (task: Task, options: ExecuteOptions) => Promise<ExecuteResult>
  /** Whether the runtime can run without write access. */
  canRunReadOnly: boolean
  timeoutMs: number
  /** The model to review with when the spec sets no `reviewer_model`: the runtime's economy tier. */
  defaultModel?: string
}

export type ReviewRunner = (
  task: TaskRecord,
  level: ReviewLevel,
  reviewerModel: string,
  ctx?: ReviewContext,
) => Promise<ReviewResult>

/**
 * How much review a change gets.
 *
 * Small changes pass without a reviewer, everything else gets one fast review.
 * A panel (three reviewers) is expensive, so `auto` never picks it: only a spec
 * that asks for `review: panel` gets one. `panel_paths`/`panel_agents` used to
 * escalate automatically.
 */
export function evaluateReviewLevel(
  task: Pick<TaskRecord, 'agent'>,
  diff: DiffStats,
  heuristics?: ReviewHeuristics,
  allGatesPassed?: boolean,
): ReviewLevel {
  const autoPassAgents = heuristics?.auto_pass_agents ?? ['writer']
  const autoPassMaxLines = heuristics?.auto_pass_max_lines ?? 10
  const autoPassMaxFiles = heuristics?.auto_pass_max_files ?? 2
  const panelPaths = heuristics?.panel_paths ?? ['auth/', 'security/', 'migrations/', 'rls/']
  const panelAgents = heuristics?.panel_agents ?? ['security-expert', 'data-engineer']

  // Sensitive work is never waved through on size alone.
  const sensitive =
    panelPaths.some((p) => diff.filePaths.some((fp) => fp.startsWith(p) || fp.includes('/' + p))) ||
    panelAgents.includes(task.agent)
  if (sensitive) return 'fast'

  if (autoPassAgents.includes(task.agent)) return 'auto-pass'
  if (diff.linesChanged <= autoPassMaxLines && diff.filesChanged <= autoPassMaxFiles && allGatesPassed !== false) {
    return 'auto-pass'
  }
  return 'fast'
}

/** Lines added or removed in a unified diff. */
export function countChangedLines(diff: string): number {
  let n = 0
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) n++
  }
  return n
}

const DIFF_LIMIT = 60_000

export function buildReviewPrompt(task: Pick<TaskRecord, 'id' | 'agent'>, ctx: Pick<ReviewContext, 'prompt' | 'files' | 'diff'>): string {
  const diff = ctx.diff.length > DIFF_LIMIT
    ? ctx.diff.slice(0, DIFF_LIMIT) + `\n… (diff truncated; ${ctx.diff.length - DIFF_LIMIT} more characters — read the files in this worktree for the rest)`
    : ctx.diff
  return [
    `You are a code reviewer. Another agent (${task.agent}) just finished task "${task.id}" in this git worktree. Review its change before it is merged. Do not edit anything.`,
    '',
    '## The task it was given',
    ctx.prompt.trim(),
    '',
    ctx.files.length > 0 ? `## Files it was allowed to change\n${ctx.files.join(', ')}\n` : '',
    '## The change',
    '```diff',
    diff || '(no changes)',
    '```',
    '',
    'The diff is the whole change. Open a file only when the diff cannot answer a question, and do not explore the rest of the repository or run the test suite: the convoy runs the project\'s checks after merging. A review that read the repository cost more than the task it reviewed.',
    '',
    '## What to check',
    '1. Does the change do what the task asked, completely?',
    '2. Are there bugs, missing error handling, or broken behaviour?',
    '3. Does it stay within the files it was allowed to change?',
    '',
    'Block only for problems that must be fixed before merging. End your answer with exactly one verdict line:',
    '<!-- REVIEW_VERDICT { "verdict": "pass", "issues": [] } -->',
    'or',
    '<!-- REVIEW_VERDICT { "verdict": "block", "issues": ["what must change, and where"] } -->',
  ].filter((l) => l !== '').join('\n')
}

/** The reviewer's verdict, or null when its answer holds none. */
export function parseReviewVerdict(output: string): { verdict: 'pass' | 'block'; issues: string[] } | null {
  const matches = [...output.matchAll(/<!--\s*REVIEW_VERDICT\s*(\{[\s\S]*?\})\s*-->/g)]
  const last = matches[matches.length - 1]
  if (!last) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(last[1])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (p.verdict !== 'pass' && p.verdict !== 'block') return null
  const issues = Array.isArray(p.issues) ? p.issues.filter((i): i is string => typeof i === 'string') : []
  return { verdict: p.verdict, issues }
}

const skipped = (feedback: string, extra: Partial<ReviewResult> = {}): ReviewResult => ({
  verdict: 'skipped',
  feedback,
  tokens: 0,
  model: null,
  ...extra,
})

/**
 * Review with the task's own runtime, read-only (`permissionMode: 'plan'`), in
 * the task's worktree, where the reviewer can open the files it is judging.
 */
export const defaultReviewer: ReviewRunner = async (task, _level, reviewerModel, ctx) => {
  if (!ctx) return skipped('no reviewer context')
  if (!ctx.canRunReadOnly) {
    return skipped(`the ${ctx.adapterName} runtime cannot run a read-only reviewer`)
  }
  const reviewTask: Task = {
    id: `${task.id}-review`,
    prompt: buildReviewPrompt(task, ctx),
    agent: 'reviewer',
    timeout: `${Math.round(ctx.timeoutMs / 1000)}s`,
    depends_on: [],
    files: [],
    description: `Review of ${task.id}`,
    max_retries: 0,
  }
  let result: ExecuteResult
  try {
    result = await ctx.execute(reviewTask, {
      cwd: ctx.cwd,
      permissionMode: 'plan',
      model: reviewerModel && reviewerModel !== 'default' ? reviewerModel : ctx.defaultModel,
    })
  } catch (err) {
    return skipped(`the reviewer could not start: ${(err as Error).message}`)
  }
  const tokens = result.usage?.total_tokens
    ?? ((result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0))
  const spent = { tokens, model: result.model ?? null, costUsd: result.costUsd }
  if (result._timedOut) return skipped('the reviewer timed out', spent)
  if (!result.success) return skipped(`the reviewer exited with code ${result.exitCode}`, spent)
  const verdict = parseReviewVerdict(result.output)
  if (!verdict) return skipped('the reviewer gave no verdict', spent)
  return {
    verdict: verdict.verdict,
    feedback: verdict.issues.join('\n'),
    ...spent,
  }
}
