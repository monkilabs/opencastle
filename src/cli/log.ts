import { mkdir, appendFile, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import * as v from 'valibot'
import { TIER_IDS } from './tiers.js'
import { nearest } from './nearest.js'
import type { CliContext } from './types.js'

/**
 * `opencastle log` — append one agent record to `.opencastle/logs/events.ndjson`.
 *
 * Agents call this from generated instructions, so a record it accepts is a
 * record every reader of the log has to cope with. It used to accept anything:
 * `--type session` with no fields, `--outcome banana`, a value-less `--model`
 * stored as `true`, `--task 007` stored as the number 7, `--agnet`, and a
 * caller-supplied `--timestamp yesterday`. Each record type is now checked
 * against the schema in `skills/observability-logging/LOG-SCHEMA.md`, field by field, and a
 * record that does not match is refused with every reason at once.
 */

type Kind = 'text' | 'count' | 'number' | 'boolean' | 'list'

interface Field {
  kind: Kind
  required: boolean
  /** The only values a text field may take. */
  values?: readonly string[]
  /** Smallest value of a count. */
  min?: number
}

const req = (kind: Kind, values?: readonly string[]): Field => ({ kind, required: true, values })
const opt = (kind: Kind, values?: readonly string[]): Field => ({ kind, required: false, values })
const attempt: Field = { kind: 'count', required: true, min: 1 }

const OUTCOMES = ['success', 'partial', 'failed'] as const

/** The record schemas, as `skills/observability-logging/LOG-SCHEMA.md` documents them. `log.test.ts` holds the two together. */
export const LOG_RECORDS: Record<string, Record<string, Field>> = {
  session: {
    agent: req('text'),
    model: opt('text'),
    task: req('text'),
    tracker_issue: opt('text'),
    outcome: req('text', OUTCOMES),
    duration_min: opt('number'),
    files_changed: opt('count'),
    retries: opt('count'),
    lessons_added: opt('list'),
    discoveries: opt('list'),
  },
  delegation: {
    session_id: req('text'),
    agent: req('text'),
    model: opt('text'),
    tier: req('text', TIER_IDS),
    mechanism: req('text', ['sub-agent', 'background']),
    tracker_issue: opt('text'),
    outcome: req('text', [...OUTCOMES, 'redirected']),
    retries: opt('count'),
    phase: opt('count'),
    file_partition: opt('list'),
  },
  review: {
    tracker_issue: opt('text'),
    agent: req('text'),
    reviewer_model: opt('text'),
    verdict: req('text', ['pass', 'fail']),
    attempt,
    issues_critical: req('count'),
    issues_major: req('count'),
    issues_minor: req('count'),
    confidence: req('text', ['low', 'medium', 'high']),
    escalated: req('boolean'),
    duration_sec: opt('number'),
  },
  panel: {
    panel_key: req('text'),
    verdict: req('text', ['pass', 'block']),
    pass_count: req('count'),
    block_count: req('count'),
    must_fix: req('count'),
    should_fix: req('count'),
    reviewer_model: opt('text'),
    weighted: req('boolean'),
    attempt,
    tracker_issue: opt('text'),
    artifacts_count: opt('count'),
    report_path: opt('text'),
  },
  dispute: {
    dispute_id: req('text'),
    tracker_issue: opt('text'),
    priority: req('text', ['critical', 'high', 'medium', 'low']),
    trigger: req('text', ['panel-3x-block', 'approach-conflict', 'criteria-conflict', 'architectural-ambiguity', 'external-dependency']),
    implementing_agent: req('text'),
    reviewing_agents: req('list'),
    total_attempts: req('count'),
    est_tokens_spent: opt('count'),
    status: req('text', ['pending', 'resolved', 'deferred']),
    resolution_option_chosen: opt('text'),
    resolved_at: opt('text'),
  },
}

const TYPES = Object.keys(LOG_RECORDS)

type AnySchema = v.GenericSchema<unknown>

function schemaFor(field: Field): AnySchema {
  const text = v.pipe(v.string(), v.nonEmpty())
  const base: AnySchema =
    field.kind === 'text'
      ? field.values ? v.picklist(field.values as string[]) : text
      : field.kind === 'count'
        ? v.pipe(v.number(), v.integer(), v.minValue(field.min ?? 0))
        : field.kind === 'number'
          ? v.pipe(v.number(), v.minValue(0))
          : field.kind === 'boolean'
            ? v.boolean()
            : v.pipe(v.array(text), v.minLength(1))
  return field.required ? base : v.optional(base)
}

const SCHEMAS: Record<string, AnySchema> = Object.fromEntries(
  Object.entries(LOG_RECORDS).map(([type, fields]) => [
    type,
    v.strictObject(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, schemaFor(f)]))),
  ]),
)

/** What a field accepts, in words, for error messages and help. */
function describe(field: Field): string {
  if (field.values) return `one of ${field.values.join(', ')}`
  switch (field.kind) {
    case 'count': return field.min ? `a whole number, at least ${field.min}` : 'a whole number, 0 or more'
    case 'number': return 'a number, 0 or more'
    case 'boolean': return 'true or false'
    case 'list': return 'a comma-separated list'
    default: return 'text'
  }
}

const OWN_FLAGS = ['--type', '--logs-dir', '--dry-run', '--help']

/**
 * Turn one argv value into the field's type.
 *
 * Only numeric fields become numbers. Every id and text field stays exactly as
 * typed, so `--session_id 2024` and `--task 007` are the strings "2024" and "007".
 */
function convert(raw: string, field: Field | undefined): unknown {
  switch (field?.kind) {
    case 'count':
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw
    case 'list':
      return raw.split(',').map((s) => s.trim()).filter(Boolean)
    default:
      return raw
  }
}

export type ParsedLog =
  | { ok: true; help: true }
  | { ok: true; help: false; record: Record<string, unknown>; logsDir: string | null; dryRun: boolean }
  | { ok: false; errors: string[]; type: string | null }

/** Read `opencastle log` arguments into a checked record, or every reason it is not one. */
export function parseLogArgs(args: string[], now: Date = new Date()): ParsedLog {
  const errors: string[] = []
  const given = new Map<string, string>()
  // Fields already reported for how they were passed; the schema check need not repeat them.
  const reported = new Set<string>()
  let type: string | null = null
  let logsDir: string | null = null
  let dryRun = false

  // First pass: the type decides which fields are known, wherever --type appears.
  const typeAt = args.indexOf('--type')
  const typeGuess = typeAt >= 0 ? args[typeAt + 1] : undefined
  const fields = typeGuess && typeGuess in LOG_RECORDS ? LOG_RECORDS[typeGuess] : null
  const knownFields = fields ? Object.keys(fields) : [...new Set(Object.values(LOG_RECORDS).flatMap((f) => Object.keys(f)))]

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') return { ok: true, help: true }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (!arg.startsWith('--')) {
      errors.push(`Unexpected "${arg}". Every value follows its --field; quote values that contain spaces.`)
      continue
    }
    const key = arg.slice(2)
    const value = args[i + 1]
    // A flag needs a value. One followed by another flag, or by nothing, used to
    // be stored as `true` — a `--model` whose variable was empty became a model
    // named true.
    const missing = value === undefined || value.startsWith('--')
    if (!missing) i++

    if (key === 'timestamp') {
      errors.push('--timestamp is not accepted: opencastle log sets the timestamp itself.')
      continue
    }
    const isOwn = key === 'type' || key === 'logs-dir'
    if (!isOwn && !knownFields.includes(key)) {
      const suggestion = nearest(key, [...knownFields, ...OWN_FLAGS.map((f) => f.slice(2))])
      const where = fields ? `a ${typeGuess} record` : 'any record type'
      errors.push(`Unknown option --${key} for ${where}.${suggestion ? ` Did you mean --${suggestion}?` : ''}`)
      continue
    }
    if (missing) {
      errors.push(`--${key} needs a value.`)
      reported.add(key)
      continue
    }
    if (value.trim() === '') {
      errors.push(`--${key} cannot be empty. Leave it out instead when there is nothing to record.`)
      reported.add(key)
      continue
    }
    if (key === 'type') type = value
    else if (key === 'logs-dir') logsDir = value
    else if (given.has(key)) errors.push(`--${key} is given twice.`)
    else given.set(key, value)
  }

  if (!type) {
    errors.unshift(`--type is required: one of ${TYPES.join(', ')}.`)
    return { ok: false, errors, type: null }
  }
  if (!(type in LOG_RECORDS)) {
    const suggestion = nearest(type, TYPES)
    errors.unshift(`--type "${type}" is not a record type: one of ${TYPES.join(', ')}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`)
    return { ok: false, errors, type: null }
  }

  const schema = LOG_RECORDS[type]
  const values: Record<string, unknown> = {}
  for (const [key, raw] of given) values[key] = convert(raw, schema[key])

  const result = v.safeParse(SCHEMAS[type], values)
  if (!result.success) {
    for (const issue of result.issues) {
      const key = String(issue.path?.[0]?.key ?? '')
      if (!key || reported.has(key)) continue
      reported.add(key)
      const field = schema[key]
      if (!field) continue
      errors.push(
        given.has(key)
          ? `--${key} must be ${describe(field)}, not "${given.get(key)}".`
          : `--${key} is required${field.kind === 'text' && !field.values ? '' : `: ${describe(field)}`}.`,
      )
    }
  }
  if (errors.length > 0) return { ok: false, errors, type }

  // Fields in the order they were given, after the two every record starts with.
  const record: Record<string, unknown> = { type, timestamp: now.toISOString() }
  for (const key of given.keys()) record[key] = values[key]
  return { ok: true, help: false, record, logsDir, dryRun }
}

function fieldList(fields: Record<string, Field>): string {
  const words = Object.entries(fields).map(([k, f]) => `${f.required ? '*' : ''}${k}${f.values ? `=${f.values.join('|')}` : ''}`)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + w.length + 1 > 62) {
      lines.push(line)
      line = w
    } else {
      line = line ? `${line} ${w}` : w
    }
  }
  if (line) lines.push(line)
  return lines.join('\n                 ')
}

const HELP = `
  opencastle log --type <type> --<field> <value> ...

  Append one record to .opencastle/logs/events.ndjson. Each record is checked
  against its schema; a record that does not match is refused, with every
  reason. opencastle log sets the timestamp itself.

  Options:
    --type <type>        ${TYPES.join(' | ')}
    --<field> <value>    A field of that record type (below)
    --logs-dir <path>    Write to another logs directory
    --dry-run            Print the record without writing it
    --help, -h           Show this help

  Fields (* required):
${Object.entries(LOG_RECORDS).map(([t, f]) => `    ${t.padEnd(12)} ${fieldList(f)}`).join('\n')}

  Lists are comma-separated. Booleans are true or false. Leave out a field you
  have no value for; an empty value is refused.

  Examples:
    opencastle log --type session --agent Developer --task "Fix bug" --outcome success
    opencastle log --type delegation --session_id feat/prj-1 --agent Developer --tier standard --mechanism sub-agent --outcome success
`

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
  const parsed = parseLogArgs(args)
  if (parsed.ok && parsed.help) {
    console.log(HELP)
    return
  }
  if (!parsed.ok) {
    const what = parsed.type ? `a ${parsed.type} record` : 'this record'
    console.error(`  ✗ opencastle log refused ${what}:`)
    for (const e of parsed.errors) console.error(`    ${e}`)
    console.error('  Run "opencastle log --help" for the fields of each record type.')
    process.exit(1)
  }

  if (parsed.dryRun) {
    console.log(`  [dry-run] Would append to events.ndjson:`)
    console.log(JSON.stringify(parsed.record))
    return
  }

  try {
    await appendEvent(parsed.record, parsed.logsDir)
    console.log(JSON.stringify(parsed.record))
  } catch (err: unknown) {
    console.error(`  ✗ Failed to write log: ${(err as Error).message}`)
    process.exit(1)
  }
}
