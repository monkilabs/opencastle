import { describe, it, expect } from 'vitest'
import {
  buildSharedContext,
  buildTaskSection,
  composePrompt,
  summarizeTask,
  formatDependencyResults,
  detectPartitionViolations,
  type DependencyResult,
  type PlanEntry,
} from './isolation.js'

const plan: PlanEntry[] = [
  { id: 'api', agent: 'developer', summary: 'Build the API', files: ['src/api/'], depends_on: [] },
  { id: 'tests', agent: 'testing-expert', summary: 'Test the API', files: ['test/api.test.ts'], depends_on: ['api'] },
]

describe('buildSharedContext', () => {
  const shared = buildSharedContext({ convoyName: 'Auth', plan, artifactsDir: '/repo/.opencastle/artifacts/c1/' })

  it('lists the whole plan with dependencies and files', () => {
    expect(shared).toContain('# Convoy: Auth')
    expect(shared).toContain('- api [developer]: Build the API — files: src/api/')
    expect(shared).toContain('- tests [testing-expert] (after api): Test the API — files: test/api.test.ts')
  })

  it('states the file rule once, and names no runtime-specific path', () => {
    expect(shared.match(/Change only the files/g)).toHaveLength(1)
    expect(shared).not.toContain('.github/instructions')
  })

  it('is the same text for every task, so a prompt cache can serve it', () => {
    const a = composePrompt(shared, buildTaskSection({ id: 'api', agent: 'developer', files: ['src/api/'], prompt: 'Build it' }))
    const b = composePrompt(shared, buildTaskSection({ id: 'tests', agent: 'testing-expert', files: [], prompt: 'Test it' }))
    expect(a.startsWith(shared)).toBe(true)
    expect(b.startsWith(shared)).toBe(true)
  })
})

describe('buildTaskSection', () => {
  it('puts the task prompt in once, with no copied "Objective"', () => {
    const prompt = 'Please implement the auth service with JWT tokens'
    const section = buildTaskSection({ id: 'task-1', agent: 'developer', files: ['src/auth/'], prompt })
    expect(section).toContain('## Your task: task-1')
    expect(section).toContain('You are the developer agent for this task.')
    expect(section).toContain('Files you may change: src/auth/')
    expect(section.split(prompt)).toHaveLength(2)
    expect(section).not.toContain('Objective')
  })

  it('adds dependency results, earlier work, the retry note and the contract only when present', () => {
    const deps: DependencyResult[] = [
      { taskId: 'task-0', agent: 'architect', status: 'done', summary: 'Designed the auth schema', filesChanged: ['schema.ts'] },
    ]
    const bare = buildTaskSection({ id: 't', agent: 'developer', files: [], prompt: 'Do it' })
    expect(bare).toContain('Files: not limited to a list')
    expect(bare).not.toContain('previous attempt')

    const full = buildTaskSection({
      id: 't',
      agent: 'developer',
      files: [],
      prompt: 'Do it',
      dependencyResults: deps,
      previousWork: ['Last time I did X'],
      retryNote: 'The gate `npm test` failed',
      contract: '## Output Contract (REQUIRED)',
    })
    expect(full).toContain('Designed the auth schema')
    expect(full).toContain('Last time I did X')
    expect(full).toContain('### Your previous attempt\nThe gate `npm test` failed')
    // The task's own prompt survives a retry: the note is added, not swapped in.
    expect(full).toContain('### Instructions\nDo it')
    expect(full.indexOf('### Instructions')).toBeLessThan(full.indexOf('### Your previous attempt'))
    expect(full.trim().endsWith('## Output Contract (REQUIRED)')).toBe(true)
  })
})

describe('summarizeTask', () => {
  it('prefers a real description, else the first line of the prompt, trimmed', () => {
    expect(summarizeTask({ id: 'a', description: 'Write docs', prompt: 'x' })).toBe('Write docs')
    expect(summarizeTask({ id: 'a', description: 'a', prompt: '\nFirst line\nsecond' })).toBe('First line')
    expect(summarizeTask({ id: 'a', prompt: 'A'.repeat(300) }).length).toBe(100)
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
