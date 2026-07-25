import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { TaskSpec, AgentAdapter } from './spec-types.js'
import { parseTaskSpecText } from '../run/schema.js'
import { createConvoyStore } from './store.js'
import {
  createConvoyEngine,
  type ConvoyEngine,
  type ConvoyResult,
  type ConvoyEngineOptions,
} from './engine.js'
import type { PipelineStatus } from './types.js'
import { formatDuration } from '../run/executor.js'

const execFile = promisify(execFileCb)

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface PipelineResult {
  pipelineId: string
  status: PipelineStatus
  convoyResults: ConvoyResult[]
  summary: {
    totalConvoys: number
    completed: number
    failed: number
    skipped: number
  }
  duration: string
  cost?: { total_tokens: number; total_cost_usd?: number }
}

export interface PipelineOrchestrator {
  run(): Promise<PipelineResult>
  resume(pipelineId: string): Promise<PipelineResult>
}

export interface PipelineOrchestratorOptions {
  spec: TaskSpec
  specYaml: string
  adapter: AgentAdapter
  basePath?: string
  dbPath?: string
  logsDir?: string
  verbose?: boolean
  /** Injectable engine factory (used in tests). */
  _createConvoyEngine?: (opts: ConvoyEngineOptions) => ConvoyEngine
  /** Injectable branch handler (used in tests). */
  _ensureBranch?: (branchName: string, basePath: string) => Promise<void>
  /** Pass `null` to skip pipeline-level worktree creation (test mode).
   *  Also skipped when `_ensureBranch` is provided (backward-compat for tests). */
  _convoyWorktreeDir?: string | null
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function aggregateTokens(results: ConvoyResult[]): number | undefined {
  let total: number | undefined
  for (const r of results) {
    if (r.cost?.total_tokens != null) {
      total = (total ?? 0) + r.cost.total_tokens
    }
  }
  return total
}

function buildSummary(results: ConvoyResult[], skippedCount: number) {
  const completed = results.filter(r => r.status === 'done').length
  const failed = results.filter(
    r => r.status === 'failed' || r.status === 'gate-failed',
  ).length
  return {
    totalConvoys: results.length + skippedCount,
    completed,
    failed,
    skipped: skippedCount,
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createPipelineOrchestrator(
  options: PipelineOrchestratorOptions,
): PipelineOrchestrator {
  const { spec, specYaml, adapter, verbose = false } = options
  const basePath = resolve(options.basePath ?? process.cwd())
  const dbPath = options.dbPath ?? resolve(basePath, '.opencastle', 'convoy.db')
  const engineFactory = options._createConvoyEngine ?? createConvoyEngine

  async function getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: basePath,
      })
      return stdout.trim()
    } catch {
      return 'main'
    }
  }

  /** Validate and resolve a convoy spec path, preventing path traversal. */
  function resolveSpecPath(specPath: string): string {
    if (isAbsolute(specPath)) {
      throw new Error(`Convoy spec path must be relative: "${specPath}"`)
    }
    const absPath = resolve(basePath, specPath)
    const rel = relative(basePath, absPath)
    if (rel.startsWith('..') || rel.startsWith('..' + sep)) {
      throw new Error(`Convoy spec path escapes project directory: "${specPath}"`)
    }
    return absPath
  }

  /** Run a single convoy spec file as part of a pipeline, linking it with pipelineId. */
  async function runConvoySpecFile(
    specPath: string,
    pipelineId: string,
    branch: string,
    effectiveBase: string = basePath,
  ): Promise<ConvoyResult> {
    const absPath = resolveSpecPath(specPath)
    const convoyYaml = await readFile(absPath, 'utf8')
    const convoySpec = parseTaskSpecText(convoyYaml)
    const overriddenSpec: TaskSpec = { ...convoySpec, branch }

    const engineOpts: ConvoyEngineOptions = {
      spec: overriddenSpec,
      specYaml: convoyYaml,
      adapter,
      basePath: effectiveBase,
      dbPath,
      logsDir: options.logsDir,
      verbose,
      pipelineId,
      _convoyWorktreeDir: null,
    }
    const engine = engineFactory(engineOpts)
    return engine.run()
  }

  async function run(): Promise<PipelineResult> {
    const startTime = Date.now()
    const pipelineId = `pipeline-${startTime}`
    const branch = spec.branch ?? (await getCurrentBranch())
    const convoySpecs = spec.depends_on_convoy ?? []

    // Create pipeline-level worktree for branch isolation.
    // Skipped when _convoyWorktreeDir is null or _ensureBranch is injected (test mode).
    let effectiveBasePath = basePath
    let convoyWorktreeDir: string | undefined
    if (spec.branch !== undefined) {
      const skipWorktree = options._convoyWorktreeDir === null || options._ensureBranch !== undefined
      if (!skipWorktree) {
        if (typeof options._convoyWorktreeDir === 'string') {
          effectiveBasePath = options._convoyWorktreeDir
          convoyWorktreeDir = options._convoyWorktreeDir
        } else {
          const worktreeId = `convoy-root-${Date.now()}`
          convoyWorktreeDir = join(basePath, '.opencastle', 'worktrees', worktreeId)
          mkdirSync(dirname(convoyWorktreeDir), { recursive: true })
          let branchExists = false
          try {
            await execFile('git', ['rev-parse', '--verify', spec.branch], { cwd: basePath })
            branchExists = true
          } catch { /* branch doesn't exist */ }
          if (branchExists) {
            await execFile('git', ['worktree', 'add', convoyWorktreeDir, spec.branch], { cwd: basePath })
          } else {
            await execFile('git', ['worktree', 'add', '-b', spec.branch, convoyWorktreeDir], { cwd: basePath })
          }
          effectiveBasePath = convoyWorktreeDir
        }
      }
    }

    mkdirSync(dirname(dbPath), { recursive: true })
    const store = createConvoyStore(dbPath)
    try {
      store.insertPipeline({
        id: pipelineId,
        name: spec.name,
        status: 'pending',
        branch,
        spec_yaml: specYaml,
        convoy_specs: JSON.stringify(convoySpecs),
        created_at: new Date().toISOString(),
      })
      store.updatePipelineStatus(pipelineId, 'running', {
        started_at: new Date().toISOString(),
      })
    } finally {
      store.close()
    }

    const convoyResults: ConvoyResult[] = []
    let skippedCount = 0
    let pipelineHalted = false

    try {
      for (const specPath of convoySpecs) {
        if (pipelineHalted) {
          skippedCount++
          continue
        }

        let convoyResult: ConvoyResult
        try {
          convoyResult = await runConvoySpecFile(specPath, pipelineId, branch, effectiveBasePath)
        } catch (err) {
          process.stderr.write(
            `  ✗ Convoy spec "${specPath}" failed to load: ${(err as Error).message}\n`,
          )
          // Treat spec load failure as a convoy failure
          convoyResult = {
            convoyId: `failed-${specPath}`,
            status: 'failed',
            summary: { total: 0, done: 0, failed: 1, skipped: 0, timedOut: 0 },
            duration: '0ms',
          }
        }
        convoyResults.push(convoyResult)

        const isFailed =
          convoyResult.status === 'failed' || convoyResult.status === 'gate-failed'
        if (isFailed && spec.on_failure === 'stop') {
          pipelineHalted = true
        }
      }

      // Hybrid pipeline: if the spec itself has tasks, run them as a final convoy
      if (!pipelineHalted && spec.tasks && spec.tasks.length > 0) {
        const hybridEngine = engineFactory({
          spec: { ...spec, branch },
          specYaml,
          adapter,
          basePath: effectiveBasePath,
          dbPath,
          logsDir: options.logsDir,
          verbose,
          pipelineId,
          _convoyWorktreeDir: null,
        })
        const hybridResult = await hybridEngine.run()
        convoyResults.push(hybridResult)
      }
    } catch (err) {
      // Unexpected error — finalize pipeline as failed
      const failStore = createConvoyStore(dbPath)
      try {
        failStore.updatePipelineStatus(pipelineId, 'failed', {
          finished_at: new Date().toISOString(),
        })
      } finally {
        failStore.close()
      }
      throw err
    } finally {
      if (convoyWorktreeDir) {
        try {
          await execFile('git', ['worktree', 'remove', convoyWorktreeDir, '--force'], { cwd: basePath })
        } catch { /* ignore cleanup errors */ }
      }
    }

    const totalTokens = aggregateTokens(convoyResults)
    const summary = buildSummary(convoyResults, skippedCount)
    const finalStatus: PipelineStatus = summary.failed > 0 ? 'failed' : 'done'
    const duration = formatDuration(Date.now() - startTime)

    const updateStore = createConvoyStore(dbPath)
    try {
      updateStore.updatePipelineStatus(pipelineId, finalStatus, {
        finished_at: new Date().toISOString(),
        total_tokens: totalTokens ?? null,
      })
    } finally {
      updateStore.close()
    }

    return {
      pipelineId,
      status: finalStatus,
      convoyResults,
      summary,
      duration,
      cost: totalTokens != null ? { total_tokens: totalTokens } : undefined,
    }
  }

  async function resume(pipelineId: string): Promise<PipelineResult> {
    const startTime = Date.now()

    const pipelineStore = createConvoyStore(dbPath)
    let pipeline
    try {
      pipeline = pipelineStore.getPipeline(pipelineId)
    } finally {
      pipelineStore.close()
    }

    if (!pipeline) {
      throw new Error(`Pipeline "${pipelineId}" not found in store`)
    }

    const convoySpecs: string[] = JSON.parse(pipeline.convoy_specs) as string[]
    const branch = pipeline.branch ?? spec.branch ?? (await getCurrentBranch())

    // Create pipeline-level worktree for branch isolation.
    // Skipped when _convoyWorktreeDir is null or _ensureBranch is injected (test mode).
    let effectiveBasePath = basePath
    let convoyWorktreeDir: string | undefined
    const pipelineBranch = pipeline.branch ?? spec.branch
    if (pipelineBranch !== undefined) {
      const skipWorktree = options._convoyWorktreeDir === null || options._ensureBranch !== undefined
      if (!skipWorktree) {
        if (typeof options._convoyWorktreeDir === 'string') {
          effectiveBasePath = options._convoyWorktreeDir
          convoyWorktreeDir = options._convoyWorktreeDir
        } else {
          const worktreeId = `convoy-root-${Date.now()}`
          convoyWorktreeDir = join(basePath, '.opencastle', 'worktrees', worktreeId)
          mkdirSync(dirname(convoyWorktreeDir), { recursive: true })
          let branchExists = false
          try {
            await execFile('git', ['rev-parse', '--verify', pipelineBranch], { cwd: basePath })
            branchExists = true
          } catch { /* branch doesn't exist */ }
          if (branchExists) {
            await execFile('git', ['worktree', 'add', convoyWorktreeDir, pipelineBranch], { cwd: basePath })
          } else {
            await execFile('git', ['worktree', 'add', '-b', pipelineBranch, convoyWorktreeDir], { cwd: basePath })
          }
          effectiveBasePath = convoyWorktreeDir
        }
      }
    }

    // Load all convoys linked to this pipeline, sorted by creation time
    const convoyStore = createConvoyStore(dbPath)
    let existingConvoys
    try {
      existingConvoys = convoyStore
        .getConvoysByPipeline(pipelineId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    } finally {
      convoyStore.close()
    }

    const convoyResults: ConvoyResult[] = []
    let skippedCount = 0
    let pipelineHalted = false
    let existingIdx = 0

    try {
      for (const [convoyIndex, specPath] of convoySpecs.entries()) {
        const existing = existingConvoys[existingIdx]

        if (existing && existing.status === 'done') {
          // Already completed — reconstruct synthetic result
          const taskStore = createConvoyStore(dbPath)
          let tasks
          try {
            tasks = taskStore.getTasksByConvoy(existing.id)
          } finally {
            taskStore.close()
          }
          convoyResults.push({
            convoyId: existing.id,
            status: existing.status,
            summary: {
              total: tasks.length,
              done: tasks.filter(t => t.status === 'done').length,
              failed: tasks.filter(t => t.status === 'failed').length,
              skipped: tasks.filter(t => t.status === 'skipped').length,
              timedOut: tasks.filter(t => t.status === 'timed-out').length,
            },
            duration: '0ms',
            cost:
              existing.total_tokens != null
                ? { total_tokens: existing.total_tokens }
                : undefined,
          })
          existingIdx++
          continue
        }

        if (pipelineHalted) {
          skippedCount++
          continue
        }

        let convoyResult: ConvoyResult

        if (existing && (existing.status === 'running' || existing.status === 'failed')) {
          // Resume the in-progress or failed convoy
          const absPath = resolveSpecPath(specPath)
          const convoyYaml = await readFile(absPath, 'utf8')
          const convoySpec = parseTaskSpecText(convoyYaml)
          const overriddenSpec: TaskSpec = { ...convoySpec, branch }

          const resumeEngine = engineFactory({
            spec: overriddenSpec,
            specYaml: convoyYaml,
            adapter,
            basePath: effectiveBasePath,
            dbPath,
            logsDir: options.logsDir,
            verbose,
            pipelineId,
            _convoyWorktreeDir: null,
          })

          if (existing.status === 'failed') {
            await resumeEngine.retryFailed(existing.id)
          }

          convoyResult = await resumeEngine.resume(existing.id)
          existingIdx++
        } else {
          // Run fresh
          try {
            convoyResult = await runConvoySpecFile(specPath, pipelineId, branch, effectiveBasePath)
          } catch (err) {
            process.stderr.write(
              `  ✗ Convoy spec "${specPath}" failed to load: ${(err as Error).message}\n`,
            )
            convoyResult = {
              convoyId: `failed-${specPath}`,
              status: 'failed',
              summary: { total: 0, done: 0, failed: 1, skipped: 0, timedOut: 0 },
              duration: '0ms',
            }
          }
        }

        convoyResults.push(convoyResult)

        const isFailed =
          convoyResult.status === 'failed' || convoyResult.status === 'gate-failed'
        if (isFailed && spec.on_failure === 'stop') {
          pipelineHalted = true
        }
      }
    } catch (err) {
      // Unexpected error — finalize pipeline as failed
      const failStore = createConvoyStore(dbPath)
      try {
        failStore.updatePipelineStatus(pipelineId, 'failed', {
          finished_at: new Date().toISOString(),
        })
      } finally {
        failStore.close()
      }
      throw err
    } finally {
      if (convoyWorktreeDir) {
        try {
          await execFile('git', ['worktree', 'remove', convoyWorktreeDir, '--force'], { cwd: basePath })
        } catch { /* ignore cleanup errors */ }
      }
    }

    const totalTokens = aggregateTokens(convoyResults)
    const summary = buildSummary(convoyResults, skippedCount)
    const finalStatus: PipelineStatus = summary.failed > 0 ? 'failed' : 'done'
    const duration = formatDuration(Date.now() - startTime)

    const updateStore = createConvoyStore(dbPath)
    try {
      updateStore.updatePipelineStatus(pipelineId, finalStatus, {
        finished_at: new Date().toISOString(),
        total_tokens: totalTokens ?? null,
      })
    } finally {
      updateStore.close()
    }

    return {
      pipelineId,
      status: finalStatus,
      convoyResults,
      summary,
      duration,
      cost: totalTokens != null ? { total_tokens: totalTokens } : undefined,
    }
  }

  return { run, resume }
}
