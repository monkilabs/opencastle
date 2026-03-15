import { stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { CliContext } from './types.js'
import { createConvoyStore } from './convoy/store.js'
import { analyzeDAG, formatInsightsMarkdown, formatInsightsJSON } from './convoy/dag-analysis.js'

const HELP = `
  opencastle insights [options]

  Analyze convoy execution history and generate recommendations.

  Options:
    --json           Output machine-readable JSON instead of markdown
    --since <days>   Limit analysis window (default: 90 days)
    --db <path>      Path to convoy.db (default: auto-detect)
    --help, -h       Show this help
`

/** Walk up the directory tree to find .opencastle/convoy.db. */
async function findConvoyDb(override?: string | null): Promise<string | null> {
  if (override) return override

  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, '.opencastle', 'convoy.db')
    try {
      const s = await stat(candidate)
      if (s.isFile()) return candidate
    } catch {
      // not found here — walk up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export default async function insights({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }

  let jsonMode = false
  let sinceDays = 90
  let dbOverride: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      jsonMode = true
    } else if (arg === '--since') {
      const raw = args[++i]
      const parsed = parseInt(raw, 10)
      if (isNaN(parsed) || parsed <= 0) {
        console.error('  \u2717 --since requires a positive integer (number of days)')
        process.exit(1)
      }
      sinceDays = parsed
    } else if (arg === '--db') {
      dbOverride = args[++i] ?? null
    }
  }

  const dbPath = await findConvoyDb(dbOverride)
  if (!dbPath) {
    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            patterns: [],
            agent_stats: [],
            insights: ['No execution history available yet. Run some convoys first.'],
            generated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
    } else {
      console.log('  No convoy.db found. Run some convoys first.\n')
      console.log('  Tip: convoy.db is created automatically when you run `opencastle run`.')
    }
    return
  }

  const store = createConvoyStore(dbPath)
  try {
    const rec = analyzeDAG(store, sinceDays)
    if (jsonMode) {
      console.log(formatInsightsJSON(rec))
    } else {
      console.log(formatInsightsMarkdown(rec))
    }
  } finally {
    store.close()
  }
}
