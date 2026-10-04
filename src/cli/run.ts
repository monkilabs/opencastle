/**
 * `opencastle convoy run <spec.yml>` and `opencastle convoy resume`.
 *
 * Two things, and only two: start a spec, or continue the newest run that is
 * not done. This file used to be a 1,250-line parser in front of three
 * executors — the convoy engine, a legacy executor and a pipeline orchestrator —
 * with watch mode, formulas, a dead-letter queue and a status report bolted on.
 * Each path finished a run in its own way, so the summary printed twice and a
 * finished run could sit waiting for Ctrl+C. The engine now does the work and
 * prints its own summary; this file picks the runtime, shows the live view,
 * and exits with the engine's code.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseTaskSpecText } from './run/schema.js'
import { resolveAdapter, cleanupAdapters, type ResolvedAdapter } from './run/adapters/index.js'
import { permissionModeError } from './run/adapters/permission-modes.js'
import { findProjectRoot, isRunAlive, readRun, readRunSpec, readRuns, type RunSummary } from './convoy/read-model.js'
import { checkConvoyPlan, createConvoyEngine, RESUME_RESET_STATUSES, type ConvoyResult } from './convoy/engine.js'
import { EngineAlreadyRunningError } from './convoy/lock.js'
import { startDashboard, type DashboardHandle } from './dashboard.js'
import { nearest } from './nearest.js'
import { c } from './prompt.js'
import type { TaskSpec } from './convoy/spec-types.js'
import type { CliContext } from './types.js'

const RUN_HELP = `
  npx opencastle convoy run <spec.yml> [options]

  Run a convoy spec: one you wrote, or one npx opencastle convoy "<task>" wrote to
  .opencastle/convoys/. The work lands on a branch of its own (the spec's
  branch, or convoy/<name>-<id>); your checkout is never touched.

  Options:
    --dry-run                Check the spec and show what would run; start nothing
    --adapter, -a <name>     Agent runtime: claude, codex, cursor, opencode or copilot
                             (default: the spec's, else the one npx opencastle init set up)
    --concurrency, -c <n>    Tasks at once (default: the spec's, else 4)
    --verbose                Stream agent output
    --help, -h               Show this help
`

const RESUME_HELP = `
  npx opencastle convoy resume [options]

  Continue the newest run that is not done. Failed, timed-out and interrupted
  tasks run again, and so do the tasks a failure skipped; finished tasks are
  kept. It runs on the branch and runtime the run started with.

  Options:
    --dry-run                List the tasks that would run; start nothing
    --adapter, -a <name>     Run on another agent runtime instead
    --concurrency, -c <n>    Tasks at once
    --verbose                Stream agent output
    --help, -h               Show this help
`

// ── Arguments ─────────────────────────────────────────────────────────────────

export interface RunArgs {
  /** The spec path, as typed. Null for resume, or when it is missing. */
  spec: string | null
  dryRun: boolean
  adapter: string | null
  concurrency: number | null
  verbose: boolean
  help: boolean
}

const KNOWN_FLAGS = ['--dry-run', '--adapter', '-a', '--concurrency', '-c', '--verbose', '--help', '-h']

/**
 * Flags this command used to take, and what to do instead. Named one by one,
 * because "unknown option" is the wrong answer to a flag our own docs taught.
 */
export const REMOVED_FLAGS: Record<string, string> = {
  '--resume': 'Use: npx opencastle convoy resume',
  '--retry-failed': 'Use: npx opencastle convoy resume — it re-runs failed tasks too',
  '--status': 'Use: npx opencastle convoy — it shows the last run and what to do next',
  '--dlq-list': 'Failed tasks are listed by npx opencastle convoy, and re-run by npx opencastle convoy resume',
  '--dlq-resolve': 'Failed tasks are listed by npx opencastle convoy, and re-run by npx opencastle convoy resume',
  '--dlq-retry': 'Use: npx opencastle convoy resume',
  '--formula': 'Formulas are gone: write the spec out, or plan it with npx opencastle convoy "<task>"',
  '--set': 'Formulas are gone: write the spec out, or plan it with npx opencastle convoy "<task>"',
  '--watch': 'Watch mode is gone: run the spec again when you want it run',
  '--watch-config': 'Watch mode is gone: run the spec again when you want it run',
  '--clear-scratchpad': 'Watch mode is gone: run the spec again when you want it run',
  '--report-dir': 'Runs are recorded in .opencastle/convoy.db. See them with npx opencastle convoy dashboard',
  '--permission-mode': 'Set defaults.permission_mode in the spec instead',
}

/**
 * Read `convoy run` or `convoy resume` arguments.
 *
 * The spec is positional; `-f`/`--file` still names it, quietly, because
 * every spec written before this change says `convoy run -f <spec>`.
 */
export function parseRunArgs(args: string[], command: 'run' | 'resume'): RunArgs | { error: string } {
  const out: RunArgs = { spec: null, dryRun: false, adapter: null, concurrency: null, verbose: false, help: false }
  const value = (i: number, flag: string): string | { error: string } => {
    const v = args[i + 1]
    if (v === undefined || v.startsWith('-') || !v.trim()) return { error: `${flag} needs a value` }
    return v
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--verbose':
        out.verbose = true
        break
      case '--adapter':
      case '-a': {
        const v = value(i++, arg)
        if (typeof v !== 'string') return v
        out.adapter = v
        break
      }
      case '--concurrency':
      case '-c': {
        const v = value(i++, arg)
        if (typeof v !== 'string') return v
        const n = Number(v)
        if (!/^\d+$/.test(v) || n < 1 || n > 50) return { error: `--concurrency must be a whole number from 1 to 50, not "${v}"` }
        out.concurrency = n
        break
      }
      case '--file':
      case '-f': {
        if (command !== 'run') return { error: `${arg} belongs to npx opencastle convoy run` }
        const v = value(i++, arg)
        if (typeof v !== 'string') return v
        if (out.spec !== null) return { error: `Two specs given: ${out.spec} and ${v}. Run one at a time.` }
        out.spec = v
        break
      }
      default: {
        if (arg in REMOVED_FLAGS) return { error: `${arg} was removed. ${REMOVED_FLAGS[arg]}.` }
        if (arg.startsWith('-')) {
          const near = nearest(arg, KNOWN_FLAGS)
          return { error: `Unknown option ${arg}. ${near ? `Did you mean ${near}?` : `It accepts ${KNOWN_FLAGS.join(', ')}.`}` }
        }
        if (command === 'resume') {
          return { error: `Unexpected argument "${arg}". resume continues the newest run that is not done, and takes no name.` }
        }
        if (out.spec !== null) return { error: `Two specs given: ${out.spec} and ${arg}. Run one at a time.` }
        out.spec = arg
      }
    }
  }
  return out
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** Where `.opencastle/` is: the nearest one at or above the current directory, else here. */
function projectRootHere(): string {
  return findProjectRoot(process.cwd()) ?? process.cwd()
}

function fail(message: string): number {
  console.error(`  ${c.red('✗')} ${message}`)
  return 1
}

/**
 * Pick the runtime, once, with the rule `resolveAdapter` owns. On resume the
 * runtime the run recorded comes before the spec's own `adapter:`, so a run
 * that started on the configured runtime continues on it.
 */
async function chooseRuntime(projectRoot: string, explicit: string | null, spec: TaskSpec, recorded?: string | null): Promise<ResolvedAdapter> {
  const fromRecord = !explicit && Boolean(recorded)
  const why = (text: string): string =>
    fromRecord ? text.replace(/adapter: \S+ in the spec/, 'the runtime this run started on') : text
  try {
    const resolved = await resolveAdapter({ projectRoot, explicit, specAdapter: recorded || spec.adapter || null })
    return { ...resolved, detail: why(resolved.detail) }
  } catch (err) {
    throw new Error(why((err as Error).message))
  }
}

/** The run's own settings, after the command line has had its say. */
function applyArgs(spec: TaskSpec, args: RunArgs, runtime: string): void {
  // Written into the spec the engine gets, so the run, its resume and its
  // record all name the same runtime.
  spec.adapter = runtime
  if (args.concurrency !== null) spec.concurrency = args.concurrency
  if (args.verbose) spec._verbose = true
}

function concurrencyOf(spec: TaskSpec): number {
  return typeof spec.concurrency === 'number' ? spec.concurrency : (spec.defaults?.max_swarm_concurrency ?? 4)
}

/**
 * The live dashboard, on a terminal and outside CI. A run in a pipeline has
 * nobody to look at it, and a port held open there is a port held for nothing.
 */
async function maybeStartDashboard(projectRoot: string): Promise<DashboardHandle | null> {
  if (!process.stdout.isTTY || process.env.CI) return null
  try {
    return await startDashboard({ projectRoot, port: 4300, open: false })
  } catch {
    // A busy port or a missing page must not stop the run itself.
    return null
  }
}

/**
 * Run the engine, then let go of everything: the dashboard's server, any agent
 * an adapter still holds. Whatever happens, the caller gets an exit code back and
 * nothing is left keeping the process alive.
 */
async function drive(work: () => Promise<ConvoyResult>, projectRoot: string): Promise<number> {
  const dashboard = await maybeStartDashboard(projectRoot)
  if (dashboard) console.log(`  ${c.dim('Live view:')} ${dashboard.url}`)
  console.log('')
  try {
    const result = await work()
    return result.exitCode ?? (result.status === 'done' ? 0 : 1)
  } catch (err) {
    if (err instanceof EngineAlreadyRunningError) {
      return fail(`${err.message}\n    Watch it with: npx opencastle convoy dashboard`)
    }
    return fail((err as Error).message)
  } finally {
    await dashboard?.close()
    await cleanupAdapters()
  }
}

// ── convoy run <spec.yml> ─────────────────────────────────────────────────────

function fit(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : text.slice(0, Math.max(0, width - 1)) + '…'
}

/** What a run would do: the tasks and their order, where the work lands, and on what. */
function describePlan(spec: TaskSpec, runtime: string): string[] {
  const tasks = spec.tasks ?? []
  const rows = tasks.map((t) => ({
    id: t.id,
    agent: t.agent,
    deps: t.depends_on.length ? t.depends_on.join(', ') : '–',
    files: t.files.length ? t.files.join(', ') : '(any)',
  }))
  const width = (pick: (r: (typeof rows)[number]) => string, header: string, cap: number): number =>
    Math.min(cap, Math.max(header.length, ...rows.map((r) => pick(r).length)))
  const idW = width((r) => r.id, 'TASK', 32)
  const agentW = width((r) => r.agent, 'AGENT', 18)
  const depsW = width((r) => r.deps, 'WAITS FOR', 30)
  const line = (a: string, b: string, d: string, f: string): string =>
    `    ${fit(a, idW)}  ${fit(b, agentW)}  ${fit(d, depsW)}  ${f}`
  return [
    `  ${c.bold(`Convoy: ${spec.name}`)} ${c.dim(`— ${tasks.length} task${tasks.length === 1 ? '' : 's'}, up to ${concurrencyOf(spec)} at once`)}`,
    '',
    c.dim(line('TASK', 'AGENT', 'WAITS FOR', 'FILES')),
    ...rows.map((r) => line(r.id, r.agent, r.deps, r.files)),
    '',
    `  ${c.dim('Runtime')} ${runtime}`,
    `  ${c.dim('Branch')}  ${spec.branch ?? 'convoy/<name>-<id>, created when it runs'}`,
    ...(spec.gates?.length ? [`  ${c.dim('Gates')}   ${spec.gates.join(', ')} ${c.dim('(once, after the tasks)')}`] : []),
  ]
}

/**
 * `convoy run <spec>`: the exit code it should end with.
 *
 * `runtime` is for the planner, which has already chosen the runtime and said
 * which; the run uses it rather than choosing, and saying, a second time.
 */
export async function runSpec(args: RunArgs, opts: { runtime?: ResolvedAdapter } = {}): Promise<number> {
  if (!args.spec) {
    console.error(`  ${c.red('✗')} Name the spec to run: npx opencastle convoy run <spec.yml>`)
    console.error(`  ${c.dim('Specs the planner wrote are in .opencastle/convoys/.')}`)
    return 1
  }

  let specText: string
  try {
    specText = await readFile(resolve(process.cwd(), args.spec), 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return fail(e.code === 'ENOENT' ? `Spec not found: ${args.spec}` : `Cannot read ${args.spec}: ${e.message}`)
  }
  let spec: TaskSpec
  try {
    spec = parseTaskSpecText(specText)
  } catch (err) {
    return fail(`${args.spec}: ${(err as Error).message}`)
  }

  const projectRoot = projectRootHere()
  let runtime: ResolvedAdapter | null = opts.runtime ?? null
  let runtimeProblem: string | null = null
  if (!runtime) {
    try {
      runtime = await chooseRuntime(projectRoot, args.adapter, spec)
    } catch (err) {
      runtimeProblem = (err as Error).message
    }
  }

  if (args.dryRun) {
    // The engine's own check, so a dry run refuses exactly what a run refuses.
    // Nothing is started and nothing is written to the database.
    try {
      await checkConvoyPlan(spec, runtime?.name ?? (spec.adapter || 'auto'))
    } catch (err) {
      return fail((err as Error).message)
    }
    if (runtime) applyArgs(spec, args, runtime.name)
    else if (args.concurrency !== null) spec.concurrency = args.concurrency
    console.log('')
    for (const l of describePlan(spec, runtime?.detail ?? c.red('none usable — see below'))) console.log(l)
    console.log('')
    if (runtimeProblem) return fail(runtimeProblem)
    const problem = spec.defaults?.permission_mode ? permissionModeError(runtime!.name, spec.defaults.permission_mode) : null
    if (problem) return fail(problem)
    console.log(`  ${c.dim('Dry run — nothing started, nothing recorded. To run it:')} npx opencastle convoy run ${args.spec}`)
    console.log('')
    return 0
  }

  if (!runtime) return fail(runtimeProblem!)
  const problem = spec.defaults?.permission_mode ? permissionModeError(runtime.name, spec.defaults.permission_mode) : null
  if (problem) return fail(problem)
  applyArgs(spec, args, runtime.name)

  console.log('')
  console.log(`  ${c.bold(`Convoy: ${spec.name}`)} ${c.dim(`— ${spec.tasks?.length ?? 0} tasks`)}`)
  if (!opts.runtime) console.log(`  ${c.dim('Runtime:')} ${runtime.detail}`)
  const models = describeModels(spec, runtime)
  if (models) console.log(`  ${c.dim('Models:')} ${models}`)
  const engine = createConvoyEngine({ spec, specYaml: specText, adapter: runtime.adapter, verbose: args.verbose, basePath: projectRoot })
  return drive(() => engine.run(), projectRoot)
}

/**
 * Which model the tasks run on, said once before they start: a run that picks
 * models by tier spends far less than one on the runtime's default, and a
 * person should be able to see which happened.
 */
function describeModels(spec: TaskSpec, runtime: ResolvedAdapter): string | null {
  if (spec.defaults?.model) return `${spec.defaults.model} for every task (defaults.model)`
  const t = runtime.adapter.tierModels
  if (!t) return null
  return `by agent tier — ${[t.premium && `premium ${t.premium}`, t.standard && `standard ${t.standard}`, t.economy && `economy ${t.economy} (and reviews)`].filter(Boolean).join(', ')}`
}

// ── convoy resume ─────────────────────────────────────────────────────────────

/** Not done: a status other than done, or a task that did not finish (older runs ended "done" with tasks skipped). */
function unfinished(run: RunSummary): boolean {
  return run.status !== 'done' || run.tasks_done < run.tasks_total
}

/** `convoy resume`: the exit code it should end with. */
export async function resumeLast(args: RunArgs): Promise<number> {
  const projectRoot = projectRootHere()
  const runs = readRuns(projectRoot, 200)
  if (runs.length === 0) {
    console.error(`  ${c.red('✗')} No convoy runs in this project yet.`)
    console.error(`  ${c.dim('Start one:')} npx opencastle convoy "<task>"`)
    return 1
  }
  const target = runs.find(unfinished)
  if (!target) {
    const last = runs[0]
    console.log(`  Nothing to resume: the last run, ${c.bold(last.name)}, finished with all ${last.tasks_total} tasks done.`)
    console.log(`  ${c.dim('Start another:')} npx opencastle convoy "<task>"`)
    return 0
  }
  if (isRunAlive(projectRoot, target.id)) {
    console.error(`  ${c.red('✗')} ${target.name} (${target.id}) is still running in another process.`)
    console.error(`  ${c.dim('Watch it:')} npx opencastle convoy dashboard`)
    return 1
  }

  const recorded = readRunSpec(projectRoot, target.id)
  if (!recorded) return fail(`The spec ${target.id} was started with is not in .opencastle/convoy.db.`)
  let spec: TaskSpec
  try {
    spec = parseTaskSpecText(recorded.specYaml)
  } catch (err) {
    return fail(`The spec ${target.name} was recorded with no longer reads: ${(err as Error).message}`)
  }

  const done = `${target.tasks_done}/${target.tasks_total} tasks done`
  console.log('')
  console.log(`  ${c.bold(`Resuming ${target.name}`)} ${c.dim(`(${target.id}) — ${target.status}, ${done}`)}`)
  if (target !== runs[0]) {
    console.log(`  ${c.dim(`The newest run, ${runs[0].name}, finished; this is the newest one that did not.`)}`)
  }

  if (args.dryRun) {
    // Read from the read model: a preview opens nothing that could migrate or write.
    const tasks = readRun(projectRoot, target.id)?.tasks ?? []
    const again = new Set<string>(['pending', ...RESUME_RESET_STATUSES])
    const selected = tasks.filter((t) => again.has(t.status))
    console.log('')
    if (selected.length === 0) {
      console.log('  No task would run: every task is done.')
    } else {
      console.log(`  Would run ${selected.length} of ${tasks.length} task(s):`)
      for (const t of selected) console.log(`    ${t.id} ${c.dim(`— ${t.agent} [${t.status}]`)}`)
    }
    console.log('')
    console.log(`  ${c.dim('Dry run — nothing started, nothing recorded.')}`)
    console.log('')
    return 0
  }

  let runtime: ResolvedAdapter
  try {
    runtime = await chooseRuntime(projectRoot, args.adapter, spec, recorded.adapter)
  } catch (err) {
    return fail((err as Error).message)
  }
  const problem = spec.defaults?.permission_mode ? permissionModeError(runtime.name, spec.defaults.permission_mode) : null
  if (problem) return fail(problem)
  applyArgs(spec, args, runtime.name)
  console.log(`  ${c.dim('Runtime:')} ${runtime.detail}`)
  const models = describeModels(spec, runtime)
  if (models) console.log(`  ${c.dim('Models:')} ${models}`)

  const engine = createConvoyEngine({ spec, specYaml: recorded.specYaml, adapter: runtime.adapter, verbose: args.verbose, basePath: projectRoot })
  return drive(() => engine.resume(target.id), projectRoot)
}

// ── Entry points ──────────────────────────────────────────────────────────────

/**
 * Exit once what was written has reached the terminal or the pipe. Exiting is
 * deliberate: a finished run must never sit waiting for Ctrl+C because some
 * handle — a socket, a timer, an agent's pipe — was left open.
 */
export function exitWith(code: number): void {
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

async function main(args: string[], command: 'run' | 'resume'): Promise<void> {
  const parsed = parseRunArgs(args, command)
  if ('error' in parsed) {
    console.error(`  ${c.red('✗')} ${parsed.error}`)
    console.error(`  Run "npx opencastle convoy ${command} --help" for usage.`)
    exitWith(1)
    return
  }
  if (parsed.help) {
    console.log(command === 'run' ? RUN_HELP : RESUME_HELP)
    return
  }
  exitWith(command === 'run' ? await runSpec(parsed) : await resumeLast(parsed))
}

/** `opencastle convoy run <spec.yml>`. */
export default async function run({ args }: CliContext): Promise<void> {
  await main(args, 'run')
}

/** `opencastle convoy resume`, and its hidden alias `retry`. */
export async function resume({ args }: CliContext): Promise<void> {
  await main(args, 'resume')
}
