import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { TaskSpec, AgentAdapter } from './convoy/spec-types.js'
import type { ConvoyResult } from './convoy/engine.js'
import type { WatchConfig } from './convoy/types.js'
import { parseTaskSpecText, parseYaml } from './run/schema.js'
import { c } from './prompt.js'

export interface WatchLoopOptions {
  spec: TaskSpec
  specText: string
  specPath: string
  adapter: AgentAdapter
  verbose: boolean
  pidPath: string
  clearScratchpad: boolean
  watchConfigPath: string | null
  printResult: (result: ConvoyResult) => void
}

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    const all: number[] = []
    for (let i = min; i <= max; i++) all.push(i)
    return all
  }
  const values: number[] = []
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      if (!Number.isFinite(step) || step < 1) continue
      let start = min
      let end = max
      if (rangeStr !== '*') {
        const [s, e] = rangeStr.split('-').map(Number)
        start = s
        end = e ?? s
      }
      for (let i = start; i <= end; i += step) values.push(i)
    } else if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number)
      for (let i = s; i <= e; i++) values.push(i)
    } else {
      const n = parseInt(part, 10)
      if (Number.isFinite(n)) values.push(n)
    }
  }
  return values
}

function cronMatches(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [minF, hourF, domF, monF, dowF] = parts
  const minute = parseCronField(minF, 0, 59)
  const hour = parseCronField(hourF, 0, 23)
  const dom = parseCronField(domF, 1, 31)
  const mon = parseCronField(monF, 1, 12)
  const dow = parseCronField(dowF, 0, 6)
  return (
    minute.includes(date.getMinutes()) &&
    hour.includes(date.getHours()) &&
    dom.includes(date.getDate()) &&
    mon.includes(date.getMonth() + 1) &&
    dow.includes(date.getDay())
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function watchLoop(options: WatchLoopOptions): Promise<void> {
  const {
    spec,
    specText,
    specPath,
    adapter,
    verbose,
    pidPath,
    clearScratchpad,
    watchConfigPath,
    printResult,
  } = options

  // Resolve watch config — from --watch-config file, spec.watch, or default file-change
  let watchConfig: WatchConfig
  if (watchConfigPath) {
    const raw = readFileSync(watchConfigPath, 'utf8')
    const parsed = parseYaml(raw) as Record<string, unknown>
    watchConfig = parsed as unknown as WatchConfig
  } else if (spec.watch) {
    watchConfig = spec.watch
  } else {
    // Default: file-change trigger on the spec file itself
    watchConfig = {
      triggers: [{ type: 'file-change', glob: specPath, debounce_ms: 500 }],
    }
  }

  // Write PID file
  mkdirSync(dirname(pidPath), { recursive: true })
  writeFileSync(pidPath, String(process.pid), 'utf8')

  let shuttingDown = false
  let currentRun: Promise<ConvoyResult> | null = null
  let cycleNumber = 0

  // Graceful shutdown handlers
  function onShutdownSignal(): void {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n  ${c.yellow('\u26a0')} Watch mode shutting down...`)
    // If a run is in progress, we let it finish
    if (!currentRun) {
      cleanup()
      process.exit(0)
    }
  }

  process.on('SIGTERM', onShutdownSignal)
  process.on('SIGINT', onShutdownSignal)

  function cleanup(): void {
    try { unlinkSync(pidPath) } catch { /* ignore */ }
    process.removeListener('SIGTERM', onShutdownSignal)
    process.removeListener('SIGINT', onShutdownSignal)
  }

  // Emit watch_started
  const { createConvoyStore } = await import('./convoy/store.js')
  const { createEventEmitter } = await import('./convoy/events.js')
  const dbPath = resolve(process.cwd(), '.opencastle', 'convoy.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const evtStore = createConvoyStore(dbPath)
  const watchEvents = createEventEmitter(evtStore)

  const triggerTypes = watchConfig.triggers.map(t => t.type).join(',')
  watchEvents.emit('watch_started', { trigger_type: triggerTypes, pid: process.pid })

  // Clear scratchpad if requested
  if (clearScratchpad || watchConfig.clear_scratchpad) {
    evtStore.clearScratchpad()
  }

  console.log(`\n  ${c.cyan('\ud83d\udc41')} Watch mode active (PID: ${process.pid})`)
  console.log(`  Triggers: ${watchConfig.triggers.map(t => t.type).join(', ')}`)

  // Set up trigger watchers
  let triggerFired = false
  let triggerSource = ''
  const triggerCleanups: Array<() => void> = []

  for (const trigger of watchConfig.triggers) {
    if (trigger.type === 'file-change') {
      const { watch } = await import('node:fs')
      const debounceMs = trigger.debounce_ms ?? 500
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      const globPattern = trigger.glob ?? '**/*'
      const watcher = watch(resolve(process.cwd()), { recursive: true }, (_event, filename) => {
        if (!filename) return
        const globStr = globPattern
        let matches = false
        if (globStr.includes('*')) {
          // Convert simple glob to regex
          const re = new RegExp('^' + globStr.replace(/\./g, '\\.').replace(/\*\*/g, '\u29bf').replace(/\*/g, '[^/]*').replace(/\u29bf/g, '.*') + '$')
          matches = re.test(filename)
        } else {
          matches = filename === globStr || filename.endsWith('/' + globStr)
        }
        if (matches) {
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            triggerFired = true
            triggerSource = `file-change:${filename}`
          }, debounceMs)
        }
      })
      triggerCleanups.push(() => { watcher.close(); if (debounceTimer) clearTimeout(debounceTimer) })
    } else if (trigger.type === 'cron') {
      // Poll every 30s to check if cron matches
      let lastFired = -1
      const interval = setInterval(() => {
        const now = new Date()
        const minuteKey = now.getFullYear() * 525600 + now.getMonth() * 43800 + now.getDate() * 1440 + now.getHours() * 60 + now.getMinutes()
        if (minuteKey !== lastFired && cronMatches(trigger.schedule!, now)) {
          lastFired = minuteKey
          triggerFired = true
          triggerSource = `cron:${trigger.schedule}`
        }
      }, 30_000)
      triggerCleanups.push(() => clearInterval(interval))
    } else if (trigger.type === 'git-push') {
      // Poll git remote every 60s
      let lastRef = ''
      const { execFile: execFileCb } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFileCb)
      const interval = setInterval(async () => {
        try {
          await execFileAsync('git', ['fetch', '--quiet'], { cwd: process.cwd() })
          const { stdout } = await execFileAsync('git', ['rev-parse', 'FETCH_HEAD'], { cwd: process.cwd() })
          const ref = stdout.trim()
          if (lastRef && ref !== lastRef) {
            triggerFired = true
            triggerSource = `git-push:${ref.slice(0, 8)}`
          }
          lastRef = ref
        } catch { /* ignore fetch errors */ }
      }, 60_000)
      triggerCleanups.push(() => clearInterval(interval))
    }
  }

  // Main watch loop
  try {
    while (!shuttingDown) {
      // Wait for a trigger
      while (!triggerFired && !shuttingDown) {
        await sleep(500)
      }

      if (shuttingDown) break
      triggerFired = false

      cycleNumber++
      console.log(`\n  ${c.cyan('\u27f3')} Watch cycle ${cycleNumber} triggered by: ${triggerSource}`)

      // Retention cleanup of agent identities
      try {
        evtStore.deleteAgentIdentitiesOlderThan(90)
      } catch { /* non-critical */ }

      // Scratchpad retention cleanup
      if (watchConfig.scratchpad_retention_days) {
        try {
          evtStore.clearScratchpadOlderThan(watchConfig.scratchpad_retention_days)
        } catch { /* non-critical */ }
      }

      watchEvents.emit('watch_cycle_start', { cycle_number: cycleNumber, triggered_by: triggerSource })

      // Re-read spec from disk (may have changed since last cycle)
      let cycleSpec: TaskSpec
      let cycleSpecText: string
      try {
        cycleSpecText = readFileSync(specPath, 'utf8')
        cycleSpec = parseTaskSpecText(cycleSpecText)
        // Apply overrides from original spec
        if (spec.concurrency !== 1) cycleSpec.concurrency = spec.concurrency
        if (spec.adapter) cycleSpec.adapter = spec.adapter
        if (verbose) cycleSpec._verbose = true
      } catch (err) {
        console.error(`  ${c.red('\u2717')} Failed to re-read spec: ${(err as Error).message}`)
        watchEvents.emit('watch_cycle_end', { cycle_number: cycleNumber, status: 'error' })
        continue
      }

      // Run convoy
      const { createConvoyEngine } = await import('./convoy/engine.js')
      const cycleEngine = createConvoyEngine({
        spec: cycleSpec,
        specYaml: cycleSpecText,
        adapter,
        verbose,
      })

      let cycleResult: ConvoyResult
      try {
        currentRun = cycleEngine.run()
        cycleResult = await currentRun
        currentRun = null
      } catch (err) {
        currentRun = null
        console.error(`  ${c.red('\u2717')} Cycle ${cycleNumber} failed: ${(err as Error).message}`)
        watchEvents.emit('watch_cycle_end', { cycle_number: cycleNumber, status: 'error' })
        continue
      }

      printResult(cycleResult)
      watchEvents.emit('watch_cycle_end', { cycle_number: cycleNumber, status: cycleResult.status })

      if (shuttingDown) break
    }
  } finally {
    // Clean up
    watchEvents.emit('watch_stopped', { reason: shuttingDown ? 'signal' : 'exit' })
    watchEvents.close()
    evtStore.close()
    for (const fn of triggerCleanups) {
      try { fn() } catch { /* ignore */ }
    }
    cleanup()
  }
}
