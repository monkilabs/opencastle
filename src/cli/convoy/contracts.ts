export interface FieldSpec {
  type: 'string' | 'string[]' | 'number' | 'boolean' | 'object'
  description: string
  validation?: 'non-empty' | 'file-paths' | 'positive-int'
}

export interface OutputContract {
  agent: string
  required_fields: string[]
  optional_fields: string[]
  schema: Record<string, FieldSpec>
}

export interface ContractResult {
  valid: boolean
  missing: string[]
  warnings: string[]
  data?: Record<string, unknown>
}

export const AGENT_CONTRACTS: Record<string, OutputContract> = {
  'developer': {
    agent: 'developer',
    required_fields: ['files_changed', 'tests_added', 'summary'],
    optional_fields: [],
    schema: {
      files_changed: { type: 'string[]', description: 'List of file paths created or modified', validation: 'file-paths' },
      tests_added: { type: 'string[]', description: 'List of test file paths added or modified', validation: 'file-paths' },
      summary: { type: 'string', description: 'Brief description of what was implemented', validation: 'non-empty' },
    },
  },
  'ui-ux-expert': {
    agent: 'ui-ux-expert',
    required_fields: ['files_changed', 'components_created', 'a11y_verified', 'summary'],
    optional_fields: [],
    schema: {
      files_changed: { type: 'string[]', description: 'List of file paths created or modified', validation: 'file-paths' },
      components_created: { type: 'string[]', description: 'List of new component file paths', validation: 'file-paths' },
      a11y_verified: { type: 'boolean', description: 'Whether accessibility was verified' },
      summary: { type: 'string', description: 'Brief description of UI/UX changes', validation: 'non-empty' },
    },
  },
  'testing-expert': {
    agent: 'testing-expert',
    required_fields: ['test_files', 'coverage_summary', 'summary'],
    optional_fields: [],
    schema: {
      test_files: { type: 'string[]', description: 'List of test file paths created or modified', validation: 'file-paths' },
      coverage_summary: { type: 'string', description: 'Summary of test coverage achieved', validation: 'non-empty' },
      summary: { type: 'string', description: 'Brief description of testing work done', validation: 'non-empty' },
    },
  },
  'security-expert': {
    agent: 'security-expert',
    required_fields: ['findings', 'severity', 'files_reviewed', 'summary'],
    optional_fields: [],
    schema: {
      findings: { type: 'string[]', description: 'List of security findings or issues found' },
      severity: { type: 'string', description: 'Overall severity level (critical|high|medium|low|none)', validation: 'non-empty' },
      files_reviewed: { type: 'string[]', description: 'List of file paths reviewed', validation: 'file-paths' },
      summary: { type: 'string', description: 'Summary of security review', validation: 'non-empty' },
    },
  },
  'architect': {
    agent: 'architect',
    required_fields: ['decision', 'alternatives_considered', 'risks', 'summary'],
    optional_fields: [],
    schema: {
      decision: { type: 'string', description: 'The architectural decision made', validation: 'non-empty' },
      alternatives_considered: { type: 'string', description: 'Alternatives that were evaluated', validation: 'non-empty' },
      risks: { type: 'string', description: 'Known risks of the decision', validation: 'non-empty' },
      summary: { type: 'string', description: 'Brief summary of the architectural decision', validation: 'non-empty' },
    },
  },
  'researcher': {
    agent: 'researcher',
    required_fields: ['findings', 'sources', 'confidence', 'summary'],
    optional_fields: [],
    schema: {
      findings: { type: 'string', description: 'Research findings and conclusions', validation: 'non-empty' },
      sources: { type: 'string[]', description: 'List of sources referenced' },
      confidence: { type: 'string', description: 'Confidence level (high|medium|low) with rationale', validation: 'non-empty' },
      summary: { type: 'string', description: 'Brief summary of research', validation: 'non-empty' },
    },
  },
  'reviewer': {
    agent: 'reviewer',
    required_fields: ['verdict', 'issues', 'summary'],
    optional_fields: [],
    schema: {
      verdict: { type: 'string', description: 'Review verdict (pass|block|conditional)', validation: 'non-empty' },
      issues: { type: 'string[]', description: 'List of issues found during review' },
      summary: { type: 'string', description: 'Brief review summary', validation: 'non-empty' },
    },
  },
  'writer': {
    agent: 'writer',
    required_fields: ['files_changed', 'summary'],
    // Specialty fields: copy work reports counts, metadata work reports tags.
    optional_fields: ['content', 'word_count', 'tags_added'],
    schema: {
      files_changed: { type: 'string[]', description: 'Files created or modified', validation: 'file-paths' },
      summary: { type: 'string', description: 'What was written and why', validation: 'non-empty' },
      content: { type: 'string', description: 'The written content or key excerpts' },
      word_count: { type: 'number', description: 'Word count of written content', validation: 'positive-int' },
      tags_added: { type: 'string[]', description: 'Meta tags or structured-data items added' },
    },
  },
  'performance-expert': {
    agent: 'performance-expert',
    required_fields: ['metrics_before', 'metrics_after', 'files_changed', 'summary'],
    optional_fields: [],
    schema: {
      metrics_before: { type: 'object', description: 'Performance metrics before changes' },
      metrics_after: { type: 'object', description: 'Performance metrics after changes' },
      files_changed: { type: 'string[]', description: 'List of file paths created or modified', validation: 'file-paths' },
      summary: { type: 'string', description: 'Summary of performance improvements', validation: 'non-empty' },
    },
  },
  'data-engineer': {
    agent: 'data-engineer',
    required_fields: ['files_changed', 'summary'],
    // Schema work reports migrations and a rollback; pipeline work reports stages.
    optional_fields: ['migrations', 'rls_policies', 'rollback_plan', 'pipeline_steps'],
    schema: {
      files_changed: { type: 'string[]', description: 'Files created or modified', validation: 'file-paths' },
      summary: { type: 'string', description: 'Summary of the data changes', validation: 'non-empty' },
      migrations: { type: 'string[]', description: 'Migration file paths applied', validation: 'file-paths' },
      rls_policies: { type: 'string[]', description: 'Access policies added or modified' },
      rollback_plan: { type: 'string', description: 'Steps to roll the change back' },
      pipeline_steps: { type: 'string[]', description: 'Pipeline stages implemented' },
    },
  },
  'devops-expert': {
    agent: 'devops-expert',
    required_fields: ['files_changed', 'env_vars_added', 'summary'],
    // Release work additionally reports the version and its changelog.
    optional_fields: ['version', 'changelog_entries', 'checks_passed'],
    schema: {
      files_changed: { type: 'string[]', description: 'List of file paths created or modified', validation: 'file-paths' },
      env_vars_added: { type: 'string[]', description: 'List of environment variable names added' },
      summary: { type: 'string', description: 'Summary of DevOps changes', validation: 'non-empty' },
      version: { type: 'string', description: 'Version being released' },
      changelog_entries: { type: 'string[]', description: 'Changelog entries for this release' },
      checks_passed: { type: 'boolean', description: 'Whether every release check passed' },
    },
  },
}

function applyValidation(
  field: string,
  value: unknown,
  spec: FieldSpec,
  missing: string[],
): void {
  if (spec.validation === 'non-empty') {
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(field)
    }
  } else if (spec.validation === 'file-paths') {
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
      missing.push(field)
    }
  } else if (spec.validation === 'positive-int') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      missing.push(field)
    }
  }
}

export function validateOutput(agent: string, output: string): ContractResult {
  const contract = AGENT_CONTRACTS[agent.toLowerCase()]
  if (!contract) {
    return { valid: true, missing: [], warnings: ['no_contract_defined'] }
  }

  const blockMatch = output.match(/<!--\s*OUTPUT_CONTRACT\s*([\s\S]*?)-->/)
  if (!blockMatch) {
    return { valid: false, missing: ['__contract_block'], warnings: [] }
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(blockMatch[1].trim()) as Record<string, unknown>
  } catch {
    return { valid: false, missing: ['__contract_block'], warnings: ['invalid_json'] }
  }

  const missing: string[] = []

  for (const field of contract.required_fields) {
    if (!(field in data) || data[field] === null || data[field] === undefined) {
      missing.push(field)
      continue
    }
    const fieldSpec = contract.schema[field]
    if (fieldSpec?.validation) {
      applyValidation(field, data[field], fieldSpec, missing)
    }
  }

  // Optional fields are not required, but a declared validation still applies to
  // whatever was supplied. Merged agents report specialty fields this way — a
  // documentation change has no word count, but a supplied one of -5 is wrong.
  for (const field of contract.optional_fields) {
    if (!(field in data) || data[field] === null || data[field] === undefined) continue
    const fieldSpec = contract.schema[field]
    if (fieldSpec?.validation) {
      applyValidation(field, data[field], fieldSpec, missing)
    }
  }

  return { valid: missing.length === 0, missing, warnings: [], data }
}

export function buildContractInstruction(agent: string): string | null {
  const contract = AGENT_CONTRACTS[agent.toLowerCase()]
  if (!contract) return null

  const exampleFields = contract.required_fields
    .map(f => {
      const spec = contract.schema[f]
      if (!spec) return `"${f}": "..."`
      if (spec.type === 'string[]') return `"${f}": [...]`
      if (spec.type === 'boolean') return `"${f}": true`
      if (spec.type === 'number') return `"${f}": 0`
      if (spec.type === 'object') return `"${f}": {}`
      return `"${f}": "..."`
    })
    .join(', ')

  return [
    '## Output Contract (REQUIRED)',
    'At the END of your response, include an OUTPUT_CONTRACT block:',
    `<!-- OUTPUT_CONTRACT`,
    `{ ${exampleFields} }`,
    `-->`,
    `The following fields are REQUIRED: ${contract.required_fields.join(', ')}`,
  ].join('\n')
}

export function buildContractRetryPrompt(result: ContractResult): string {
  return [
    'Your previous output was missing the required OUTPUT_CONTRACT block.',
    'At the END of your response, include:',
    '<!-- OUTPUT_CONTRACT',
    '{ ... }',
    '-->',
    `Missing fields: ${result.missing.join(', ')}`,
  ].join('\n')
}
