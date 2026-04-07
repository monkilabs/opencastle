import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { parseTaskSpecText, isConvoySpec, isPipelineSpec } from './run/schema.js'
import { createExecutor, buildPhases } from './run/executor.js'
import { getAdapter, detectAdapter } from './run/adapters/index.js'
import { createReporter, printExecutionPlan } from './run/reporter.js'
import { c, confirm, closePrompts } from './prompt.js'
import type { CliContext, RunOptions } from './types.js'
import type { ConvoyResult } from './convoy/engine.js'
import type { PipelineResult } from './convoy/pipeline.js'
import { EngineAlreadyRunningError } from './convoy/lock.js'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const HELP = `
  opencastle run [options]

  Process a task queue from a spec file, delegating to AI agents autonomously.
  Version 1 specs use the Convoy Engine; legacy specs use the standard executor.

  Options:
    --file, -f <path>        Task spec file
    --formula <path>         Use a formula template (alternative to --file)
    --set key=value          Set a formula variable (repeatable)
    --dry-run                Show execution plan without running
    --concurrency, -c <n>    Override max parallel tasks
    --adapter, -a <name>     Override agent runtime adapter
    --report-dir <path>      Where to write run reports (default: .opencastle/runs)
    --verbose                Show full agent output
    --resume                 Resume the last interrupted convoy from .opencastle/convoy.db
    --retry-failed [task-id] Retry failed/gate-failed/timed-out tasks from the last convoy
    --status                 Print the current convoy state from .opencastle/convoy.db
    --dlq-list               List dead letter queue entries
    --dlq-resolve <id>       Resolve a DLQ entry (requires --resolution)
    --dlq-retry <id>         Reset a DLQ task to pending for retry
    --convoy <id>            Filter by convoy ID (used with --dlq-list)
    --resolution <text>      Resolution text (used with --dlq-resolve)
    --watch              Keep running, re-triggering on file changes, cron, or git push
    --watch-config <p>   Path to watch configuration file (overrides spec watch config)
    --clear-scratchpad   Clear scratchpad data at watch start
    --help, -h               Show this help
`

/**
 * Parse CLI arguments for the run command.
 */
function parseArgs(args: string[]): RunOptions {
  const opts: RunOptions = {
    file: 'convoy.yml',
    dryRun: false,
    concurrency: null,
    adapter: null,
    reportDir: null,
    verbose: false,
    help: false,
    resume: false,
    status: false,
    retryFailed: false,
    retryFailedTaskIds: undefined,
    dlqList: false,
    dlqResolve: false,
    dlqResolveId: undefined,
    dlqResolveText: undefined,
    dlqRetry: false,
    dlqRetryId: undefined,
    dlqConvoyFilter: undefined,
    formula: null,
    setVars: {},
    watch: false,
    watchConfig: null,
    clearScratchpad: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--file':
      case '-f':
        if (i + 1 >= args.length) { console.error('  \u2717 --file requires a path'); process.exit(1) }
        opts.file = args[++i]
        break
      case '--dryRun':
      case '--dry-run':
        opts.dryRun = true
        break
      case '--concurrency':
      case '-c': {
        if (i + 1 >= args.length) { console.error('  \u2717 --concurrency requires a number'); process.exit(1) }
        const val = parseInt(args[++i], 10)
        if (!Number.isFinite(val) || val < 1) {
          console.error(`  ✗ --concurrency must be an integer >= 1`)
          process.exit(1)
        }
        opts.concurrency = val
        break
      }
      case '--adapter':
      case '-a':
        if (i + 1 >= args.length) { console.error('  \u2717 --adapter requires a name'); process.exit(1) }
        opts.adapter = args[++i]
        break
      case '--report-dir':
        if (i + 1 >= args.length) { console.error('  \u2717 --report-dir requires a path'); process.exit(1) }
        opts.reportDir = args[++i]
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--resume':
        opts.resume = true
        break
      case '--retry-failed':
        opts.retryFailed = true
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          opts.retryFailedTaskIds = [args[++i]]
        }
        break
      case '--status':
        opts.status = true
        break
      case '--dlq-list':
        opts.dlqList = true
        break
      case '--dlq-resolve':
        opts.dlqResolve = true
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) opts.dlqResolveId = args[++i]
        break
      case '--dlq-retry':
        opts.dlqRetry = true
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) opts.dlqRetryId = args[++i]
        break
      case '--resolution':
        if (i + 1 >= args.length) { console.error('  ✗ --resolution requires text'); process.exit(1) }
        opts.dlqResolveText = args[++i]
        break
      case '--convoy':
        if (i + 1 >= args.length) { console.error('  ✗ --convoy requires an ID'); process.exit(1) }
        opts.dlqConvoyFilter = args[++i]
        break
      case '--formula':
        if (i + 1 >= args.length) { console.error('  ✗ --formula requires a path'); process.exit(1) }
        opts.formula = args[++i]
        break
      case '--set': {
        if (i + 1 >= args.length) { console.error('  ✗ --set requires key=value'); process.exit(1) }
        const pair = args[++i]
        const eqIdx = pair.indexOf('=')
        if (eqIdx < 1) {
          console.error(`  ✗ --set value must be in key=value format, got: ${pair}`)
          process.exit(1)
        }
        opts.setVars[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        break
      }
      case '--watch':
        opts.watch = true
        break
      case '--watch-config':
        if (i + 1 >= args.length) { console.error('  ✗ --watch-config requires a path'); process.exit(1) }
        opts.watchConfig = args[++i]
        break
      case '--clear-scratchpad':
        opts.clearScratchpad = true
        break
      default:
        console.error(`  ✗ Unknown option: ${arg}`)
        console.log(HELP)
        process.exit(1)
    }
  }

  return opts
}

/**
 * Print a user-friendly adapter unavailable error.
 */
function printAdapterError(detectionFailed: boolean, adapterName: string): void {
  if (detectionFailed) {
    console.error(
      `  ✗ No agent CLI found on your PATH.\n` +
        `    Install one of the following adapters:\n` +
        `    • copilot    — https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli\n` +
        `    • claude     — npm install -g @anthropic-ai/claude-code\n` +
        `    • cursor     — https://cursor.com (Cursor > Install CLI)\n` +
        `    • opencode   — https://opencode.ai\n` +
        `    • codex      — npm install -g @openai/codex\n` +
        `\n` +
        `    Or specify an adapter explicitly: opencastle run --adapter <name>`
    )
  } else {
    const hints: Record<string, string> = {
      'claude':
        '    Install: npm install -g @anthropic-ai/claude-code\n' +
        '    Docs:    https://docs.anthropic.com/en/docs/claude-code',
      copilot:
        '    Requires the Copilot CLI installed and authenticated:\n' +
        '    https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli\n' +
        '    Docs:    https://docs.github.com/en/copilot',
      cursor:
        '    The Cursor agent CLI ships with the Cursor editor.\n' +
        '    Install Cursor from https://cursor.com and ensure the\n' +
        '    "agent" command is on your PATH (Cursor > Install CLI).',
      opencode:
        '    Install OpenCode from https://opencode.ai\n' +
        '    Ensure the "opencode" command is on your PATH.',
      codex:
        '    Install: npm install -g @openai/codex\n' +
        '    Docs:    https://developers.openai.com/codex',
    }
    const cliName = adapterName === 'cursor' ? 'agent' : adapterName
    const hint = hints[adapterName] ?? ''
    console.error(
      `  ✗ Adapter "${adapterName}" is not available.\n` +
        `    Make sure the "${cliName}" CLI is installed and on your PATH.\n` +
        hint
    )
  }
}

/**
 * Print a convoy result summary.
 */
function printConvoyResult(result: ConvoyResult): void {
  console.log(`\n  ──────────────────────────────────────`)
  console.log(`  Convoy ${result.status}: ${result.duration}`)
  console.log(
    `  Tasks: ${result.summary.done}/${result.summary.total} done` +
    (result.summary.failed > 0 ? ` | ${result.summary.failed} failed` : '') +
    (result.summary.skipped > 0 ? ` | ${result.summary.skipped} skipped` : '') +
    (result.summary.timedOut > 0 ? ` | ${result.summary.timedOut} timed out` : '')
  )
  if (result.gateResults) {
    const gatesPassed = result.gateResults.filter(g => g.passed).length
    const gatesFailed = result.gateResults.filter(g => !g.passed).length
    console.log(`  Gates: ${gatesPassed}/${result.gateResults.length} passed${gatesFailed > 0 ? ` | ${gatesFailed} failed` : ''}`)
    for (const g of result.gateResults) {
      console.log(`    ${g.passed ? '✓' : '✗'} ${g.command}`)
    }
  }
  if (result.cost) {
    const parts = [`Tokens: ${formatTokens(result.cost.total_tokens)}`]
    if (result.cost.total_cost_usd != null) {
      parts.push(`Cost: $${result.cost.total_cost_usd.toFixed(2)}`)
    }
    console.log(`  ${parts.join(' | ')}`)
  }
}

/**
 * Print a pipeline result summary.
 */
function printPipelineResult(result: PipelineResult): void {
  console.log(`\n  ──────────────────────────────────────`)
  console.log(`  Pipeline ${result.status}: ${result.duration}`)
  console.log(
    `  Convoys: ${result.summary.completed}/${result.summary.totalConvoys} completed` +
    (result.summary.failed > 0 ? ` | ${result.summary.failed} failed` : '') +
    (result.summary.skipped > 0 ? ` | ${result.summary.skipped} skipped` : '')
  )
  for (const cr of result.convoyResults) {
    const icon = cr.status === 'done' ? '✓' : cr.status === 'failed' ? '✗' : '⊘'
    console.log(`    ${icon} ${cr.convoyId}: ${cr.status} (${cr.duration})`)
  }
  if (result.cost) {
    const parts = [`Tokens: ${formatTokens(result.cost.total_tokens)}`]
    if (result.cost.total_cost_usd != null) {
      parts.push(`Cost: $${result.cost.total_cost_usd.toFixed(2)}`)
    }
    console.log(`  ${parts.join(' | ')}`)
  }
}

/**
 * CLI entry point for the `run` command.
 */
export default async function run({ args, pkgRoot }: CliContext): Promise<void> {
  const opts = parseArgs(args)

  if (opts.help) {
    console.log(HELP)
    return
  }

  const dbPath = resolve(process.cwd(), '.opencastle', 'convoy.db')

  // ── --dlq-list flag ───────────────────────────────────────────
  if (opts.dlqList) {
    if (!existsSync(dbPath)) {
      console.log('  No convoy database found at .opencastle/convoy.db')
      return
    }
    const { createConvoyStore } = await import('./convoy/store.js')
    const store = createConvoyStore(dbPath)
    try {
      const entries = store.listDlqEntries(opts.dlqConvoyFilter)
      if (entries.length === 0) {
        console.log('  No DLQ entries found.')
        return
      }
      console.log(`\n  Dead Letter Queue (${entries.length} entries):\n`)
      for (const e of entries) {
        const status = e.resolved ? c.green('resolved') : c.red('unresolved')
        console.log(`  ${e.id}  ${status}`)
        console.log(`    Task: ${e.task_id} | Agent: ${e.agent} | Type: ${e.failure_type}`)
        console.log(`    Attempts: ${e.attempts} | Created: ${e.created_at}`)
        if (e.resolution) console.log(`    Resolution: ${e.resolution}`)
        console.log()
      }
    } finally {
      store.close()
    }
    return
  }

  // ── --dlq-resolve flag ────────────────────────────────────────
  if (opts.dlqResolve) {
    if (!opts.dlqResolveId) {
      console.error('  \u2717 --dlq-resolve requires a DLQ entry ID')
      process.exit(1)
    }
    if (!opts.dlqResolveText) {
      console.error('  \u2717 --dlq-resolve requires --resolution "text"')
      process.exit(1)
    }
    if (!existsSync(dbPath)) {
      console.error('  \u2717 No convoy database found at .opencastle/convoy.db')
      process.exit(1)
    }
    const { createConvoyStore } = await import('./convoy/store.js')
    const store = createConvoyStore(dbPath)
    try {
      store.resolveDlqEntry(opts.dlqResolveId, opts.dlqResolveText)
      console.log(`  \u2713 DLQ entry ${opts.dlqResolveId} resolved.`)
    } finally {
      store.close()
    }
    return
  }

  // ── --dlq-retry flag ──────────────────────────────────────────
  if (opts.dlqRetry) {
    if (!opts.dlqRetryId) {
      console.error('  \u2717 --dlq-retry requires a DLQ entry ID')
      process.exit(1)
    }
    if (!existsSync(dbPath)) {
      console.error('  \u2717 No convoy database found at .opencastle/convoy.db')
      process.exit(1)
    }
    const { createConvoyStore } = await import('./convoy/store.js')
    const store = createConvoyStore(dbPath)
    try {
      const entries = store.listDlqEntries()
      const entry = entries.find(e => e.id === opts.dlqRetryId)
      if (!entry) {
        console.error(`  \u2717 DLQ entry "${opts.dlqRetryId}" not found`)
        process.exit(1)
      }
      // Reset the task to pending
      store.updateTaskStatus(entry.task_id, entry.convoy_id, 'pending', {
        worker_id: null,
        worktree: null,
        started_at: null,
        finished_at: null,
      })
      store.resolveDlqEntry(entry.id, 'Retried via CLI')
      // Reset convoy status to running if needed
      const convoy = store.getConvoy(entry.convoy_id)
      if (convoy && (convoy.status === 'failed' || convoy.status === 'done')) {
        store.updateConvoyStatus(entry.convoy_id, 'running', {})
      }
      console.log(`  \u2713 Task ${entry.task_id} reset to pending. Run 'opencastle run --resume' to execute.`)
    } finally {
      store.close()
    }
    return
  }

  // ── --status flag ─────────────────────────────────────────────
  if (opts.status) {
    if (!existsSync(dbPath)) {
      console.log('  No convoy database found at .opencastle/convoy.db')
      return
    }
    const { createConvoyStore } = await import('./convoy/store.js')
    const store = createConvoyStore(dbPath)
    try {
      const pipeline = store.getLatestPipeline()
      if (pipeline) {
        const pipelineConvoys = store.getConvoysByPipeline(pipeline.id)
        console.log(`\n  Pipeline: ${pipeline.name}`)
        console.log(`  ID:       ${pipeline.id}`)
        console.log(`  Status:   ${pipeline.status}`)
        console.log(`  Branch:   ${pipeline.branch ?? '(none)'}`)
        console.log(`  Created:  ${pipeline.created_at}`)
        if (pipeline.started_at) console.log(`  Started:  ${pipeline.started_at}`)
        if (pipeline.finished_at) console.log(`  Finished: ${pipeline.finished_at}`)
        if (pipelineConvoys.length > 0) {
          console.log(`\n  Convoys:`)
          let totalTasks = 0
          let totalDone = 0
          let totalFailed = 0
          let totalTokens = 0
          for (const c of pipelineConvoys) {
            const tasks = store.getTasksByConvoy(c.id)
            const done = tasks.filter(t => t.status === 'done').length
            const failed = tasks.filter(t => t.status === 'failed').length
            totalTasks += tasks.length
            totalDone += done
            totalFailed += failed
            totalTokens += tasks.reduce((sum, t) => sum + (t.total_tokens ?? 0), 0)
            console.log(`    ${c.name} [${c.status}] — ${done}/${tasks.length} tasks done`)
          }
          console.log(`\n  Tasks: ${totalDone} done | ${totalFailed} failed | ${totalTasks} total`)
          if (totalTokens > 0) console.log(`  Tokens: ${formatTokens(totalTokens)}`)
        }
        return
      }

      const convoy = store.getLatestConvoy()
      if (!convoy) {
        console.log('  No convoy records found.')
        return
      }
      const tasks = store.getTasksByConvoy(convoy.id)
      const byStatus = tasks.reduce((acc, t) => {
        acc[t.status] = (acc[t.status] ?? 0) + 1
        return acc
      }, {} as Record<string, number>)
      console.log(`\n  Convoy: ${convoy.name}`)
      console.log(`  ID:     ${convoy.id}`)
      console.log(`  Status: ${convoy.status}`)
      console.log(`  Branch: ${convoy.branch ?? '(none)'}`)
      console.log(`  Created: ${convoy.created_at}`)
      if (convoy.started_at) console.log(`  Started: ${convoy.started_at}`)
      if (convoy.finished_at) console.log(`  Finished: ${convoy.finished_at}`)
      console.log(`\n  Tasks:`)
      for (const [status, count] of Object.entries(byStatus)) {
        console.log(`    ${status}: ${count}`)
      }
      console.log(`    total: ${tasks.length}`)
      const totalTokens = tasks.reduce((sum, t) => sum + (t.total_tokens ?? 0), 0)
      if (tasks.some(t => t.total_tokens != null)) {
        console.log(`\n  Tokens: ${formatTokens(totalTokens)}`)
        const tasksWithTokens = tasks.filter(t => t.total_tokens != null)
        if (tasksWithTokens.length > 0) {
          console.log(`\n  Token usage by task:`)
          for (const t of tasksWithTokens) {
            const parts = [formatTokens(t.total_tokens!)]
            if (t.prompt_tokens != null) parts.push(`in: ${formatTokens(t.prompt_tokens)}`)
            if (t.completion_tokens != null) parts.push(`out: ${formatTokens(t.completion_tokens)}`)
            console.log(`    ${t.id}: ${parts.join(' | ')}`)
          }
        }
      }
    } finally {
      store.close()
    }
    return
  }

  // ── --retry-failed flag ───────────────────────────────────────
  if (opts.retryFailed) {
    if (!existsSync(dbPath)) {
      console.error('  ✗ No convoy database found at .opencastle/convoy.db')
      console.error('    Run a convoy spec first: opencastle run convoy.yml')
      process.exit(1)
    }
    const { createConvoyStore } = await import('./convoy/store.js')
    const store = createConvoyStore(dbPath)
    const convoy = store.getLatestConvoy()
    store.close()
    if (!convoy) {
      console.error('  ✗ No convoy records found in .opencastle/convoy.db')
      process.exit(1)
    }

    const retrySpec = parseTaskSpecText(convoy.spec_yaml)
    if (opts.concurrency !== null) retrySpec.concurrency = opts.concurrency
    if (opts.adapter !== null) retrySpec.adapter = opts.adapter
    if (opts.verbose) retrySpec._verbose = true

    let retryDetectionFailed = false
    if (!retrySpec.adapter) {
      const detected = await detectAdapter()
      if (detected) {
        retrySpec.adapter = detected
        console.log(`  ℹ Auto-detected adapter: ${detected}`)
      } else {
        retryDetectionFailed = true
        retrySpec.adapter = 'claude'
      }
    }

    const retryAdapter = await getAdapter(retrySpec.adapter)
    const retryAvailable = await retryAdapter.isAvailable()
    if (!retryAvailable) {
      printAdapterError(retryDetectionFailed, retrySpec.adapter)
      process.exit(1)
    }

    console.log(`\n  🏰 OpenCastle Convoy (Retry Failed): ${convoy.name}`)
    console.log(`  Convoy ID: ${convoy.id}`)

    const { startDashboardServer } = await import('./dashboard.js')
    let retryDashboardResult: { server: import('node:http').Server; port: number; url: string } | null = null
    try {
      retryDashboardResult = await startDashboardServer({
        pkgRoot,
        openBrowser: true,
        convoyId: 'active',
      })
    } catch {
      // Dashboard failure must not block convoy
    }
    if (retryDashboardResult) {
      console.log(`  ${c.dim('Dashboard:')} ${retryDashboardResult.url}`)
    }

    const { createConvoyEngine } = await import('./convoy/engine.js')
    const retryEngine = createConvoyEngine({
      spec: retrySpec,
      specYaml: convoy.spec_yaml,
      adapter: retryAdapter,
      verbose: opts.verbose,
    })
    await retryEngine.retryFailed(convoy.id, opts.retryFailedTaskIds)
    let retryResult: ConvoyResult
    try {
      retryResult = await retryEngine.resume(convoy.id)
    } catch (err) {
      if (err instanceof EngineAlreadyRunningError) {
        console.error(`  ✗ ${err.message}`)
        process.exit(1)
      }
      throw err
    }
    printConvoyResult(retryResult)
    if (retryDashboardResult) {
      console.log(`\n  ${c.dim('Results saved to .opencastle/convoy.db')}`)
      console.log(`  ${c.dim('Dashboard:')} ${retryDashboardResult.url}`)
      console.log(`\n  Press Ctrl+C to stop`)
      const exitCode = retryResult.status !== 'done' ? 1 : 0
      process.on('SIGINT', () => {
        console.log('\n  Dashboard stopped.\n')
        retryDashboardResult!.server.close()
        process.exit(exitCode)
      })
    } else {
      process.exit(retryResult.status !== 'done' ? 1 : 0)
    }
  }

  // ── --resume flag ─────────────────────────────────────────────
  if (opts.resume) {
    if (!existsSync(dbPath)) {
      console.error('  ✗ No convoy database found at .opencastle/convoy.db')
      console.error('    Run a convoy spec first: opencastle run convoy.yml')
      process.exit(1)
    }
    const { createConvoyStore } = await import('./convoy/store.js')
    const store = createConvoyStore(dbPath)
    const latestPipeline = store.getLatestPipeline()

    // ── Pipeline resume (pending / running / failed) ────────────
    if (latestPipeline && latestPipeline.status !== 'done') {
      store.close()
      const resumePipelineSpec = parseTaskSpecText(latestPipeline.spec_yaml)
      if (opts.concurrency !== null) resumePipelineSpec.concurrency = opts.concurrency
      if (opts.adapter !== null) resumePipelineSpec.adapter = opts.adapter
      if (opts.verbose) resumePipelineSpec._verbose = true

      let resumePipelineDetectionFailed = false
      if (!resumePipelineSpec.adapter) {
        const detected = await detectAdapter()
        if (detected) {
          resumePipelineSpec.adapter = detected
          console.log(`  ℹ Auto-detected adapter: ${detected}`)
        } else {
          resumePipelineDetectionFailed = true
          resumePipelineSpec.adapter = 'claude'
        }
      }

      const resumePipelineAdapter = await getAdapter(resumePipelineSpec.adapter)
      const resumePipelineAvailable = await resumePipelineAdapter.isAvailable()
      if (!resumePipelineAvailable) {
        printAdapterError(resumePipelineDetectionFailed, resumePipelineSpec.adapter)
        process.exit(1)
      }

      console.log(`\n  🏰 OpenCastle Pipeline (Resume): ${latestPipeline.name}`)
      console.log(`  Pipeline ID: ${latestPipeline.id}`)

      const { startDashboardServer } = await import('./dashboard.js')
      let resumePipelineDashResult: { server: import('node:http').Server; port: number; url: string } | null = null
      try {
        resumePipelineDashResult = await startDashboardServer({
          pkgRoot,
          openBrowser: true,
          convoyId: 'active',
        })
      } catch {
        // Dashboard failure must not block pipeline
      }
      if (resumePipelineDashResult) {
        console.log(`  ${c.dim('Dashboard:')} ${resumePipelineDashResult.url}`)
      }

      const { createPipelineOrchestrator } = await import('./convoy/pipeline.js')
      const resumePipelineOrchestrator = createPipelineOrchestrator({
        spec: resumePipelineSpec,
        specYaml: latestPipeline.spec_yaml,
        adapter: resumePipelineAdapter,
        verbose: opts.verbose,
      })
      const resumePipelineResult = await resumePipelineOrchestrator.resume(latestPipeline.id)
      printPipelineResult(resumePipelineResult)
      if (resumePipelineDashResult) {
        console.log(`\n  ${c.dim('Results saved to .opencastle/convoy.db')}`)
        console.log(`  ${c.dim('Dashboard:')} ${resumePipelineDashResult.url}`)
        console.log(`\n  Press Ctrl+C to stop`)
        const exitCode = resumePipelineResult.status !== 'done' ? 1 : 0
        process.on('SIGINT', () => {
          console.log('\n  Dashboard stopped.\n')
          resumePipelineDashResult!.server.close()
          process.exit(exitCode)
        })
      } else {
        process.exit(resumePipelineResult.status !== 'done' ? 1 : 0)
      }
    }

    // ── Pipeline done — don't fall through to convoy check ──────
    if (latestPipeline && latestPipeline.status === 'done') {
      store.close()
      console.error(
        `  ✗ Last pipeline "${latestPipeline.name}" already finished with status: done`
      )
      console.error(`    Only interrupted (running/pending/failed) pipelines can be resumed.`)
      process.exit(1)
    }

    // ── Standalone convoy resume ────────────────────────────────
    const convoy = store.getLatestConvoy()
    store.close()
    if (!convoy) {
      console.error('  ✗ No convoy records found in .opencastle/convoy.db')
      process.exit(1)
    }
    if (convoy.status === 'done' || convoy.status === 'failed') {
      console.error(
        `  ✗ Last convoy "${convoy.name}" already finished with status: ${convoy.status}`
      )
      console.error(`    Only interrupted (running/pending) convoys can be resumed.`)
      process.exit(1)
    }

    const resumeSpec = parseTaskSpecText(convoy.spec_yaml)
    if (opts.concurrency !== null) resumeSpec.concurrency = opts.concurrency
    if (opts.adapter !== null) resumeSpec.adapter = opts.adapter
    if (opts.verbose) resumeSpec._verbose = true

    let resumeDetectionFailed = false
    if (!resumeSpec.adapter) {
      const detected = await detectAdapter()
      if (detected) {
        resumeSpec.adapter = detected
        console.log(`  ℹ Auto-detected adapter: ${detected}`)
      } else {
        resumeDetectionFailed = true
        resumeSpec.adapter = 'claude'
      }
    }

    const resumeAdapter = await getAdapter(resumeSpec.adapter)
    const resumeAvailable = await resumeAdapter.isAvailable()
    if (!resumeAvailable) {
      printAdapterError(resumeDetectionFailed, resumeSpec.adapter)
      process.exit(1)
    }

    console.log(`\n  \uD83C\uDFF0 OpenCastle Convoy (Resume): ${convoy.name}`)
    console.log(`  Convoy ID: ${convoy.id}`)

    const { startDashboardServer } = await import('./dashboard.js')
    let resumeDashResult: { server: import('node:http').Server; port: number; url: string } | null = null
    try {
      resumeDashResult = await startDashboardServer({
        pkgRoot,
        openBrowser: true,
        convoyId: 'active',
      })
    } catch {
      // Dashboard failure must not block convoy
    }
    if (resumeDashResult) {
      console.log(`  ${c.dim('Dashboard:')} ${resumeDashResult.url}`)
    }

    const { createConvoyEngine } = await import('./convoy/engine.js')
    const resumeEngine = createConvoyEngine({
      spec: resumeSpec,
      specYaml: convoy.spec_yaml,
      adapter: resumeAdapter,
      verbose: opts.verbose,
    })
    let resumeResult: ConvoyResult
    try {
      resumeResult = await resumeEngine.resume(convoy.id)
    } catch (err) {
      if (err instanceof EngineAlreadyRunningError) {
        console.error(`  ✗ ${err.message}`)
        process.exit(1)
      }
      throw err
    }
    printConvoyResult(resumeResult)
    if (resumeDashResult) {
      console.log(`\n  ${c.dim('Results saved to .opencastle/convoy.db')}`)
      console.log(`  ${c.dim('Dashboard:')} ${resumeDashResult.url}`)
      console.log(`\n  Press Ctrl+C to stop`)
      const exitCode = resumeResult.status !== 'done' ? 1 : 0
      process.on('SIGINT', () => {
        console.log('\n  Dashboard stopped.\n')
        resumeDashResult!.server.close()
        process.exit(exitCode)
      })
    } else {
      process.exit(resumeResult.status !== 'done' ? 1 : 0)
    }
  }

  // ── Formula template resolution / Read and validate spec ─────
  let specText = ''
  let spec: ReturnType<typeof parseTaskSpecText>

  if (opts.formula) {
    const { parseFormula, substituteVariables, validateTemplate } = await import('./convoy/formula.js')
    const formulaPath = resolve(process.cwd(), opts.formula)
    let template
    try {
      template = parseFormula(formulaPath)
    } catch (err: unknown) {
      console.error(`  ✗ ${(err as Error).message}`)
      console.log(`\n  ${c.dim('Resume:')} npx opencastle run --formula ${opts.formula}`)
      process.exit(1)
    }

    const validation = validateTemplate(template)
    if (!validation.valid) {
      console.error(`  ✗ Invalid formula template:\n  • ${validation.errors.join('\n  • ')}`)
      console.log(`\n  ${c.dim('Resume:')} npx opencastle run --formula ${opts.formula}`)
      process.exit(1)
    }

    if (opts.dryRun) {
      console.log(`\n  📋 Formula: ${template.name}`)
      if (template.description) console.log(`  ${template.description}`)
      console.log(`  Variables:`)
      for (const [key, val] of Object.entries(opts.setVars)) {
        console.log(`    ${key} = ${val}`)
      }
      for (const [key, def] of Object.entries(template.variables)) {
        if (!(key in opts.setVars) && !def.required && def.default) {
          console.log(`    ${key} = ${def.default} (default)`)
        }
      }
    }

    try {
      spec = substituteVariables(template, opts.setVars)
    } catch (err: unknown) {
      console.error(`  ✗ ${(err as Error).message}`)
      console.log(`\n  ${c.dim('Resume:')} npx opencastle run --formula ${opts.formula}`)
      process.exit(1)
    }
    specText = yamlStringify(spec)
  } else {
    // ── Read and validate spec ──────────────────────────────────
    const specPath = resolve(process.cwd(), opts.file)
    try {
      specText = await readFile(specPath, 'utf8')
    } catch (err: unknown) {
      const e = err as Error & { code?: string }
      if (e.code === 'ENOENT') {
        console.error(`  ✗ Task spec file not found: ${opts.file}`)
      } else {
        console.error(`  ✗ Cannot read task spec file: ${e.message}`)
      }
      console.log(`\n  ${c.dim('Resume:')} npx opencastle run -f ${opts.file}`)
      process.exit(1)
    }

    try {
      spec = parseTaskSpecText(specText)
    } catch (err: unknown) {
      console.error(`  ✗ ${(err as Error).message}`)
      console.log(`\n  ${c.dim('Resume:')} npx opencastle run -f ${opts.file}`)
      process.exit(1)
    }
  }

  // Apply CLI overrides
  if (opts.concurrency !== null) spec.concurrency = opts.concurrency
  if (opts.adapter !== null) spec.adapter = opts.adapter
  if (opts.verbose) spec._verbose = true

  // ── Auto-detect adapter if not specified ─────────────────────
  let detectionFailed = false
  if (!spec.adapter) {
    const detected = await detectAdapter()
    if (detected) {
      spec.adapter = detected
      console.log(`  ℹ Auto-detected adapter: ${detected}`)
    } else {
      detectionFailed = true
      spec.adapter = 'claude' // fallback for availability check below
    }
  }

  // ── Dry run ──────────────────────────────────────────────────
  if (opts.dryRun) {
    if (isPipelineSpec(spec)) {
      console.log(`\n  🏰 Pipeline Plan: ${spec.name}`)
      console.log(`  Convoy chain: ${(spec.depends_on_convoy as string[]).join(' → ')}`)
      if (spec.tasks?.length) {
        console.log(`  Plus ${spec.tasks.length} local tasks after chain completes`)
      }
      if (spec.branch) console.log(`  Branch: ${spec.branch}`)
      if (spec.gates?.length) console.log(`  Gates: ${spec.gates.length} validation commands`)
      if (!spec.tasks?.length) return
    } else if (isConvoySpec(spec)) {
      console.log(`\n  \uD83C\uDFF0 Convoy Plan: ${spec.name}`)
      console.log(
        `  Adapter: ${spec.adapter} | Concurrency: ${spec.concurrency} | Tasks: ${spec.tasks!.length}`
      )
      if (spec.branch) console.log(`  Branch: ${spec.branch}`)
      if (spec.gates?.length) console.log(`  Gates: ${spec.gates.length} validation commands`)
    }
    const phases = buildPhases(spec.tasks!)
    printExecutionPlan(spec, phases)
    return
  }

  // ── Check adapter ────────────────────────────────────────────
  const adapter = await getAdapter(spec.adapter)
  const available = await adapter.isAvailable()
  if (!available) {
    printAdapterError(detectionFailed, spec.adapter)
    console.log(`\n  ${c.dim('Resume:')} npx opencastle run -f ${opts.file}`)
    process.exit(1)
  }

  // ── Pipeline orchestrator path (version: 2 specs with depends_on_convoy) ──
  if (isPipelineSpec(spec)) {
    const { createPipelineOrchestrator } = await import('./convoy/pipeline.js')
    console.log(`\n  🏰 OpenCastle Pipeline: ${spec.name}`)
    console.log(`  Convoy chain: ${(spec.depends_on_convoy as string[]).join(' → ')}`)
    if (spec.branch) console.log(`  Branch: ${spec.branch}`)
    if (spec.gates?.length) console.log(`  Gates: ${spec.gates.length} validation commands`)

    const { startDashboardServer } = await import('./dashboard.js')
    let pipelineDashboardResult: { server: import('node:http').Server; port: number; url: string } | null = null
    try {
      pipelineDashboardResult = await startDashboardServer({
        pkgRoot,
        openBrowser: true,
        convoyId: 'active',
      })
    } catch {
      // Dashboard failure must not block pipeline
    }
    if (pipelineDashboardResult) {
      console.log(`  ${c.dim('Dashboard:')} ${pipelineDashboardResult.url}`)
    }

    const pipelineOrchestrator = createPipelineOrchestrator({
      spec,
      specYaml: specText,
      adapter,
      verbose: opts.verbose,
    })

    let pipelineResult: PipelineResult
    try {
      pipelineResult = await pipelineOrchestrator.run()
    } catch (err) {
      if (err instanceof EngineAlreadyRunningError) {
        console.error(`  ✗ ${err.message}`)
        console.log(`\n  ${c.dim('Resume:')} npx opencastle run -f ${opts.file} --resume`)
        process.exit(1)
      }
      throw err
    }
    printPipelineResult(pipelineResult)
    if (pipelineDashboardResult) {
      console.log(`\n  ${c.dim('Results saved to .opencastle/convoy.db')}`)
      console.log(`  ${c.dim('Dashboard:')} ${pipelineDashboardResult.url}`)
      console.log(`\n  Press Ctrl+C to stop`)
      if (pipelineResult.status !== 'done') {
        console.log(`\n  ${c.dim('Retry failed:')} npx opencastle run -f ${opts.file} --retry-failed`)
      }
      const exitCode = pipelineResult.status !== 'done' ? 1 : 0
      process.on('SIGINT', () => {
        console.log('\n  Dashboard stopped.\n')
        pipelineDashboardResult!.server.close()
        process.exit(exitCode)
      })
    } else {
      if (pipelineResult.status !== 'done') {
        console.log(`\n  ${c.dim('Retry failed:')} npx opencastle run -f ${opts.file} --retry-failed`)
      }
      process.exit(pipelineResult.status !== 'done' ? 1 : 0)
    }
    return
  }

  // ── Convoy engine path (version: 1 specs) ────────────────────
  if (isConvoySpec(spec)) {
    const { createConvoyEngine } = await import('./convoy/engine.js')
    console.log(`\n  \uD83C\uDFF0 OpenCastle Convoy: ${spec.name}`)
    console.log(
      `  Adapter: ${adapter.name} | Concurrency: ${spec.concurrency} | Tasks: ${spec.tasks!.length}`
    )
    if (spec.branch) console.log(`  Branch: ${spec.branch}`)
    if (spec.gates?.length) console.log(`  Gates: ${spec.gates.length} validation commands`)

    const { startDashboardServer } = await import('./dashboard.js')
    let dashboardResult: { server: import('node:http').Server; port: number; url: string } | null = null
    try {
      dashboardResult = await startDashboardServer({
        pkgRoot,
        openBrowser: true,
        convoyId: 'active',
      })
    } catch {
      // Dashboard failure must not block convoy
    }
    if (dashboardResult) {
      console.log(`  ${c.dim('Dashboard:')} ${dashboardResult.url}`)
    }

    const engine = createConvoyEngine({
      spec,
      specYaml: specText,
      adapter,
      verbose: opts.verbose,
    })

    if (opts.watch) {
      const pidPath = resolve(process.cwd(), '.opencastle', 'watch.pid')
      const { watchLoop } = await import('./watch.js')
      await watchLoop({
        spec,
        specText,
        specPath: resolve(process.cwd(), opts.file),
        adapter,
        verbose: opts.verbose,
        pidPath,
        clearScratchpad: opts.clearScratchpad,
        watchConfigPath: opts.watchConfig ? resolve(process.cwd(), opts.watchConfig) : null,
        printResult: printConvoyResult,
      })
      return
    }

    let result: ConvoyResult
    try {
      result = await engine.run()
    } catch (err) {
      if (err instanceof EngineAlreadyRunningError) {
        console.error(`  ✗ ${err.message}`)
        console.log(`\n  ${c.dim('Resume:')} npx opencastle run -f ${opts.file} --resume`)
        process.exit(1)
      }
      throw err
    }
    printConvoyResult(result)
    if (dashboardResult) {
      console.log(`\n  ${c.dim('Results saved to .opencastle/convoy.db')}`)
      console.log(`  ${c.dim('Dashboard:')} ${dashboardResult.url}`)
      console.log(`\n  Press Ctrl+C to stop`)
      if (result.status !== 'done') {
        console.log(`\n  ${c.dim('Retry failed:')} npx opencastle run -f ${opts.file} --retry-failed`)
      }
      const exitCode = result.status !== 'done' ? 1 : 0
      process.on('SIGINT', () => {
        console.log('\n  Dashboard stopped.\n')
        dashboardResult!.server.close()
        process.exit(exitCode)
      })
    } else {
      if (result.status !== 'done') {
        console.log(`\n  ${c.dim('Retry failed:')} npx opencastle run -f ${opts.file} --retry-failed`)
      }
      process.exit(result.status !== 'done' ? 1 : 0)
    }
  }

  // ── Legacy executor path ──────────────────────────────────────
  console.log(`\n  \uD83C\uDFF0 OpenCastle Run: ${spec.name}`)
  console.log(
    `  Adapter: ${adapter.name} | Concurrency: ${spec.concurrency} | Tasks: ${spec.tasks!.length}`
  )

  const reporter = createReporter(spec, {
    reportDir: opts.reportDir
      ? resolve(process.cwd(), opts.reportDir)
      : undefined,
    verbose: opts.verbose,
  })

  const executor = createExecutor(spec, adapter, reporter)
  const report = await executor.run()

  // ── Exit code ────────────────────────────────────────────────
  const hasFailures = report.summary.failed > 0 || report.summary['timed-out'] > 0
  process.exit(hasFailures ? 1 : 0)
}
