import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CliContext } from './types.js'
import { c } from './prompt.js'

const HELP = `
  opencastle agents [subcommand] [options]

  Manage persistent agent identities.

  Subcommands:
    list                     List all agent identities (agent, task count, latest date)
    inspect <agent>          Show summaries for a specific agent
    purge <agent>            Delete all identities for an agent
    compact --older-than <d> Delete identities older than N days

  Options:
    --older-than <days>      Days threshold for compact subcommand
    --yes, -y                Skip confirmation prompt
    --dry-run                Preview what would be deleted without deleting
    --help, -h               Show this help
`

interface AgentsOptions {
  subcommand: string | null
  agentName: string | null
  olderThan: number | null
  yes: boolean
  dryRun: boolean
  help: boolean
}

function parseAgentsArgs(args: string[]): AgentsOptions {
  const opts: AgentsOptions = {
    subcommand: null,
    agentName: null,
    olderThan: null,
    yes: false,
    dryRun: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--older-than':
        if (i + 1 >= args.length) { console.error('  \u2717 --older-than requires a number'); process.exit(1) }
        opts.olderThan = parseInt(args[++i], 10)
        if (!Number.isFinite(opts.olderThan) || opts.olderThan < 1) {
          console.error('  \u2717 --older-than must be a positive integer')
          process.exit(1)
        }
        break
      case '--yes':
      case '-y':
        opts.yes = true
        break
      case '--dry-run':
      case '--dryRun':
        opts.dryRun = true
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`  \u2717 Unknown option: ${arg}`)
          console.log(HELP)
          process.exit(1)
        }
        if (!opts.subcommand) {
          opts.subcommand = arg
        } else if (!opts.agentName) {
          opts.agentName = arg
        }
    }
  }

  return opts
}

export default async function agents({ args }: CliContext): Promise<void> {
  const opts = parseAgentsArgs(args)

  if (opts.help || !opts.subcommand) {
    console.log(HELP)
    return
  }

  const dbPath = resolve(process.cwd(), '.opencastle', 'convoy.db')
  if (!existsSync(dbPath)) {
    console.log('  No convoy database found at .opencastle/convoy.db')
    return
  }

  const { createConvoyStore } = await import('./convoy/store.js')
  const store = createConvoyStore(dbPath)

  try {
    switch (opts.subcommand) {
      case 'list': {
        const summaries = store.listAgentIdentitySummary()
        if (summaries.length === 0) {
          console.log('  No agent identities found.')
          return
        }
        console.log(`\n  Agent Identities (${summaries.length} agents):\n`)
        console.log(`  ${'Agent'.padEnd(25)} ${'Tasks'.padEnd(8)} Latest`)
        console.log(`  ${'\u2500'.repeat(25)} ${'\u2500'.repeat(8)} ${'\u2500'.repeat(20)}`)
        for (const s of summaries) {
          console.log(`  ${s.agent.padEnd(25)} ${String(s.task_count).padEnd(8)} ${s.latest_date}`)
        }
        console.log()
        break
      }

      case 'inspect': {
        if (!opts.agentName) {
          console.error('  \u2717 inspect requires an agent name: opencastle agents inspect <agent>')
          process.exit(1)
        }
        const identities = store.getAgentIdentities(opts.agentName, 100)
        if (identities.length === 0) {
          console.log(`  No identities found for agent "${opts.agentName}".`)
          return
        }
        console.log(`\n  Agent: ${opts.agentName} (${identities.length} identities)\n`)
        for (const id of identities) {
          console.log(`  ${c.dim('\u2500'.repeat(60))}`)
          console.log(`  Task: ${id.task_id} | Convoy: ${id.convoy_id}`)
          console.log(`  Date: ${id.created_at} | Retention: ${id.retention_days}d`)
          console.log(`  Summary:`)
          const lines = id.summary.split('\n')
          for (const line of lines.slice(0, 10)) {
            console.log(`    ${line}`)
          }
          if (lines.length > 10) {
            console.log(`    ${c.dim(`... ${lines.length - 10} more lines`)}`)
          }
          console.log()
        }
        break
      }

      case 'purge': {
        if (!opts.agentName) {
          console.error('  \u2717 purge requires an agent name: opencastle agents purge <agent>')
          process.exit(1)
        }
        const existing = store.getAgentIdentities(opts.agentName, 1000)
        if (existing.length === 0) {
          console.log(`  No identities found for agent "${opts.agentName}".`)
          return
        }
        if (opts.dryRun) {
          console.log(`  [dry-run] Would purge ${existing.length} identities for agent "${opts.agentName}"`)          
          return
        }
        if (!opts.yes) {
          console.log(`\n  This will delete ${existing.length} identities for agent "${opts.agentName}".`)
          console.log(`  Use --yes or -y to confirm.`)
          return
        }
        const deleted = store.purgeAgentIdentities(opts.agentName)
        console.log(`  \u2713 Purged ${deleted} identities for agent "${opts.agentName}".`)
        break
      }

      case 'compact': {
        if (!opts.olderThan) {
          console.error('  \u2717 compact requires --older-than <days>')
          process.exit(1)
        }
        if (opts.dryRun) {
          console.log(`  [dry-run] Would delete identities older than ${opts.olderThan} days`)
          return
        }
        const deleted = store.deleteAgentIdentitiesOlderThan(opts.olderThan)
        console.log(`  \u2713 Deleted ${deleted} identities older than ${opts.olderThan} days.`)
        break
      }

      default:
        console.error(`  \u2717 Unknown subcommand: ${opts.subcommand}`)
        console.log(HELP)
        process.exit(1)
    }
  } finally {
    store.close()
  }
}
