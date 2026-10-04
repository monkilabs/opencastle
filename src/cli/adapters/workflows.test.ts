import { describe, it, expect } from 'vitest'
import { inlineSharedPhase, isWorkflowTemplate, pointAtWorkflows } from './workflows.js'

const TEMPLATE = [
  '# Workflow: Bug Fix',
  '',
  '### Phase 5: Delivery',
  '',
  '> **See [shared-delivery-phase.md](shared-delivery-phase.md) for the standard delivery steps.**',
  '>',
  '> Commit → Push → PR → tracker linkage. Team Lead owns delivery.',
  '',
  '## After',
  '',
].join('\n')

const SHARED = [
  '<!-- ⚠️ This file is managed by OpenCastle. -->',
  '',
  '# Shared Delivery Phase',
  '',
  'This phase is referenced by all workflow templates.',
  '',
  '## Steps',
  '',
  '1. **Do NOT merge**',
  '',
  '### Detail',
  '',
].join('\n')

describe('inlineSharedPhase', () => {
  it('puts the phase where the pointer was, nested under the delivery heading', () => {
    const out = inlineSharedPhase(TEMPLATE, SHARED)
    expect(out).toContain('### Phase 5: Delivery\n\n#### Steps\n\n1. **Do NOT merge**\n\n##### Detail\n')
    expect(out).not.toContain('shared-delivery-phase.md')
    expect(out).not.toContain('Shared Delivery Phase')
    expect(out).not.toContain('This file is managed')
    expect(out).toContain('\n## After\n')
  })

  it('leaves a template without the pointer as it is', () => {
    const own = '# Workflow: Ours\n\n## Phase 1: Do it\n'
    expect(inlineSharedPhase(own, SHARED)).toBe(own)
  })

  it('keeps the words and drops the link when a layer left the phase out', () => {
    const out = inlineSharedPhase(TEMPLATE, null)
    expect(out).not.toContain('](shared-delivery-phase.md)')
    expect(out).toContain('See the shared delivery phase for the standard delivery steps.')
  })
})

describe('isWorkflowTemplate', () => {
  it('is a template unless it is the README or the shared phase', () => {
    expect(isWorkflowTemplate('bug-fix.md')).toBe(true)
    expect(isWorkflowTemplate('README.md')).toBe(false)
    expect(isWorkflowTemplate('shared-delivery-phase.md')).toBe(false)
    expect(isWorkflowTemplate('notes.txt')).toBe(false)
  })
})

describe('pointAtWorkflows', () => {
  it("replaces Copilot's folder with this target's, and nothing else", () => {
    const text = 'Search `.github/agent-workflows/`. Keep `.github/workflows/ci.yml`.'
    expect(pointAtWorkflows(text, '.claude/commands/oc/workflow-*.md')).toBe(
      'Search `.claude/commands/oc/workflow-*.md`. Keep `.github/workflows/ci.yml`.',
    )
  })
})
