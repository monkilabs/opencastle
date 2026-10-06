import { findProjectRoot, readRun, readRuns, type RunSummary } from './convoy/read-model.js'
import { nearest } from './nearest.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * The experimental `convoy` namespace.
 *
 * Name a task to plan and run it, run a spec you wrote, continue what is not
 * done, or watch it live. Run it bare to see where the last run stands and the
 * one thing to do next. Everything else that used to live here — a status
 * flag, retry and dead-letter verbs, watch mode, formulas — is state the tool
 * can read for itself, so it is gone.
 */

const CONVOY_HELP = `
  npx opencastle convoy [task] [options]

  Experimental: plan multi-step work and run it with agents in parallel.

  Usage:
    npx opencastle convoy                     The last run and the one next step
    npx opencastle convoy "<task>"            Plan it, show the plan, ask, then run it
    npx opencastle convoy run <spec.yml>      Run a spec you wrote
    npx opencastle convoy resume              Continue whatever is not done
    npx opencastle convoy dashboard           The Observability dashboard, live
    npx opencastle convoy plan --prd <file>   Plan again from a PRD you edited

  Options:
    --yes, -y                With a task: run the plan without asking
    --dry-run                With a task: plan and write the spec, but do not run it.
                             With run or resume: show what would run
    --adapter, -a <name>     Agent runtime (default: the one opencastle init set up)
    --concurrency, -c <n>    Tasks at once
    --verbose                Stream agent output
    --json                   With no task: the last run, as JSON
    --help, -h               Show this help

  Every subcommand has its own --help. This namespace is experimental and may
  change.
`

/**
 * Flags that take a separate value token.
 *
 * Needed to tell a task's words from a flag's argument. `opencastle convoy fix
 * the login bug --adapter codex` must plan "fix the login bug" and not "fix the
 * login bug codex".
 *
 * `bin/cli.mjs` has already split any `--flag=value` form before this runs, so
 * only the space form reaches here.
 */
const FLAGS_WITH_VALUES = new Set(['--adapter', '-a', '--concurrency', '-c', '--file', '-f', '--prd'])

/** Flags the planner reads, forwarded from the task path. */
const TASK_FLAGS = new Set(['--yes', '-y', '--dry-run', '--adapter', '-a', '--concurrency', '-c', '--verbose'])

/** What a mistyped word is checked against. `retry` still works, but is not suggested. */
const SUBCOMMANDS = ['run', 'resume', 'dashboard', 'plan']

/**
 * The words of the task, with the flags and their values taken out.
 *
 * A shell splits an unquoted task into one argument per word, and this command
 * used to read only the first of them: `opencastle convoy add rate limiting to
 * the API` planned a feature called "add". Flag values come out with their
 * flag, so `--adapter codex` cannot add the word "codex" to a task.
 */
export function positionalWords(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * The flags of a task invocation, split into what the planner gets and what
 * nobody recognises.
 *
 * Returning the unknown ones rather than dropping them is the whole point: they
 * become an error naming what was accepted, instead of a run that quietly did
 * something other than what was asked.
 */
export function splitTaskFlags(args: string[]): { forward: string[]; unknown: string[] } {
  const forward: string[] = []
  const unknown: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) continue
    if (TASK_FLAGS.has(arg)) {
      forward.push(arg)
      // A value-taking flag carries its value across with it.
      if (FLAGS_WITH_VALUES.has(arg) && i + 1 < args.length) forward.push(args[++i])
      continue
    }
    unknown.push(arg)
    if (FLAGS_WITH_VALUES.has(arg)) i++
  }
  return { forward, unknown }
}

// ── Status ────────────────────────────────────────────────────────────────────

const FAILED_STATUSES = new Set(['failed', 'gate-failed', 'timed-out', 'review-blocked', 'disputed', 'hook-failed'])

export interface LastRun {
  id: string
  name: string
  status: string
  branch: string | null
  created_at: string
  /** A process is working on it now. */
  alive: boolean
  total: number
  done: number
  /** Every failed status: failed, gate-failed, timed-out, review-blocked, disputed, hook-failed. */
  failed: number
  running: number
  skipped: number
  pending: number
  /** The one command to run next. */
  next: string
  /** An older run with work left, when this one has none: what `resume` would continue. */
  older_unfinished: { id: string; name: string } | null
}

function unfinished(run: RunSummary): boolean {
  return run.status !== 'done' || run.tasks_done < run.tasks_total
}

/**
 * The last run, from the read model: the database is opened read-only, never
 * migrated, and closed again. The status screen used to open the read-write
 * store, which migrated an older project's database just to look at it.
 */
export function readLastRun(projectRoot: string): LastRun | null {
  const runs = readRuns(projectRoot, 200)
  if (runs.length === 0) return null
  const last = runs[0]
  const tasks = readRun(projectRoot, last.id)?.tasks ?? []
  const count = (pick: (s: string) => boolean): number => tasks.filter((t) => pick(t.status)).length
  const done = count((s) => s === 'done')
  // Not done is not done: skipped and running tasks count against "finished"
  // as much as failed ones do, and the run's own status is not trusted to say so.
  const notDone = last.status !== 'done' || done < tasks.length
  const older = notDone ? undefined : runs.slice(1).find(unfinished)
  return {
    id: last.id,
    name: last.name,
    status: last.status,
    branch: last.branch,
    created_at: last.created_at,
    alive: last.alive,
    total: tasks.length,
    done,
    failed: count((s) => FAILED_STATUSES.has(s)),
    running: count((s) => s === 'running' || s === 'assigned'),
    skipped: count((s) => s === 'skipped'),
    pending: count((s) => s === 'pending'),
    next: last.alive ? 'npx opencastle convoy dashboard' : notDone ? 'npx opencastle convoy resume' : 'npx opencastle convoy "<task>"',
    older_unfinished: older ? { id: older.id, name: older.name } : null,
  }
}

/** Bare `convoy`: report the last run and the one verb that fits its state. */
function renderStatus(last: LastRun | null, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(last, null, 2))
    return
  }

  console.log(`\n  🚚 ${c.bold('Convoy')} ${c.dim('(experimental)')}\n`)
  if (!last) {
    console.log('  No runs yet.\n')
    console.log(`  ${c.bold('Start one:')} ${c.cyan('npx opencastle convoy "add rate limiting to the API"')}\n`)
    return
  }

  const resumable = last.next === 'npx opencastle convoy resume'
  const mark = last.alive ? c.cyan('▶') : resumable ? c.yellow('!') : c.green('✓')
  const state = last.alive ? 'running now' : last.status
  console.log(`  ${mark} ${c.bold(last.name)} ${c.dim(`— ${state}`)}`)
  const parts = [`${last.done}/${last.total} done`]
  if (last.failed) parts.push(c.yellow(`${last.failed} failed`))
  if (last.skipped) parts.push(c.yellow(`${last.skipped} skipped`))
  if (last.running) parts.push(`${last.running} running`)
  if (last.pending) parts.push(c.dim(`${last.pending} pending`))
  console.log(`    ${parts.join(', ')}`)
  if (last.branch) console.log(`    ${c.dim('Branch')} ${last.branch}`)
  console.log('')

  const why = last.alive
    ? 'watch it live'
    : resumable
      ? 'runs what is not done — failed, interrupted and skipped tasks — and keeps the rest'
      : 'every task is done; start another'
  console.log(`  ${c.bold('Next:')} ${c.cyan(last.next)}`)
  console.log(`  ${c.dim(why)}`)
  if (last.older_unfinished) {
    console.log(`  ${c.dim(`An earlier run, ${last.older_unfinished.name}, has work left; npx opencastle convoy resume continues it.`)}`)
  }
  console.log('')
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/** Hand the arguments to another command module. */
async function delegate(mod: string, ctx: CliContext, args: string[]): Promise<void> {
  const loaded = (await import(`./${mod}.js`)) as { default: (_ctx: CliContext) => Promise<void> }
  await loaded.default({ ...ctx, args })
}

function refuse(message: string, hint?: string): never {
  console.error(`  ${c.red('✗')} ${message}`)
  if (hint) console.error(`  ${c.dim(hint)}`)
  process.exit(1)
}

/** An unknown flag, named with what replaced it when it is one we removed, or the nearest one we have. */
async function unknownFlag(flag: string, candidates: string[]): Promise<string> {
  const { REMOVED_FLAGS } = await import('./run.js')
  if (flag in REMOVED_FLAGS) return `${flag} was removed. ${REMOVED_FLAGS[flag]}.`
  const near = nearest(flag, candidates)
  return `Unknown option ${flag}.${near ? ` Did you mean ${near}?` : ''}`
}

export default async function convoy(ctx: CliContext): Promise<void> {
  const { args } = ctx
  const [sub, ...rest] = args

  switch (sub) {
    case 'run':
      await delegate('run', ctx, rest)
      return
    case 'resume':
    // `retry` is what this was called before resume did everything it did.
    case 'retry': {
      const { resume } = await import('./run.js')
      await resume({ ...ctx, args: rest })
      return
    }
    case 'dashboard':
      await delegate('dashboard', ctx, rest)
      return
    case 'plan':
      // The only way to plan again from a PRD someone edited.
      await delegate('pipeline', ctx, rest)
      return
    default:
      break
  }

  // `convoy --help` is ours; `convoy run --help` belongs to the subcommand.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(CONVOY_HELP)
    return
  }

  // A flag that belongs to a subcommand used at this level would otherwise
  // be read as part of a task, or dropped.
  const SUBCOMMAND_FLAGS = new Map([
    ['--file', 'run'],
    ['-f', 'run'],
    ['--prd', 'plan'],
  ])
  const misplaced = args.find((a) => SUBCOMMAND_FLAGS.has(a))
  if (misplaced) {
    const owner = SUBCOMMAND_FLAGS.get(misplaced)!
    refuse(
      `${misplaced} belongs to \`npx opencastle convoy ${owner}\`.`,
      `Try: npx opencastle convoy ${owner} ${args.slice(args.indexOf(misplaced)).join(' ')}`,
    )
  }

  const words = positionalWords(args)
  if (words.length === 0) {
    // Flags alone: the status screen, which reads only --json.
    const stray = args.find((a) => a.startsWith('-') && a !== '--json')
    if (stray) {
      refuse(
        TASK_FLAGS.has(stray) ? `${stray} goes with a task: npx opencastle convoy "<task>" ${stray}` : await unknownFlag(stray, ['--json', ...TASK_FLAGS]),
        'Run "npx opencastle convoy --help" for usage.',
      )
    }
    renderStatus(readLastRun(findProjectRoot(process.cwd()) ?? process.cwd()), args.includes('--json'))
    return
  }

  // A single word is not something a planner can act on, and is far more
  // often a mistyped subcommand: `convoy resum` used to start a planning
  // session for a feature called "resum". Planning costs real sessions, so
  // the word is checked before any start.
  if (words.length === 1 && !words[0].includes(' ')) {
    const near = nearest(words[0], SUBCOMMANDS)
    refuse(
      near ? `Unknown subcommand "${words[0]}". Did you mean npx opencastle convoy ${near}?` : `"${words[0]}" is one word; describe the task in a few.`,
      near
        ? 'To plan a task, describe it in a few words: npx opencastle convoy "add rate limiting to the API"'
        : 'For example: npx opencastle convoy "add rate limiting to the API". For the last run: npx opencastle convoy',
    )
  }

  // Everything else is a task: plan it, show the plan, ask, run. Every word,
  // not just the first: an unquoted task arrives as one argument per word.
  const { forward, unknown } = splitTaskFlags(args)
  if (unknown.length > 0) {
    refuse(await unknownFlag(unknown[0], [...TASK_FLAGS]), `A task accepts: ${[...TASK_FLAGS].join(' ')} --help`)
  }
  const { planTask } = await import('./pipeline.js')
  await planTask({ ...ctx, args: forward }, words.join(' '))
}
