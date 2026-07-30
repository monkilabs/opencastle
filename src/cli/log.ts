import { mkdir, appendFile, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { CliContext } from './types.js'

const HELP = `
  opencastle log [options]

  Append a structured event to the observability log (events.ndjson).

  Options:
    --type <type>          Event type (required): session|delegation|review|panel|dispute
    --<field> <value>      Any field from the event schema (see documentation)
    --logs-dir <path>      Override the logs directory path
    --dry-run              Preview what would be logged without writing
    --help, -h             Show this help

  Array fields (comma-separated): file_partition, lessons_added, discoveries, reviewing_agents
  Boolean fields: escalated, weighted
  Numeric fields: auto-detected from value

  Examples:
    opencastle log --type session --agent Developer --task "Fix bug" --outcome success
    opencastle log --type delegation --session_id feat/prj-1 --agent Developer --tier standard --mechanism sub-agent --outcome success
    opencastle log --type panel --panel_key auth-review --verdict pass --pass_count 3 --block_count 0
`

const VALID_TYPES = ['session', 'delegation', 'review', 'panel', 'dispute']

const ARRAY_FIELDS = new Set([
  'file_partition',
  'lessons_added',
  'discoveries',
  'reviewing_agents',
])

const BOOLEAN_FIELDS = new Set(['escalated', 'weighted'])

function coerceValue(key: string, raw: string): unknown {
  if (ARRAY_FIELDS.has(key)) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (BOOLEAN_FIELDS.has(key)) return raw === 'true'
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/** Resolve the path to the logs directory (walks up to find .opencastle/). */
async function resolveLogsDir(override?: string | null): Promise<string> {
  if (override) return override
  let dir = process.cwd()
  for (;;) {
    try {
      const s = await stat(join(dir, '.opencastle'))
      if (s.isDirectory()) return join(dir, '.opencastle', 'logs')
    } catch {
      // .opencastle not in this directory, walk up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), '.opencastle', 'logs')
}

/** Append a structured event record to events.ndjson. */
export async function appendEvent(
  record: Record<string, unknown>,
  logsDir?: string | null,
): Promise<void> {
  const resolvedDir = await resolveLogsDir(logsDir ?? null)
  const eventsFile = join(resolvedDir, 'events.ndjson')
  await mkdir(resolvedDir, { recursive: true })
  const line = JSON.stringify(record)
  // Ensure file ends with a newline before appending to prevent record concatenation
  let prefix = ''
  try {
    const existing = await readFile(eventsFile, 'utf8')
    if (existing.length > 0 && !existing.endsWith('\n')) {
      prefix = '\n'
    }
  } catch {
    // File doesn't exist yet — no prefix needed
  }
  await appendFile(eventsFile, prefix + line + '\n', 'utf8')
}

export default async function log({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }

  const dryRun = args.includes('--dry-run') || args.includes('--dryRun')
  let type: string | null = null
  let logsDir: string | null = null
  const fields: Record<string, unknown> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--type':
        if (i + 1 >= args.length) { console.error('  \u2717 --type requires a value'); process.exit(1) }
        type = args[++i]
        if (!type.trim()) { console.error('  \u2717 --type cannot be empty'); process.exit(1) }
        break
      case '--logs-dir':
        if (i + 1 >= args.length) { console.error('  \u2717 --logs-dir requires a path'); process.exit(1) }
        logsDir = args[++i]
        if (!logsDir.trim()) { console.error('  \u2717 --logs-dir cannot be empty'); process.exit(1) }
        break
      default:
        if (arg.startsWith('--')) {
          const key = arg.slice(2)
          const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
          if (DANGEROUS_KEYS.has(key)) break
          const next = args[i + 1]
          if (next === undefined || next.startsWith('--')) {
            fields[key] = true
          } else {
            const raw = args[++i]
            if (!raw.trim()) { console.error(`  \u2717 --${key} cannot be empty`); process.exit(1) }
            fields[key] = coerceValue(key, raw)
          }
        }
    }
  }

  if (!type) {
    console.error('  \u2717 --type is required. Use one of: session, delegation, review, panel, dispute')
    console.error('  Run "opencastle log --help" for usage.')
    process.exit(1)
  }

  if (!VALID_TYPES.includes(type)) {
    console.error(`  \u2717 Invalid --type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`)
    process.exit(1)
  }

  const timestamp = (fields['timestamp'] as string | undefined) ?? new Date().toISOString()
  delete fields['timestamp']
  const record = { type, timestamp, ...fields }

  if (dryRun) {
    console.log(`  [dry-run] Would append to events.ndjson:`)
    console.log(JSON.stringify(record))
    return
  }

  try {
    await appendEvent(record, logsDir)
    console.log(JSON.stringify(record))
  } catch (err: unknown) {
    console.error(`  ✗ Failed to write log: ${(err as Error).message}`)
    process.exit(1)
  }
}

