import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface EtlOptions {
  dbPath: string
  outputDir: string
  verbose?: boolean
}

export interface EtlResult {
  convoyCount: number
}

const EMPTY_OVERALL_STATS = {
  convoyCounts: { total: 0, running: 0, done: 0, failed: 0, gate_failed: 0 },
  durationStats: { avg_sec: null, p95_sec: null, max_sec: null },
  tokenCostTotals: { total_tokens: 0, total_cost_usd: 0 },
  topAgents: [] as unknown[],
  topModels: [] as unknown[],
  dlqSummary: { count: 0, top_failure_types: [] as unknown[] },
  taskTotals: { totalTasks: 0, totalRetries: 0 },
  activityTimeline: [] as Array<{ date: string; count: number }>,
}

export async function runEtl(options: EtlOptions): Promise<EtlResult> {
  const { dbPath, outputDir } = options

  mkdirSync(outputDir, { recursive: true })

  if (!existsSync(dbPath)) {
    console.warn(`  \u26a0 No convoy database found at ${dbPath}. Writing empty JSON files.`)
    writeFileSync(
      resolve(outputDir, 'overall-stats.json'),
      JSON.stringify(EMPTY_OVERALL_STATS, null, 2),
      'utf8',
    )
    writeFileSync(resolve(outputDir, 'convoy-list.json'), JSON.stringify([], null, 2), 'utf8')
    return { convoyCount: 0 }
  }

  const { createConvoyStore } = await import('../../cli/convoy/store.js')
  const store = createConvoyStore(dbPath)

  try {
    const overallStats = {
      convoyCounts: store.getConvoyCounts(),
      durationStats: store.getConvoyDurationStats(),
      tokenCostTotals: store.getTokenAndCostTotals(),
      topAgents: store.getTopAgents(5),
      topModels: store.getTopModels(5),
      dlqSummary: store.getDlqSummary(),
      taskTotals: { totalTasks: 0, totalRetries: 0 },
      activityTimeline: [] as Array<{ date: string; count: number }>,
    }
    const allConvoys = store.getConvoyList(1000, 0)
    const dateCountMap = new Map<string, number>()
    for (const c of allConvoys) {
      const dateKey = c.created_at ? c.created_at.slice(0, 10) : null
      if (dateKey) dateCountMap.set(dateKey, (dateCountMap.get(dateKey) || 0) + 1)
    }
    overallStats.activityTimeline = Array.from(dateCountMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const uniquePipelineIds = [...new Set(allConvoys.map(c => c.pipeline_id).filter(Boolean))] as string[]
    const pipelineNames = new Map<string, string>()
    for (const pid of uniquePipelineIds) {
      const pipeline = store.getPipeline(pid)
      if (pipeline?.name) pipelineNames.set(pid, pipeline.name)
    }
    const convoyList = allConvoys.map(c => {
      const taskCount = store.getTasksByConvoy(c.id).length
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        created_at: c.created_at,
        started_at: c.started_at,
        finished_at: c.finished_at,
        total_tokens: c.total_tokens,
        total_cost_usd: c.total_cost_usd,
        task_count: taskCount,
        pipeline_id: c.pipeline_id || null,
        pipeline_name: c.pipeline_id ? (pipelineNames.get(c.pipeline_id) || null) : null,
      }
    })
    writeFileSync(
      resolve(outputDir, 'convoy-list.json'),
      JSON.stringify(convoyList, null, 2),
      'utf8',
    )

    mkdirSync(resolve(outputDir, 'convoys'), { recursive: true })
    let detailCount = 0
    let totalTasks = 0
    let totalRetries = 0
    for (const c of allConvoys) {
      const detail = store.getConvoyDetails(c.id)
      if (detail) {
        for (const t of detail.tasks) {
          totalTasks++
          totalRetries += t.retries
        }
        writeFileSync(
          resolve(outputDir, 'convoys', c.id + '.json'),
          JSON.stringify(detail, null, 2),
          'utf8',
        )
        detailCount++
      }
    }

    overallStats.taskTotals = { totalTasks, totalRetries }
    writeFileSync(
      resolve(outputDir, 'overall-stats.json'),
      JSON.stringify(overallStats, null, 2),
      'utf8',
    )

    if (options.verbose) {
      console.log(`ETL complete: ${allConvoys.length} convoys summarized, ${detailCount} detail files generated.`)
    }

    return { convoyCount: allConvoys.length }
  } finally {
    store.close()
  }
}

function parseArgs(): { db?: string; out?: string; events?: string; verbose?: boolean } {
  const args = process.argv.slice(2)
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--db' && args[i+1]) { result.db = args[++i] }
    else if (a === '--out' && args[i+1]) { result.out = args[++i] }
    else if (a === '--events' && args[i+1]) { result.events = args[++i] }
    else if (a === '--verbose') { result.verbose = true }
  }
  return result as { db?: string; out?: string; events?: string; verbose?: boolean }
}

const isMain =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  const parsed = parseArgs()
  const dbPath = parsed.db != null ? resolve(process.cwd(), parsed.db) : resolve(process.cwd(), '.opencastle', 'convoy.db')
  const outputDir = parsed.out != null ? resolve(process.cwd(), parsed.out) : resolve(__dirname, '..', 'public', 'data')
  runEtl({ dbPath, outputDir, verbose: parsed.verbose }).then(() => {
    if (parsed.events) {
      const eventsPath = resolve(process.cwd(), parsed.events)
      const dest = resolve(outputDir, 'events.ndjson')
      if (existsSync(eventsPath)) {
        copyFileSync(eventsPath, dest)
        console.log(`Events copied: ${eventsPath} → ${dest}`)
      } else {
        console.warn(`⚠ Events file not found: ${eventsPath}`)
      }
    }
  }).catch((err: unknown) => {
    console.error('ETL failed:', (err as Error).message)
    process.exit(1)
  })
}