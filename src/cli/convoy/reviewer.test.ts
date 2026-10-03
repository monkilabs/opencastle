import { describe, it, expect, vi } from 'vitest'
import { buildReviewPrompt, countChangedLines, defaultReviewer, parseReviewVerdict, type ReviewContext } from './reviewer.js'
import type { TaskRecord } from './types.js'

const task = { id: 'api', agent: 'developer' } as TaskRecord

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    prompt: 'Build the API',
    files: ['src/api.ts'],
    diff: 'diff --git a/src/api.ts b/src/api.ts\n+export const x = 1\n',
    cwd: '/work/tree',
    adapterName: 'claude',
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: 'Fine.\n<!-- REVIEW_VERDICT { "verdict": "pass", "issues": [] } -->',
      exitCode: 0,
      usage: { prompt_tokens: 800, completion_tokens: 40 },
      costUsd: 0.004,
      model: 'claude-haiku-4-5',
    }),
    canRunReadOnly: true,
    timeoutMs: 60_000,
    ...overrides,
  }
}

describe('parseReviewVerdict', () => {
  it('reads the last verdict comment', () => {
    const out = 'Example: <!-- REVIEW_VERDICT { "verdict": "pass", "issues": [] } -->\nActual:\n<!-- REVIEW_VERDICT { "verdict": "block", "issues": ["no tests"] } -->'
    expect(parseReviewVerdict(out)).toEqual({ verdict: 'block', issues: ['no tests'] })
  })

  it('returns null for no verdict, bad JSON, or an unknown verdict', () => {
    expect(parseReviewVerdict('looks good to me')).toBeNull()
    expect(parseReviewVerdict('<!-- REVIEW_VERDICT { verdict: pass } -->')).toBeNull()
    expect(parseReviewVerdict('<!-- REVIEW_VERDICT { "verdict": "maybe", "issues": [] } -->')).toBeNull()
  })
})

describe('buildReviewPrompt', () => {
  it('carries the task, its files and the diff, and asks for one verdict line', () => {
    const prompt = buildReviewPrompt(task, ctx())
    expect(prompt).toContain('Build the API')
    expect(prompt).toContain('src/api.ts')
    expect(prompt).toContain('+export const x = 1')
    expect(prompt).toContain('REVIEW_VERDICT')
    expect(prompt).toContain('Do not edit anything')
  })

  it('truncates a very large diff and says so', () => {
    const prompt = buildReviewPrompt(task, ctx({ diff: 'x'.repeat(100_000) }))
    expect(prompt.length).toBeLessThan(70_000)
    expect(prompt).toContain('diff truncated')
  })
})

describe('defaultReviewer', () => {
  it('runs read-only in the task’s worktree and reports what it spent', async () => {
    const c = ctx()
    const result = await defaultReviewer(task, 'fast', 'claude-haiku-4-5', c)
    expect(c.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'api-review', agent: 'reviewer' }),
      { cwd: '/work/tree', permissionMode: 'plan', model: 'claude-haiku-4-5' },
    )
    expect(result).toEqual({ verdict: 'pass', feedback: '', tokens: 840, model: 'claude-haiku-4-5', costUsd: 0.004 })
  })

  it('passes no model when the spec names none', async () => {
    const c = ctx()
    await defaultReviewer(task, 'fast', 'default', c)
    expect(vi.mocked(c.execute).mock.calls[0][1]).toEqual({ cwd: '/work/tree', permissionMode: 'plan', model: undefined })
  })

  it('is skipped, never passed, when it cannot run read-only, fails, times out, or gives no verdict', async () => {
    expect((await defaultReviewer(task, 'fast', 'default', ctx({ canRunReadOnly: false }))).verdict).toBe('skipped')
    expect((await defaultReviewer(task, 'fast', 'default', undefined)).verdict).toBe('skipped')
    const failing = ctx({ execute: vi.fn().mockResolvedValue({ success: false, output: 'boom', exitCode: 1 }) })
    expect(await defaultReviewer(task, 'fast', 'default', failing)).toMatchObject({ verdict: 'skipped', feedback: 'the reviewer exited with code 1' })
    const timedOut = ctx({ execute: vi.fn().mockResolvedValue({ success: false, output: '', exitCode: -1, _timedOut: true }) })
    expect((await defaultReviewer(task, 'fast', 'default', timedOut)).feedback).toBe('the reviewer timed out')
    const mute = ctx({ execute: vi.fn().mockResolvedValue({ success: true, output: 'LGTM', exitCode: 0 }) })
    expect(await defaultReviewer(task, 'fast', 'default', mute)).toMatchObject({ verdict: 'skipped', feedback: 'the reviewer gave no verdict' })
    const throws = ctx({ execute: vi.fn().mockRejectedValue(new Error('spawn ENOENT')) })
    expect((await defaultReviewer(task, 'fast', 'default', throws)).feedback).toContain('spawn ENOENT')
  })

  it('returns the issues as feedback on a block', async () => {
    const c = ctx({ execute: vi.fn().mockResolvedValue({ success: true, output: '<!-- REVIEW_VERDICT { "verdict": "block", "issues": ["a", "b"] } -->', exitCode: 0 }) })
    expect(await defaultReviewer(task, 'fast', 'default', c)).toMatchObject({ verdict: 'block', feedback: 'a\nb' })
  })
})

describe('countChangedLines', () => {
  it('counts added and removed lines, not the file headers', () => {
    expect(countChangedLines('--- a/x\n+++ b/x\n-old\n+new\n+more\n context')).toBe(3)
  })
})
