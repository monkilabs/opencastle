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

/** One line of the run summary every task sees. */
export interface PlanEntry {
  id: string
  agent: string
  summary: string
  files: string[]
  depends_on: string[]
}

// ── Prompt layout ─────────────────────────────────────────────────────────────
//
// Every task's prompt is the shared context followed by the task's own part.
// The shared context is byte-identical for every task of a run, so a runtime
// with a prompt cache reads it once and serves it to the rest at a tenth of
// the price; anything that differs per task comes after it.
//
// The old preamble opened with the task's id, repeated the first 200
// characters of the prompt as an "Objective" (on a retry, the retry banner),
// stated the file rule a second time after the adapter had, and sent every
// runtime to `.github/instructions/`, a path only Copilot uses.

const SUMMARY_MAX = 100

/** A one-line summary of a task for the run summary. */
export function summarizeTask(task: { id: string; description?: string; prompt: string }): string {
  const source = task.description && task.description !== task.id ? task.description : task.prompt
  const line = source.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > SUMMARY_MAX ? line.slice(0, SUMMARY_MAX - 1) + '…' : line
}

/** The part of the prompt every task in a run shares, word for word. */
export function buildSharedContext(opts: {
  convoyName: string
  plan: PlanEntry[]
  artifactsDir: string
}): string {
  const plan = opts.plan.map((t) => {
    const after = t.depends_on.length > 0 ? ` (after ${t.depends_on.join(', ')})` : ''
    const files = t.files.length > 0 ? ` — files: ${t.files.join(', ')}` : ''
    return `- ${t.id} [${t.agent}]${after}: ${t.summary}${files}`
  })
  return [
    `# Convoy: ${opts.convoyName}`,
    '',
    'You are one of several agents working on this project at the same time. Each works on one task, in its own git worktree; the convoy merges each finished task into the convoy branch.',
    '',
    '## The plan',
    ...plan,
    '',
    '## Rules',
    '- Do your task and nothing else. Change only the files your task lists; if it needs a change elsewhere, say so in your answer instead of making it.',
    '- Leave committing to the convoy. It commits your work when you finish.',
    "- Follow the project's own conventions and instruction files, with one exception: do not edit anything under `.opencastle/` (KNOWN-ISSUES.md, LESSONS-LEARNED.md, logs) even where those instructions ask you to. Several agents run at once, and each such edit is a change outside your task that review sends back. Put an issue or a lesson you found in your answer instead.",
    `- For long output (a report, a data dump), write it to a file under ${opts.artifactsDir}<your task id>/ and mention it in your answer as \`[ARTIFACT: <file name>] <one-line summary>\`.`,
  ].join('\n')
}

/** The part of the prompt that is this task's alone. */
export function buildTaskSection(opts: {
  id: string
  agent: string
  files: string[]
  prompt: string
  dependencyResults?: DependencyResult[]
  previousWork?: string[]
  retryNote?: string | null
  contract?: string | null
}): string {
  // The role and the file list are stated here and nowhere else: the adapters
  // no longer add "You are a <agent>" or "Only modify files under".
  const parts: string[] = [
    `## Your task: ${opts.id}`,
    `You are the ${opts.agent} agent for this task.`,
    opts.files.length > 0 ? `Files you may change: ${opts.files.join(', ')}` : 'Files: not limited to a list',
  ]
  if (opts.dependencyResults && opts.dependencyResults.length > 0) {
    parts.push('', '### What the tasks before you produced', formatDependencyResults(opts.dependencyResults))
  }
  if (opts.previousWork && opts.previousWork.length > 0) {
    parts.push('', `### Earlier work by ${opts.agent}`, opts.previousWork.join('\n\n'))
  }
  parts.push('', '### Instructions', opts.prompt.trim())
  if (opts.retryNote) {
    parts.push('', '### Your previous attempt', opts.retryNote.trim())
  }
  if (opts.contract) {
    parts.push('', opts.contract)
  }
  return parts.join('\n')
}

/** Shared context first, the task's part last. */
export function composePrompt(shared: string, taskSection: string): string {
  return `${shared}\n\n---\n\n${taskSection}\n`
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatDependencyResults(deps: DependencyResult[]): string {
  return deps
    .map(dep => {
      let text = '#### ' + dep.taskId + ' (' + dep.agent + ') — ' + dep.status + '\n'
        + (dep.summary ?? 'No summary available.') + '\n'
        + 'Files changed: ' + (dep.filesChanged.length > 0 ? dep.filesChanged.join(', ') : 'none')

      if (dep.artifactRefs && dep.artifactRefs.length > 0) {
        text += '\nArtifacts available:\n'
          + dep.artifactRefs.map(r => '- ' + r.path + ' — "' + r.summary + '"').join('\n')
          + '\n\nTo read an artifact, open the file at the path above.'
      }

      return text
    })
    .join('\n\n')
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
  basePath?: string,
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
        const refs = listArtifacts(convoyId, depId, basePath)
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
