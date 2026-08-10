/**
 * `--dry-run` on the paths that already had state to act on.
 *
 * The defect: `opts.dryRun` was read only on the fresh-run path, so
 * `convoy run --retry-failed --dry-run` and `--resume --dry-run` accepted the
 * flag and then executed agents against the user's repository for real. The one
 * flag people reach for to find out what will happen was the one that changed
 * nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  printRunDryRun,
  RETRYABLE_TASK_STATUSES,
  RESUMABLE_TASK_STATUSES,
} from './run.js'

function task(id: string, status: string, agent = 'developer') {
  return { id, agent, status }
}

let out: string[]
beforeEach(() => {
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const text = (): string => out.join('\n')

describe('retryable and resumable status sets', () => {
  it('reopens exactly the statuses the engine reopens', () => {
    // engine.retryFailed's own list — kept here so a change to one is a change
    // to a shared constant rather than a silent divergence.
    expect([...RETRYABLE_TASK_STATUSES]).toEqual([
      'failed',
      'gate-failed',
      'timed-out',
      'review-blocked',
      'disputed',
    ])
  })

  it('resumes the unfinished statuses, and never a done one', () => {
    expect([...RESUMABLE_TASK_STATUSES]).toEqual(['pending', 'assigned', 'running'])
    expect(RESUMABLE_TASK_STATUSES).not.toContain('done')
  })
})

describe('printRunDryRun', () => {
  it('says plainly that nothing will be executed', () => {
    printRunDryRun('retry', 'Convoy (Retry Failed)', 'My Run', [task('a', 'failed')], RETRYABLE_TASK_STATUSES)
    expect(text()).toContain('[dry-run] Nothing will be executed.')
  })

  it('lists only the tasks the verb would touch', () => {
    const tasks = [
      task('build', 'done'),
      task('test', 'failed'),
      task('docs', 'gate-failed', 'writer'),
      task('ship', 'pending'),
    ]
    printRunDryRun('retry', 'Convoy (Retry Failed)', 'My Run', tasks, RETRYABLE_TASK_STATUSES)
    const s = text()
    expect(s).toContain('Would re-run 2 of 4 task(s)')
    expect(s).toContain('test')
    expect(s).toContain('docs')
    // A finished task and a not-yet-started one are not retries.
    expect(s).not.toMatch(/^\s+build/m)
    expect(s).not.toMatch(/^\s+ship/m)
  })

  it('shows each task with its agent and status, so the plan can be checked', () => {
    printRunDryRun('resume', 'Convoy (Resume)', 'My Run', [task('api', 'pending', 'architect')], RESUMABLE_TASK_STATUSES)
    expect(text()).toMatch(/api.*architect.*pending/)
  })

  it('reports an empty work set rather than printing an empty list', () => {
    printRunDryRun('resume', 'Convoy (Resume)', 'My Run', [task('a', 'done')], RESUMABLE_TASK_STATUSES)
    const s = text()
    expect(s).toContain('No unfinished tasks')
    expect(s).toContain('pending, assigned, running')
  })

  it('uses the verb the user typed when there is nothing to retry', () => {
    printRunDryRun('retry', 'Convoy (Retry Failed)', 'My Run', [task('a', 'done')], RETRYABLE_TASK_STATUSES)
    expect(text()).toContain('No failed tasks to retry.')
  })

  it('names the run, so a preview cannot be mistaken for another one', () => {
    printRunDryRun('resume', 'Pipeline (Resume)', 'Checkout Rework', [], RESUMABLE_TASK_STATUSES)
    expect(text()).toContain('Pipeline (Resume): Checkout Rework')
  })
})
