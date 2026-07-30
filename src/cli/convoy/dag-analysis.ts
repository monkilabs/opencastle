import type { ConvoyStore } from './store.js'
import type { ConvoyRecord, TaskRecord } from './types.js'

export interface ConvoyPattern {
  name: string
  task_count_range: [number, number]
  agent_sequence: string[]
  avg_duration_ms: number
  avg_tokens: number
  success_rate: number
  common_failure_agents: string[]
  recommended_concurrency: number
  sample_size: number
}

export interface AgentPerformance {
  agent: string
  total_tasks: number
  success_rate: number
  avg_duration_ms: number
  avg_tokens: number
  avg_retries: number
  best_file_patterns: string[]
  worst_file_patterns: string[]
}

export interface DAGRecommendation {
  patterns: ConvoyPattern[]
  agent_stats: AgentPerformance[]
  insights: string[]
  generated_at: string
}

// ── helpers ───────────────────────────────────────────────────────────────────

function taskBucket(count: number): string {
  if (count <= 2) return 'small'
  if (count <= 5) return 'medium'
  if (count <= 10) return 'large'
  return 'xlarge'
}

function extractConcurrency(specYaml: string | null | undefined): number {
  if (!specYaml) return 1
  const m = specYaml.match(/concurrency:\s*(\d+)/)
  return m ? parseInt(m[1], 10) : 1
}

function modeNum(values: number[]): number {
  if (values.length === 0) return 1
  const freq: Record<number, number> = {}
  for (const v of values) freq[v] = (freq[v] ?? 0) + 1
  let best = values[0]
  let bestFreq = 0
  for (const [k, f] of Object.entries(freq)) {
    if (f > bestFreq) { bestFreq = f; best = Number(k) }
  }
  return best
}

function filePrefix(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 2) return parts[0] ?? ''
  return parts.slice(0, 2).join('/')
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

// ── public API ────────────────────────────────────────────────────────────────

export function extractExecutionHistory(
  store: ConvoyStore,
  sinceDays = 90,
): { convoys: ConvoyRecord[]; tasks: TaskRecord[] } {
  const allConvoys = store.getConvoyList(10000, 0)
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000

  const convoys = allConvoys.filter((c) => {
    if (c.status !== 'done' && c.status !== 'failed') return false
    if (!c.finished_at) return false
    return new Date(c.finished_at).getTime() >= cutoff
  })

  const tasks: TaskRecord[] = []
  for (const convoy of convoys) {
    const convoyTasks = store.getTasksByConvoy(convoy.id)
    tasks.push(...convoyTasks)
  }

  return { convoys, tasks }
}

export function clusterConvoys(
  convoys: ConvoyRecord[],
  tasks: TaskRecord[],
): ConvoyPattern[] {
  const tasksByConvoy = new Map<string, TaskRecord[]>()
  for (const t of tasks) {
    const list = tasksByConvoy.get(t.convoy_id) ?? []
    list.push(t)
    tasksByConvoy.set(t.convoy_id, list)
  }

  type ClusterEntry = { convoys: ConvoyRecord[]; convoyTasks: TaskRecord[][] }
  const clusters = new Map<string, ClusterEntry>()

  for (const convoy of convoys) {
    const convoyTasks = tasksByConvoy.get(convoy.id) ?? []
    const count = convoyTasks.length
    const bucket = taskBucket(count)
    const agentSet = [...new Set(convoyTasks.map((t) => t.agent))].sort()
    const key = `${bucket}|${agentSet.join(',')}`

    const existing = clusters.get(key) ?? { convoys: [], convoyTasks: [] }
    existing.convoys.push(convoy)
    existing.convoyTasks.push(convoyTasks)
    clusters.set(key, existing)
  }

  const patterns: ConvoyPattern[] = []

  for (const [key, { convoys: clusterConvoys, convoyTasks }] of clusters) {
    const sepIdx = key.indexOf('|')
    const bucket = key.slice(0, sepIdx)
    const agentStr = key.slice(sepIdx + 1)
    const agentSeq = agentStr ? agentStr.split(',').filter(Boolean) : []

    const durations: number[] = []
    for (const c of clusterConvoys) {
      if (c.started_at && c.finished_at) {
        durations.push(new Date(c.finished_at).getTime() - new Date(c.started_at).getTime())
      }
    }

    const tokenValues: number[] = clusterConvoys
      .filter((c) => c.total_tokens != null)
      .map((c) => c.total_tokens as number)

    const successCount = clusterConvoys.filter((c) => c.status === 'done').length
    const successRate = clusterConvoys.length > 0 ? successCount / clusterConvoys.length : 0

    const agentFailCounts: Record<string, { failed: number; total: number }> = {}
    for (const taskList of convoyTasks) {
      for (const t of taskList) {
        const entry = agentFailCounts[t.agent] ?? { failed: 0, total: 0 }
        entry.total++
        if (t.status === 'failed') entry.failed++
        agentFailCounts[t.agent] = entry
      }
    }
    const commonFailureAgents = Object.entries(agentFailCounts)
      .filter(([, v]) => v.total > 0 && v.failed / v.total > 0.2)
      .map(([agent]) => agent)

    const successfulConvoys = clusterConvoys.filter((c) => c.status === 'done')
    const concurrencies = successfulConvoys.map((c) => extractConcurrency(c.spec_yaml))
    const recommendedConcurrency = modeNum(concurrencies.length > 0 ? concurrencies : [1])

    const counts = convoyTasks.map((tl) => tl.length)
    const bucketMinMap: Record<string, number> = { small: 1, medium: 3, large: 6, xlarge: 11 }
    const minCount = counts.length > 0 ? Math.min(...counts) : (bucketMinMap[bucket] ?? 1)
    const maxCount = counts.length > 0 ? Math.max(...counts) : 0

    const agentLabel =
      agentSeq.length === 0
        ? 'empty'
        : agentSeq.length === 1
          ? agentSeq[0]
          : agentSeq.slice(0, 2).join('-')
    const name = `${bucket}-${agentLabel}`

    patterns.push({
      name,
      task_count_range: [minCount, maxCount],
      agent_sequence: agentSeq,
      avg_duration_ms: avg(durations),
      avg_tokens: avg(tokenValues),
      success_rate: successRate,
      common_failure_agents: commonFailureAgents,
      recommended_concurrency: recommendedConcurrency,
      sample_size: clusterConvoys.length,
    })
  }

  return patterns
}

export function analyzeAgentPerformance(tasks: TaskRecord[]): AgentPerformance[] {
  const byAgent = new Map<string, TaskRecord[]>()
  for (const t of tasks) {
    const list = byAgent.get(t.agent) ?? []
    list.push(t)
    byAgent.set(t.agent, list)
  }

  const results: AgentPerformance[] = []

  for (const [agent, agentTasks] of byAgent) {
    const totalTasks = agentTasks.length
    const doneCount = agentTasks.filter((t) => t.status === 'done').length
    const successRate = totalTasks > 0 ? doneCount / totalTasks : 0

    const durations = agentTasks
      .filter((t) => t.started_at != null && t.finished_at != null)
      .map((t) => new Date(t.finished_at!).getTime() - new Date(t.started_at!).getTime())

    const tokenValues = agentTasks
      .filter((t) => t.total_tokens != null)
      .map((t) => t.total_tokens as number)

    const avgRetries = avg(agentTasks.map((t) => t.retries))

    const prefixStats = new Map<string, { done: number; total: number }>()
    for (const t of agentTasks) {
      if (!t.files) continue
      let fileList: string[]
      try {
        fileList = JSON.parse(t.files) as string[]
      } catch {
        continue
      }
      if (!Array.isArray(fileList)) continue
      for (const f of fileList) {
        const prefix = filePrefix(f)
        if (!prefix) continue
        const entry = prefixStats.get(prefix) ?? { done: 0, total: 0 }
        entry.total++
        if (t.status === 'done') entry.done++
        prefixStats.set(prefix, entry)
      }
    }

    const eligiblePrefixes = [...prefixStats.entries()].filter(([, v]) => v.total >= 2)
    const sorted = eligiblePrefixes.sort(([, a], [, b]) => b.done / b.total - a.done / a.total)

    const bestFilePatterns = sorted
      .filter(([, v]) => v.done / v.total >= 0.8)
      .slice(0, 3)
      .map(([prefix]) => prefix)

    const worstFilePatterns = [...sorted]
      .reverse()
      .filter(([, v]) => v.done / v.total <= 0.5)
      .slice(0, 3)
      .map(([prefix]) => prefix)

    results.push({
      agent,
      total_tasks: totalTasks,
      success_rate: successRate,
      avg_duration_ms: avg(durations),
      avg_tokens: avg(tokenValues),
      avg_retries: avgRetries,
      best_file_patterns: bestFilePatterns,
      worst_file_patterns: worstFilePatterns,
    })
  }

  return results
}

export function generateInsights(
  patterns: ConvoyPattern[],
  agents: AgentPerformance[],
): string[] {
  if (patterns.length === 0 && agents.length === 0) {
    return ['No execution history available yet. Run some convoys first.']
  }

  const insights: string[] = []

  for (const agent of agents) {
    const ratePct = Math.round(agent.success_rate * 100)
    if (agent.success_rate < 0.7) {
      insights.push(
        `⚠️ ${agent.agent} has a ${ratePct}% success rate — consider splitting tasks smaller or providing more context`,
      )
    }
    if (agent.avg_retries > 1.5) {
      insights.push(
        `⚠️ ${agent.agent} has a ${agent.avg_retries.toFixed(1)}x average retry rate — investigate common failure causes`,
      )
    }
    if (agent.best_file_patterns.length > 0) {
      const bestRate = Math.round(agent.success_rate * 100)
      insights.push(
        `✓ ${agent.agent} excels on ${agent.best_file_patterns.join(', ')} (${bestRate}% success rate)`,
      )
    }
    if (agent.success_rate === 1 && agent.total_tasks >= 3) {
      insights.push(
        `✓ ${agent.agent} has 100% success — auto-PASS review may be safe`,
      )
    }
  }

  for (const pattern of patterns) {
    const durationMin = Math.round(pattern.avg_duration_ms / 60000)
    insights.push(
      `Convoys with ${pattern.task_count_range[0]}–${pattern.task_count_range[1]} tasks perform best at concurrency ${pattern.recommended_concurrency} (avg ${durationMin}min)`,
    )
  }

  return insights
}

export function analyzeDAG(
  store: ConvoyStore,
  sinceDays?: number,
): DAGRecommendation {
  const { convoys, tasks } = extractExecutionHistory(store, sinceDays)
  const patterns = clusterConvoys(convoys, tasks)
  const agent_stats = analyzeAgentPerformance(tasks)
  const insights = generateInsights(patterns, agent_stats)

  return {
    patterns,
    agent_stats,
    insights,
    generated_at: new Date().toISOString(),
  }
}

export function formatInsightsMarkdown(rec: DAGRecommendation): string {
  const lines: string[] = []

  lines.push('## Convoy Patterns\n')
  if (rec.patterns.length === 0) {
    lines.push('_No pattern data available._\n')
  } else {
    lines.push('| Name | Task Range | Success Rate | Concurrency | Samples |')
    lines.push('|------|-----------|-------------|-------------|---------|')
    for (const p of rec.patterns) {
      const rate = `${Math.round(p.success_rate * 100)}%`
      lines.push(
        `| ${p.name} | ${p.task_count_range[0]}–${p.task_count_range[1]} | ${rate} | ${p.recommended_concurrency} | ${p.sample_size} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Agent Performance\n')
  if (rec.agent_stats.length === 0) {
    lines.push('_No agent data available._\n')
  } else {
    lines.push('| Agent | Tasks | Success Rate | Avg Duration | Avg Retries |')
    lines.push('|-------|-------|-------------|-------------|-------------|')
    for (const a of rec.agent_stats) {
      const rate = `${Math.round(a.success_rate * 100)}%`
      const dur = a.avg_duration_ms > 0 ? `${Math.round(a.avg_duration_ms / 1000)}s` : '—'
      lines.push(
        `| ${a.agent} | ${a.total_tasks} | ${rate} | ${dur} | ${a.avg_retries.toFixed(1)} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Recommendations\n')
  for (const insight of rec.insights) {
    lines.push(`- ${insight}`)
  }

  return lines.join('\n')
}
