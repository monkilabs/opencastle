import { describe, expect, it } from 'vitest'
import { editDistance, nearest } from './nearest.js'

describe('editDistance', () => {
  it('counts single-character edits', () => {
    expect(editDistance('--port', '--prot')).toBe(2)
    expect(editDistance('--dryRun', '--dry-run')).toBe(2)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('same', 'same')).toBe(0)
  })
})

describe('nearest', () => {
  it('names a likely typo', () => {
    expect(nearest('--verbos', ['--dry-run', '--verbose'])).toBe('--verbose')
    expect(nearest('resum', ['run', 'resume', 'dashboard'])).toBe('resume')
  })

  it('names nothing when nothing is close, rather than a wrong guess', () => {
    expect(nearest('--json', ['--port', '--no-open'])).toBeNull()
    expect(nearest('status', ['run', 'resume', 'dashboard', 'plan'])).toBeNull()
  })

  it('can ignore case', () => {
    expect(nearest('McpServers', ['mcpServers'], { ignoreCase: true })).toBe('mcpServers')
  })
})
