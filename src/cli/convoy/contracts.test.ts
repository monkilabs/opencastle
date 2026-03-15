import { describe, it, expect } from 'vitest'
import {
  AGENT_CONTRACTS,
  validateOutput,
  buildContractInstruction,
  buildContractRetryPrompt,
} from './contracts.js'

// ── Registry well-formedness ──────────────────────────────────────────────────

describe('AGENT_CONTRACTS registry', () => {
  it('has entries for all expected agents', () => {
    const expectedAgents = [
      'developer', 'ui-ux-expert', 'testing-expert', 'security-expert',
      'architect', 'researcher', 'reviewer', 'documentation-writer',
      'copywriter', 'performance-expert', 'database-engineer', 'devops-expert',
      'api-designer', 'data-expert', 'seo-specialist', 'release-manager',
    ]
    for (const agent of expectedAgents) {
      expect(AGENT_CONTRACTS).toHaveProperty(agent)
    }
  })

  it('every contract has non-empty required_fields', () => {
    for (const [key, contract] of Object.entries(AGENT_CONTRACTS)) {
      expect(contract.required_fields.length, `${key} should have required_fields`).toBeGreaterThan(0)
    }
  })

  it('every required field has a schema entry', () => {
    for (const [key, contract] of Object.entries(AGENT_CONTRACTS)) {
      for (const field of contract.required_fields) {
        expect(contract.schema, `${key}.${field} missing schema entry`).toHaveProperty(field)
      }
    }
  })

  it('every schema entry has a valid type', () => {
    const validTypes = new Set(['string', 'string[]', 'number', 'boolean', 'object'])
    for (const [key, contract] of Object.entries(AGENT_CONTRACTS)) {
      for (const [field, spec] of Object.entries(contract.schema)) {
        expect(validTypes.has(spec.type), `${key}.${field} has invalid type "${spec.type}"`).toBe(true)
      }
    }
  })

  it('every schema entry has a description', () => {
    for (const [key, contract] of Object.entries(AGENT_CONTRACTS)) {
      for (const [field, spec] of Object.entries(contract.schema)) {
        expect(spec.description, `${key}.${field} missing description`).toBeTruthy()
      }
    }
  })

  it('all optional_fields arrays are empty', () => {
    for (const [key, contract] of Object.entries(AGENT_CONTRACTS)) {
      expect(contract.optional_fields, `${key} should have empty optional_fields`).toHaveLength(0)
    }
  })
})

// ── validateOutput ────────────────────────────────────────────────────────────

describe('validateOutput', () => {
  it('returns valid for a complete developer contract block', () => {
    const output = `
Some work done here.

<!-- OUTPUT_CONTRACT
{ "files_changed": ["src/foo.ts"], "tests_added": ["src/foo.test.ts"], "summary": "Added foo feature" }
-->
`
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(true)
    expect(result.missing).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
    expect(result.data).toBeDefined()
  })

  it('returns valid=false with missing __contract_block when no block present', () => {
    const result = validateOutput('developer', 'No contract block here.')
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('__contract_block')
    expect(result.warnings).toHaveLength(0)
  })

  it('returns valid=false with invalid_json warning when JSON is malformed', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ invalid json }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('__contract_block')
    expect(result.warnings).toContain('invalid_json')
  })

  it('lists missing required fields', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": ["src/foo.ts"] }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('tests_added')
    expect(result.missing).toContain('summary')
    expect(result.missing).not.toContain('files_changed')
  })

  it('returns valid=true with no_contract_defined warning for unknown agent', () => {
    const result = validateOutput('unknown-agent-xyz', 'any output')
    expect(result.valid).toBe(true)
    expect(result.missing).toHaveLength(0)
    expect(result.warnings).toContain('no_contract_defined')
  })

  it('is case-insensitive for agent name lookup', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": ["src/foo.ts"], "tests_added": [], "summary": "done" }\n-->'
    const result = validateOutput('Developer', output)
    expect(result.valid).toBe(true)
  })

  it('works for all registered agents with minimal valid data', () => {
    const minimalData: Record<string, Record<string, unknown>> = {
      'developer': { files_changed: ['src/foo.ts'], tests_added: ['src/foo.test.ts'], summary: 'done' },
      'ui-ux-expert': { files_changed: ['src/btn.tsx'], components_created: ['src/btn.tsx'], a11y_verified: true, summary: 'done' },
      'testing-expert': { test_files: ['src/foo.test.ts'], coverage_summary: '95%', summary: 'done' },
      'security-expert': { findings: [], severity: 'none', files_reviewed: ['src/auth.ts'], summary: 'done' },
      'architect': { decision: 'use microservices', alternatives_considered: 'monolith', risks: 'complexity', summary: 'done' },
      'researcher': { findings: 'found stuff', sources: ['https://example.com'], confidence: 'high', summary: 'done' },
      'reviewer': { verdict: 'pass', issues: [], summary: 'done' },
      'documentation-writer': { files_changed: ['docs/readme.md'], summary: 'done' },
      'copywriter': { content: 'some content', word_count: 50, summary: 'done' },
      'performance-expert': { metrics_before: {}, metrics_after: {}, files_changed: [], summary: 'done' },
      'database-engineer': { migrations: [], rls_policies: [], rollback_plan: 'delete rows', summary: 'done' },
      'devops-expert': { files_changed: [], env_vars_added: [], summary: 'done' },
      'api-designer': { endpoints: ['/api/v1/resource'], schemas: ['ResourceSchema'], summary: 'done' },
      'data-expert': { pipeline_steps: ['extract', 'transform'], files_changed: [], summary: 'done' },
      'seo-specialist': { files_changed: [], tags_added: ['og:title'], summary: 'done' },
      'release-manager': { version: '1.0.0', changelog_entries: ['feat: new thing'], checks_passed: true, summary: 'done' },
    }
    for (const [agent, data] of Object.entries(minimalData)) {
      const output = `<!-- OUTPUT_CONTRACT\n${JSON.stringify(data)}\n-->`
      const result = validateOutput(agent, output)
      expect(result.valid, `${agent} should be valid with minimal data`).toBe(true)
    }
  })
})

// ── Validation rules ──────────────────────────────────────────────────────────

describe('validateOutput validation rules', () => {
  it('non-empty rejects empty string for summary', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": ["src/foo.ts"], "tests_added": [], "summary": "" }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('summary')
  })

  it('non-empty rejects whitespace-only string for summary', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": ["src/foo.ts"], "tests_added": [], "summary": "   " }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('summary')
  })

  it('file-paths rejects non-array for files_changed', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": "src/foo.ts", "tests_added": [], "summary": "done" }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('files_changed')
  })

  it('file-paths rejects array with non-string values', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": [1, 2], "tests_added": [], "summary": "done" }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('files_changed')
  })

  it('file-paths accepts empty array', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "files_changed": [], "tests_added": [], "summary": "done" }\n-->'
    const result = validateOutput('developer', output)
    expect(result.valid).toBe(true)
  })

  it('positive-int rejects zero for word_count', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "content": "text", "word_count": 0, "summary": "done" }\n-->'
    const result = validateOutput('copywriter', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('word_count')
  })

  it('positive-int rejects negative number for word_count', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "content": "text", "word_count": -5, "summary": "done" }\n-->'
    const result = validateOutput('copywriter', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('word_count')
  })

  it('positive-int rejects non-number for word_count', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "content": "text", "word_count": "fifty", "summary": "done" }\n-->'
    const result = validateOutput('copywriter', output)
    expect(result.valid).toBe(false)
    expect(result.missing).toContain('word_count')
  })

  it('positive-int accepts valid positive number for word_count', () => {
    const output = '<!-- OUTPUT_CONTRACT\n{ "content": "text", "word_count": 100, "summary": "done" }\n-->'
    const result = validateOutput('copywriter', output)
    expect(result.valid).toBe(true)
  })
})

// ── buildContractInstruction ──────────────────────────────────────────────────

describe('buildContractInstruction', () => {
  it('returns instruction string for known agents', () => {
    const instruction = buildContractInstruction('developer')
    expect(instruction).not.toBeNull()
    expect(instruction).toContain('OUTPUT_CONTRACT')
    expect(instruction).toContain('files_changed')
    expect(instruction).toContain('tests_added')
    expect(instruction).toContain('summary')
    expect(instruction).toContain('REQUIRED')
  })

  it('returns null for unknown agents', () => {
    const instruction = buildContractInstruction('unknown-agent-xyz')
    expect(instruction).toBeNull()
  })

  it('is case-insensitive for agent lookup', () => {
    const instruction = buildContractInstruction('Developer')
    expect(instruction).not.toBeNull()
  })

  it('includes all required fields in the REQUIRED list', () => {
    for (const [agent, contract] of Object.entries(AGENT_CONTRACTS)) {
      const instruction = buildContractInstruction(agent)
      expect(instruction).not.toBeNull()
      for (const field of contract.required_fields) {
        expect(instruction).toContain(field)
      }
    }
  })

  it('includes comment block markers', () => {
    const instruction = buildContractInstruction('developer')
    expect(instruction).toContain('<!-- OUTPUT_CONTRACT')
    expect(instruction).toContain('-->')
  })
})

// ── buildContractRetryPrompt ──────────────────────────────────────────────────

describe('buildContractRetryPrompt', () => {
  it('includes missing field names in the prompt', () => {
    const result = { valid: false, missing: ['files_changed', 'summary'], warnings: [] }
    const prompt = buildContractRetryPrompt(result)
    expect(prompt).toContain('files_changed')
    expect(prompt).toContain('summary')
  })

  it('includes OUTPUT_CONTRACT block template', () => {
    const result = { valid: false, missing: ['__contract_block'], warnings: [] }
    const prompt = buildContractRetryPrompt(result)
    expect(prompt).toContain('OUTPUT_CONTRACT')
    expect(prompt).toContain('-->')
  })

  it('mentions that the previous output was missing the block', () => {
    const result = { valid: false, missing: ['__contract_block'], warnings: [] }
    const prompt = buildContractRetryPrompt(result)
    expect(prompt.toLowerCase()).toContain('missing')
  })

  it('handles multiple missing fields', () => {
    const result = { valid: false, missing: ['field_a', 'field_b', 'field_c'], warnings: [] }
    const prompt = buildContractRetryPrompt(result)
    expect(prompt).toContain('field_a')
    expect(prompt).toContain('field_b')
    expect(prompt).toContain('field_c')
  })
})
