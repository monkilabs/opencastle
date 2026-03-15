import { normalizePath, pathsOverlap } from './partition.js'
import type { ConvoyStore } from './store.js'
import { listArtifacts, type ArtifactRef } from './artifacts.js'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface DependencyResult {
  taskId: string
  agent: string
  status: string
  summary: string | null
  filesChanged: string[]
  artifactRefs?: ArtifactRef[]  // filesystem artifact references
}

export interface PartitionViolation {
  taskId: string
  allowedFiles: string[]
  actualFiles: string[]
  violations: string[]
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatDependencyResults(deps: DependencyResult[]): string {
  return deps
    .map(dep => {
      let text = '#### ' + dep.taskId + ' (' + dep.agent + ') \u2014 ' + dep.status + '\n'
        + (dep.summary ?? 'No summary available.') + '\n'
        + 'Files changed: ' + (dep.filesChanged.length > 0 ? dep.filesChanged.join(', ') : 'none')

      if (dep.artifactRefs && dep.artifactRefs.length > 0) {
        text += '\nArtifacts available:\n'
          + dep.artifactRefs.map(r => '- ' + r.path + ' \u2014 "' + r.summary + '"').join('\n')
          + '\n\nTo read an artifact, open the file at the path above.'
      }

      return text
    })
    .join('\n\n')
}

export function buildIsolationPreamble(
  task: { id: string; description: string; prompt: string; files: string[]; agent: string },
  dependencyResults: DependencyResult[],
): string {
  const objective = task.description || task.prompt.slice(0, 200)
  const fileList = task.files.length > 0 ? task.files.map(f => '- ' + f).join('\n') : '- (none specified)'
  const depSection = dependencyResults.length > 0
    ? formatDependencyResults(dependencyResults)
    : 'No dependencies \u2014 you are in the first phase.'

  return [
    '## Context Isolation Notice',
    'You are a fresh agent with NO prior context. You have no knowledge of other tasks',
    'in this convoy. Your only context is what follows.',
    '',
    '### Your Task',
    '- **ID:** ' + task.id,
    '- **Agent:** ' + task.agent,
    '- **Objective:** ' + objective,
    '',
    '### Your File Partition',
    'You may ONLY read and modify files within this partition:',
    fileList,
    '',
    'Do NOT modify files outside this partition. If you discover a need to change files',
    'outside your partition, note it in your output but do not make the change.',
    '',
    '### Dependency Results',
    depSection,
    '',
    '### Project Conventions',
    'Read `.github/instructions/general.instructions.md` for coding standards.',
  ].join('\n')
}

// ── Partition violation detection ─────────────────────────────────────────────

export function detectPartitionViolations(
  taskId: string,
  allowedFiles: string[],
  actualFiles: string[],
): PartitionViolation | null {
  const violations: string[] = []

  for (const actual of actualFiles) {
    let isAllowed = false
    for (const allowed of allowedFiles) {
      try {
        const normalizedAllowed = normalizePath(allowed)
        const normalizedActual = normalizePath(actual)
        if (pathsOverlap(normalizedAllowed, normalizedActual)) {
          isAllowed = true
          break
        }
      } catch {
        // Fallback for unusual paths: exact match or directory prefix
        const allowedDir = allowed.endsWith('/') ? allowed : allowed + '/'
        if (actual === allowed || actual.startsWith(allowedDir)) {
          isAllowed = true
          break
        }
      }
    }
    if (!isAllowed) {
      violations.push(actual)
    }
  }

  if (violations.length === 0) return null

  return { taskId, allowedFiles, actualFiles, violations }
}

// ── Dependency result resolution ──────────────────────────────────────────────

export function resolveDependencyResults(
  store: ConvoyStore,
  convoyId: string,
  dependsOn: string[],
): DependencyResult[] {
  return dependsOn
    .map((depId) => {
      const record = store.getTask(depId, convoyId)
      if (!record) return null

      let summary: string | null = null
      let filesChanged: string[] = []

      if (record.contract_result) {
        try {
          const cr = JSON.parse(record.contract_result) as {
            valid: boolean
            missing: string[]
            warnings: string[]
            data?: Record<string, unknown>
          }
          if (cr.data) {
            summary = typeof cr.data['summary'] === 'string' ? cr.data['summary'] as string : null
            const files = cr.data['files_changed']
            if (Array.isArray(files)) {
              filesChanged = files.filter((f): f is string => typeof f === 'string')
            }
          }
        } catch { /* non-critical */ }
      }

      let artifactRefs: ArtifactRef[] | undefined
      try {
        const refs = listArtifacts(convoyId, depId)
        if (refs.length > 0) artifactRefs = refs
      } catch { /* non-critical */ }

      return {
        taskId: record.id,
        agent: record.agent,
        status: record.status,
        summary,
        filesChanged,
        artifactRefs,
      } as DependencyResult
    })
    .filter((r): r is DependencyResult => r !== null)
}
