import { describe, it, expect } from 'vitest'
import {
  buildIsolationPreamble,
  formatDependencyResults,
  detectPartitionViolations,
  type DependencyResult,
} from './isolation.js'

describe('buildIsolationPreamble', () => {
  const baseTask = {
    id: 'task-1',
    description: 'Implement the auth service',
    prompt: 'Please implement the auth service with JWT tokens',
    files: ['src/auth/', 'src/services/auth.ts'],
    agent: 'developer',
  }

  it('with no dependencies contains task ID, agent, description, file list, and no-dependency text', () => {
    const result = buildIsolationPreamble(baseTask, [])
    expect(result).toContain('task-1')
    expect(result).toContain('developer')
    expect(result).toContain('Implement the auth service')
    expect(result).toContain('src/auth/')
    expect(result).toContain('src/services/auth.ts')
    expect(result).toContain('No dependencies')
    expect(result).toContain('first phase')
  })

  it('with 2 completed dependencies includes dependency summaries and files', () => {
    const depResults: DependencyResult[] = [
      { taskId: 'task-0', agent: 'architect', status: 'done', summary: 'Designed the auth schema', filesChanged: ['schema.ts', 'types.ts'] },
      { taskId: 'task-0b', agent: 'developer', status: 'done', summary: 'Set up project structure', filesChanged: ['package.json'] },
    ]
    const result = buildIsolationPreamble(baseTask, depResults)
    expect(result).toContain('task-0')
    expect(result).toContain('Designed the auth schema')
    expect(result).toContain('schema.ts, types.ts')
    expect(result).toContain('task-0b')
    expect(result).toContain('package.json')
    expect(result).not.toContain('No dependencies')
  })

  it('with failed dependency includes failure status', () => {
    const depResults: DependencyResult[] = [
      { taskId: 'task-x', agent: 'developer', status: 'failed', summary: 'Build failed due to type errors', filesChanged: [] },
    ]
    const result = buildIsolationPreamble(baseTask, depResults)
    expect(result).toContain('failed')
    expect(result).toContain('Build failed due to type errors')
  })

  it('uses prompt slice when no description', () => {
    const longPrompt = 'A'.repeat(300)
    const task = { ...baseTask, description: '', prompt: longPrompt }
    const result = buildIsolationPreamble(task, [])
    expect(result).toContain('A'.repeat(200))
    expect(result).not.toContain('A'.repeat(201))
  })
})

describe('formatDependencyResults', () => {
  it('compact format includes summary and filesChanged but not full output', () => {
    const deps: DependencyResult[] = [
      {
        taskId: 'dep-1',
        agent: 'developer',
        status: 'done',
        summary: 'Completed auth setup',
        filesChanged: ['src/auth.ts', 'src/index.ts'],
      },
    ]
    const result = formatDependencyResults(deps)
    expect(result).toContain('dep-1')
    expect(result).toContain('developer')
    expect(result).toContain('done')
    expect(result).toContain('Completed auth setup')
    expect(result).toContain('src/auth.ts, src/index.ts')
  })

  it('shows no-summary placeholder when summary is null', () => {
    const deps: DependencyResult[] = [
      { taskId: 'dep-2', agent: 'architect', status: 'done', summary: null, filesChanged: [] },
    ]
    const result = formatDependencyResults(deps)
    expect(result).toContain('No summary available.')
    expect(result).toContain('Files changed: none')
  })
})

describe('detectPartitionViolations', () => {
  it('returns null when all files are within partition', () => {
    const result = detectPartitionViolations(
      'task-1',
      ['src/auth/', 'src/types.ts'],
      ['src/auth/service.ts', 'src/auth/utils.ts', 'src/types.ts'],
    )
    expect(result).toBeNull()
  })

  it('detects files outside partition', () => {
    const result = detectPartitionViolations(
      'task-1',
      ['src/auth/'],
      ['src/auth/service.ts', 'src/other/unrelated.ts'],
    )
    expect(result).not.toBeNull()
    expect(result!.violations).toContain('src/other/unrelated.ts')
    expect(result!.violations).not.toContain('src/auth/service.ts')
    expect(result!.taskId).toBe('task-1')
    expect(result!.allowedFiles).toEqual(['src/auth/'])
  })

  it('handles directory paths - src/auth/ allows src/auth/service.ts', () => {
    const result = detectPartitionViolations(
      'task-1',
      ['src/auth/'],
      ['src/auth/service.ts', 'src/auth/utils/helper.ts'],
    )
    expect(result).toBeNull()
  })

  it('handles exact file matches - src/index.ts allows only that exact file', () => {
    const result = detectPartitionViolations(
      'task-1',
      ['src/index.ts'],
      ['src/index.ts', 'src/other.ts'],
    )
    expect(result).not.toBeNull()
    expect(result!.violations).toContain('src/other.ts')
    expect(result!.violations).not.toContain('src/index.ts')
  })

  it('returns null for empty actualFiles', () => {
    const result = detectPartitionViolations('task-1', ['src/auth/'], [])
    expect(result).toBeNull()
  })
})
