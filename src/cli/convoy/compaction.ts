import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CompactionConfig } from './types.js'

// --- Types ---

export interface CompactionSummary {
  task_id: string
  convoy_id: string
  phase: string
  completed_steps: string[]
  pending_steps: string[]
  key_decisions: string[]
  files_modified: string[]
  artifact_refs: string[]
  timestamp: string
}

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'gemini-3.1-pro': 2_000_000,
  'gpt-5.3-codex': 200_000,
  'gpt-5-mini': 128_000,
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const MAX_COMPACTIONS_PER_TASK = 3

// --- Threshold detection ---

export function shouldCompact(
  tokensUsed: number,
  model: string,
  config: CompactionConfig,
): boolean {
  if (!config.enabled) return false
  const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW
  return tokensUsed / contextWindow >= config.token_threshold_pct / 100
}

// --- Compaction prompt ---

export function generateCompactionPrompt(taskId: string): string {
  return [
    '## Context Compaction Required',
    'You are approaching your context limit. Before continuing, produce a COMPACTION_SUMMARY:',
    '',
    '<!-- COMPACTION_SUMMARY',
    '{',
    '  "phase": "current work phase",',
    '  "completed_steps": ["step 1 done", "step 2 done"],',
    '  "pending_steps": ["step 3 todo", "step 4 todo"],',
    '  "key_decisions": ["chose approach A because..."],',
    '  "files_modified": ["src/foo.ts", "src/bar.ts"],',
    '  "artifact_refs": [".opencastle/artifacts/.../report.md"]',
    '}',
    '-->',
    '',
    'Be concise. Focus on WHAT was decided and WHAT remains, not HOW you got here.',
  ].join('\n')
}

// --- Parse compaction summary from agent output ---

export function parseCompactionSummary(
  output: string,
  taskId: string,
  convoyId: string,
): CompactionSummary | null {
  const match = output.match(/<!--\s*COMPACTION_SUMMARY\s*\n([\s\S]*?)-->/)
  if (!match) return null

  try {
    const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>
    return {
      task_id: taskId,
      convoy_id: convoyId,
      phase: typeof parsed.phase === 'string' ? parsed.phase : 'unknown',
      completed_steps: Array.isArray(parsed.completed_steps) ? parsed.completed_steps.filter((s): s is string => typeof s === 'string') : [],
      pending_steps: Array.isArray(parsed.pending_steps) ? parsed.pending_steps.filter((s): s is string => typeof s === 'string') : [],
      key_decisions: Array.isArray(parsed.key_decisions) ? parsed.key_decisions.filter((s): s is string => typeof s === 'string') : [],
      files_modified: Array.isArray(parsed.files_modified) ? parsed.files_modified.filter((s): s is string => typeof s === 'string') : [],
      artifact_refs: Array.isArray(parsed.artifact_refs) ? parsed.artifact_refs.filter((s): s is string => typeof s === 'string') : [],
      timestamp: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// --- Save / restore ---

export function getCompactionDir(convoyId: string, taskId: string, basePath?: string): string {
  return join(resolve(basePath ?? process.cwd()), '.opencastle', 'artifacts', convoyId, taskId)
}

export function saveCompaction(
  convoyId: string,
  taskId: string,
  summary: CompactionSummary,
  compactionCount: number,
  basePath?: string,
): string {
  const dir = getCompactionDir(convoyId, taskId, basePath)
  mkdirSync(dir, { recursive: true })
  const filename = `compaction-${compactionCount}.json`
  const filePath = join(dir, filename)
  writeFileSync(filePath, JSON.stringify(summary, null, 2))
  return filePath
}

export function loadCompaction(summaryPath: string): CompactionSummary | null {
  try {
    const content = readFileSync(summaryPath, 'utf8')
    return JSON.parse(content) as CompactionSummary
  } catch {
    return null
  }
}

// --- Build continuation prompt ---

export function buildContinuationPrompt(
  originalPrompt: string,
  summaryPath: string,
  isolationPreamble: string,
): string {
  const summary = loadCompaction(summaryPath)
  if (!summary) {
    return isolationPreamble + '\n\n' + originalPrompt
  }

  const summaryBlock = [
    '## Continuation from Compacted Context',
    'You are CONTINUING a task that was compacted. Previous progress:',
    '',
    '**Phase:** ' + summary.phase,
    '**Completed steps:**',
    ...summary.completed_steps.map(s => '- ' + s),
    '**Pending steps:**',
    ...summary.pending_steps.map(s => '- ' + s),
    '**Key decisions:**',
    ...summary.key_decisions.map(s => '- ' + s),
    '**Files already modified:**',
    ...summary.files_modified.map(f => '- ' + f),
    ...(summary.artifact_refs.length > 0
      ? ['**Artifacts:**', ...summary.artifact_refs.map(a => '- ' + a)]
      : []),
    '',
    'Focus on the PENDING steps. Do NOT redo completed steps.',
  ].join('\n')

  return isolationPreamble + '\n\n' + summaryBlock + '\n\n' + originalPrompt
}

// --- Compaction count helpers ---

export function canCompact(compactionCount: number): boolean {
  return compactionCount < MAX_COMPACTIONS_PER_TASK
}

export function getMaxCompactions(): number {
  return MAX_COMPACTIONS_PER_TASK
}
