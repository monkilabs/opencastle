import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createConvoyStore } from './convoy/store.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * The experimental `convoy` namespace.
 *
 * Convoy execution used to occupy four top-level commands (start, plan,
 * validate, run) plus a 20-flag arg parser inside `run` that bundled status
 * reporting, resume, retry, and three DLQ verbs. All of that is state the tool
 * can read for itself, so the surface here is: name a task to start one, or run
 * it bare to see where the last one stands and what to do about it.
 */

const CONVOY_HELP = `
  opencastle convoy [task] [options]

  Experimental: run multi-step work through the convoy engine.

  Usage:
    opencastle convoy                    Show the last run and what to do next
    opencastle convoy "<task>"           Plan and execute a task
    opencastle convoy plan --prd <path>  Resume from a PRD written earlier
    opencastle convoy resume             Continue the last interrupted run
    opencastle convoy retry              Re-run the failed tasks of the last run
    opencastle convoy dashboard          Open the run viewer
    opencastle convoy run -f <spec>      Execute a spec you wrote by hand

  Options:
    --dry-run       Plan only; do not execute
    --verbose       Stream agent output
    --json          Machine-readable status
    --help, -h      Show this help

  run and plan take their own options — try: opencastle convoy run --help

  This namespace is experimental and may change or be removed.
`

/** Delegate to an existing command module, passing through remaining args. */
async function delegate(mod: string, ctx: CliContext, args: string[]): Promise<void> {
  const loaded = (await import(`./${mod}.js`)) as {
    default: (_ctx: CliContext) => Promise<void>
  }
  await loaded.default({ ...ctx, args })
}

interface LastRun {
  id: string
  name: string
  status: string
  total: number
  done: number
  failed: number
  pending: number
}

function readLastRun(projectRoot: string): LastRun | null {
  const dbPath = resolve(projectRoot, '.opencastle', 'convoy.db')
  if (!existsSync(dbPath)) return null
  let store
  try {
    store = createConvoyStore(dbPath)
  } catch {
    return null
  }
  try {
    const convoy = store.getLatestConvoy()
    if (!convoy) return null
    const tasks = store.getTasksByConvoy(convoy.id)
    return {
      id: convoy.id,
      name: convoy.name,
      status: convoy.status,
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      failed: tasks.filter((t) => t.status === 'failed' || t.status === 'gate-failed').length,
      pending: tasks.filter((t) => t.status === 'pending' || t.status === 'assigned').length,
    }
  } catch {
    return null
  } finally {
    try { store.close() } catch { /* already closed */ }
  }
}

/** Bare `convoy`: report the last run and offer the verb that fits its state. */
function renderStatus(last: LastRun | null, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(last, null, 2))
    return
  }

  if (!last) {
    console.log(`\n  🚚 ${c.bold('Convoy')} ${c.dim('(experimental)')}\n`)
    console.log('  No runs yet.\n')
    console.log(`  ${c.bold('Start one:')} ${c.cyan('opencastle convoy "add rate limiting to the API"')}\n`)
    return
  }

  const mark =
    last.status === 'done' ? c.green('✓') : last.status === 'running' ? c.cyan('▶') : c.yellow('!')

  console.log(`\n  🚚 ${c.bold('Convoy')} ${c.dim('(experimental)')}\n`)
  console.log(`  ${mark} ${c.bold(last.name)} ${c.dim(`— ${last.status}`)}`)
  console.log(
    `    ${last.done}/${last.total} done` +
      (last.failed ? c.yellow(`, ${last.failed} failed`) : '') +
      (last.pending ? c.dim(`, ${last.pending} pending`) : ''),
  )
  console.log('')

  if (last.failed > 0) {
    console.log(`  ${c.bold('Next:')} ${c.cyan('opencastle convoy retry')}`)
    console.log(`  ${c.dim('re-runs only the failed tasks')}`)
  } else if (last.pending > 0 || last.status === 'running') {
    console.log(`  ${c.bold('Next:')} ${c.cyan('opencastle convoy resume')}`)
    console.log(`  ${c.dim('continues from the last checkpoint')}`)
  } else {
    console.log(`  ${c.dim('Nothing outstanding. Start another with')} ${c.cyan('opencastle convoy "<task>"')}`)
  }
  console.log('')
}

export default async function convoy(ctx: CliContext): Promise<void> {
  const { args } = ctx

  const [sub, ...rest] = args

  // `convoy --help` is ours; `convoy plan --help` belongs to the subcommand, which
  // is where its flags are actually documented.
  const wantsHelp = args.includes('--help') || args.includes('-h')
  if (wantsHelp && (sub === undefined || sub === '--help' || sub === '-h')) {
    console.log(CONVOY_HELP)
    return
  }

  // `--json` belongs to the status path; forwarding it to the planner would only
  // earn an "Unknown option" from an arg parser that has never heard of it.
  const PLANNER_FLAGS = new Set(['--dry-run', '--verbose'])
  const passthrough = args.filter((a) => PLANNER_FLAGS.has(a))

  switch (sub) {
    case undefined:
      renderStatus(readLastRun(process.cwd()), false)
      return

    case 'resume':
      await delegate('run', ctx, ['--resume', ...rest])
      return

    case 'retry':
      await delegate('run', ctx, ['--retry-failed', ...rest])
      return

    case 'dashboard':
      await delegate('dashboard', ctx, rest)
      return

    case 'run':
      // Explicit spec execution, for a .convoy.yml written by hand or by the planner.
      await delegate('run', ctx, rest)
      return

    case 'plan':
      // The planner writes a PRD before it writes a spec, and tells you where. Without
      // this there was no command that would take that PRD back — the advice dead-ended.
      await delegate('pipeline', ctx, rest)
      return

    default:
      break
  }

  // A bare flag set with no subcommand is a status query — but only for flags
  // this level actually reads. `--file` and `--prd` belong to `run` and `plan`,
  // and falling into the status screen meant `convoy --file spec.yml` printed
  // "No runs yet" and exited without reading the file, or looking for it: the
  // value was never touched, so a path that did not exist produced no error. Our
  // own shipped instructions named that form.
  const SUBCOMMAND_FLAGS = new Map([
    ['--file', 'run'],
    ['-f', 'run'],
    ['--prd', 'plan'],
    ['--resume', 'resume'],
    ['--retry-failed', 'retry'],
  ])
  const misplaced = args.find((a) => SUBCOMMAND_FLAGS.has(a))
  if (misplaced) {
    const owner = SUBCOMMAND_FLAGS.get(misplaced)!
    console.error(`  ${c.red('✗')} ${misplaced} belongs to \`opencastle convoy ${owner}\`.`)
    console.error(`  ${c.dim('Try:')} opencastle convoy ${owner} ${args.slice(args.indexOf(misplaced)).join(' ')}`)
    process.exit(1)
  }

  if (sub.startsWith('--')) {
    renderStatus(readLastRun(process.cwd()), args.includes('--json'))
    return
  }

  // Words that plainly mean "tell me where things stand" are a status query, not
  // a feature request. `convoy status` used to spend 95 seconds generating a PRD
  // for a feature called "status" — and it is the obvious thing to type, since
  // the bare command prints a status report.
  if (['status', 'state', 'info', 'ls', 'list'].includes(sub)) {
    renderStatus(readLastRun(process.cwd()), args.includes('--json'))
    return
  }

  // Anything else is a task description: plan it, then execute. `pipeline` takes
  // it as a flag value, so name it — passing it positionally made the one command
  // this tool prints under "Start one:" fail with "Unknown option".
  await delegate('pipeline', ctx, ['--text', sub, ...passthrough])
}
