import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldCompact,
  generateCompactionPrompt,
  parseCompactionSummary,
  saveCompaction,
  loadCompaction,
  buildContinuationPrompt,
  canCompact,
  getMaxCompactions,
  getCompactionDir,
  MODEL_CONTEXT_WINDOWS,
  type CompactionSummary,
} from './compaction.js'
import type { CompactionConfig } from './types.js'

const baseConfig: CompactionConfig = {
  enabled: true,
  token_threshold_pct: 70,
  summary_max_tokens: 4096,
}

describe('shouldCompact', () => {
  it('returns false when config.enabled is false', () => {
    expect(shouldCompact(150_000, 'claude-sonnet-4-6', { ...baseConfig, enabled: false })).toBe(false)
  })

  it('returns false below threshold', () => {
    // 69% of 200_000 = 138_000
    expect(shouldCompact(138_000, 'claude-sonnet-4-6', baseConfig)).toBe(false)
  })

  it('returns true at exactly the threshold', () => {
    // 70% of 200_000 = 140_000
    expect(shouldCompact(140_000, 'claude-sonnet-4-6', baseConfig)).toBe(true)
  })

  it('returns true above threshold', () => {
    expect(shouldCompact(180_000, 'claude-sonnet-4-6', baseConfig)).toBe(true)
  })

  it('uses DEFAULT_CONTEXT_WINDOW (128_000) for unknown model', () => {
    // 70% of 128_000 = 89_600
    expect(shouldCompact(90_000, 'unknown-model-xyz', baseConfig)).toBe(true)
    expect(shouldCompact(88_000, 'unknown-model-xyz', baseConfig)).toBe(false)
  })

  it('uses correct window for gpt-5-mini (128_000)', () => {
    expect(MODEL_CONTEXT_WINDOWS['gpt-5-mini']).toBe(128_000)
    expect(shouldCompact(90_000, 'gpt-5-mini', baseConfig)).toBe(true)
  })
})

describe('generateCompactionPrompt', () => {
  it('returns a string containing COMPACTION_SUMMARY marker', () => {
    const prompt = generateCompactionPrompt('task-42')
    expect(prompt).toContain('COMPACTION_SUMMARY')
    expect(prompt).toContain('Context Compaction Required')
    expect(typeof prompt).toBe('string')
  })

  it('includes JSON structure placeholders', () => {
    const prompt = generateCompactionPrompt('task-1')
    expect(prompt).toContain('"phase"')
    expect(prompt).toContain('"completed_steps"')
    expect(prompt).toContain('"pending_steps"')
  })
})

describe('parseCompactionSummary', () => {
  it('parses valid summary from agent output', () => {
    const output = [
      'Some output text',
      '',
      '<!-- COMPACTION_SUMMARY',
      '{',
      '  "phase": "implementation",',
      '  "completed_steps": ["created types", "wrote tests"],',
      '  "pending_steps": ["integrate with engine"],',
      '  "key_decisions": ["used valibot for validation"],',
      '  "files_modified": ["src/foo.ts"],',
      '  "artifact_refs": [".opencastle/artifacts/convoy-1/task-1/report.md"]',
      '}',
      '-->',
      '',
      'More text',
    ].join('\n')
    const result = parseCompactionSummary(output, 'task-1', 'convoy-1')
    expect(result).not.toBeNull()
    expect(result!.task_id).toBe('task-1')
    expect(result!.convoy_id).toBe('convoy-1')
    expect(result!.phase).toBe('implementation')
    expect(result!.completed_steps).toEqual(['created types', 'wrote tests'])
    expect(result!.pending_steps).toEqual(['integrate with engine'])
    expect(result!.key_decisions).toEqual(['used valibot for validation'])
    expect(result!.files_modified).toEqual(['src/foo.ts'])
    expect(result!.artifact_refs).toEqual(['.opencastle/artifacts/convoy-1/task-1/report.md'])
    expect(typeof result!.timestamp).toBe('string')
  })

  it('returns null when no COMPACTION_SUMMARY marker found', () => {
    const result = parseCompactionSummary('just some output without the marker', 'task-1', 'convoy-1')
    expect(result).toBeNull()
  })

  it('returns null for invalid JSON inside the marker', () => {
    const output = '<!-- COMPACTION_SUMMARY\nnot valid json\n-->'
    const result = parseCompactionSummary(output, 'task-1', 'convoy-1')
    expect(result).toBeNull()
  })

  it('uses empty arrays for missing or non-array fields', () => {
    const output = '<!-- COMPACTION_SUMMARY\n{"phase": "testing"}\n-->'
    const result = parseCompactionSummary(output, 'task-1', 'convoy-1')
    expect(result).not.toBeNull()
    expect(result!.completed_steps).toEqual([])
    expect(result!.pending_steps).toEqual([])
    expect(result!.files_modified).toEqual([])
  })
})

describe('saveCompaction / loadCompaction', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('saves and restores a compaction summary', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'compaction-test-'))
    const summary: CompactionSummary = {
      task_id: 'task-1',
      convoy_id: 'convoy-abc',
      phase: 'testing',
      completed_steps: ['step A'],
      pending_steps: ['step B'],
      key_decisions: ['chose approach X'],
      files_modified: ['src/foo.ts'],
      artifact_refs: [],
      timestamp: new Date().toISOString(),
    }

    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const savedPath = saveCompaction('convoy-abc', 'task-1', summary, 1)
      expect(existsSync(savedPath)).toBe(true)
      const loaded = loadCompaction(savedPath)
      expect(loaded).not.toBeNull()
      expect(loaded!.task_id).toBe('task-1')
      expect(loaded!.phase).toBe('testing')
      expect(loaded!.completed_steps).toEqual(['step A'])
    } finally {
      process.chdir(origCwd)
    }
  })

  it('returns null for a non-existent path', () => {
    const result = loadCompaction('/tmp/definitely-does-not-exist-abc123.json')
    expect(result).toBeNull()
  })
})

describe('buildContinuationPrompt', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('includes original prompt, summary, and isolation preamble', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'compaction-test-'))
    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const summary: CompactionSummary = {
        task_id: 'task-1',
        convoy_id: 'convoy-abc',
        phase: 'integration',
        completed_steps: ['wrote types'],
        pending_steps: ['update engine'],
        key_decisions: ['decided to reuse store'],
        files_modified: ['src/types.ts'],
        artifact_refs: [],
        timestamp: new Date().toISOString(),
      }
      const savedPath = saveCompaction('convoy-abc', 'task-1', summary, 1)
      const result = buildContinuationPrompt('Do the remaining work', savedPath, '## Isolation preamble\n')
      expect(result).toContain('## Isolation preamble')
      expect(result).toContain('Do the remaining work')
      expect(result).toContain('Continuation from Compacted Context')
      expect(result).toContain('wrote types')
      expect(result).toContain('update engine')
    } finally {
      process.chdir(origCwd)
    }
  })

  it('handles missing summary file gracefully', () => {
    const result = buildContinuationPrompt(
      'Do the work',
      '/tmp/missing-summary-def456.json',
      '## Preamble\n',
    )
    expect(result).toContain('Do the work')
    expect(result).toContain('## Preamble')
    expect(result).not.toContain('Continuation from Compacted Context')
  })
})

describe('canCompact', () => {
  it('returns true below max (3)', () => {
    expect(canCompact(0)).toBe(true)
    expect(canCompact(1)).toBe(true)
    expect(canCompact(2)).toBe(true)
  })

  it('returns false at max (3)', () => {
    expect(canCompact(3)).toBe(false)
    expect(canCompact(4)).toBe(false)
  })
})

describe('getMaxCompactions', () => {
  it('returns 3', () => {
    expect(getMaxCompactions()).toBe(3)
  })
})

describe('getCompactionDir', () => {
  it('returns path inside .opencastle/artifacts/{convoyId}/{taskId}', () => {
    const result = getCompactionDir('convoy-abc', 'task-1')
    expect(result).toContain('.opencastle')
    expect(result).toContain('artifacts')
    expect(result).toContain('convoy-abc')
    expect(result).toContain('task-1')
  })
})
