import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConvoyStore } from './store.js'
import { KNOWN_EVENT_TYPES } from './types.js'
import type { ConvoyEventType } from './types.js'
import { validateEventData } from './event-schemas.js'
import { redactValue } from './redact.js'

const RESERVED_KEYS = new Set(['_event_id', 'convoy_id', 'task_id', 'worker_id', 'timestamp', 'type'])

export function validateEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type)
}

export function ndjsonPathForConvoy(convoyId: string, basePath?: string): string {
  const base = basePath ?? process.cwd()
  return join(base, '.opencastle', 'logs', 'convoys', `${convoyId}.ndjson`)
}

type ConvoyEmitIds = { convoy_id?: string; task_id?: string; worker_id?: string }

export interface ConvoyEventEmitter {
  emit<T extends ConvoyEventType>(
    type: T['type'],
    data?: T extends { data?: infer D } ? D : never,
    ids?: ConvoyEmitIds,
  ): void
  close(): void
}

function withoutReservedKeys(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (!RESERVED_KEYS.has(k)) safe[k] = v
    }
  }
  return safe
}

export function createEventEmitter(
  store: ConvoyStore,
  options?: { ndjsonPath?: string },
): ConvoyEventEmitter {
  if (typeof options === 'string') {
    throw new TypeError('createEventEmitter options must be an object, not a string')
  }

  let fd: number | null = null
  if (options?.ndjsonPath) {
    mkdirSync(dirname(options.ndjsonPath), { recursive: true })
    fd = openSync(options.ndjsonPath, 'a')
  }

  function writeNdjson(line: string, type: string, ids: ConvoyEmitIds | undefined): void {
    if (fd === null) return
    try {
      appendFileSync(fd, line)
      fsyncSync(fd)
    } catch {
      // The SQLite row above is the record; the NDJSON file is a copy for
      // tailing. Note the gap where it can be found, without recursing here.
      try {
        store.insertEvent({
          convoy_id: ids?.convoy_id ?? null,
          task_id: ids?.task_id ?? null,
          worker_id: ids?.worker_id ?? null,
          type: 'ndjson_write_failed',
          data: JSON.stringify({ original_type: type }),
          created_at: new Date().toISOString(),
        })
      } catch { /* store closed */ }
    }
  }

  return {
    emit(type, data, ids) {
      if (!validateEventType(type)) {
        console.warn(`[convoy] Unknown event type: "${type}"`)
      }
      const dataValidation = validateEventData(type, data)
      if (!dataValidation.valid) {
        console.warn(`[convoy] Invalid data for event type "${type}": ${dataValidation.issues?.join(', ')}`)
      }
      const now = new Date().toISOString()

      // Masked before *either* copy is written. The SQLite row used to keep the
      // secret while only the NDJSON line was withheld, and the dashboard reads
      // the SQLite row.
      const { value: clean, patterns } = redactValue(data as Record<string, unknown> | undefined)

      const eventId = store.insertEvent({
        convoy_id: ids?.convoy_id ?? null,
        task_id: ids?.task_id ?? null,
        worker_id: ids?.worker_id ?? null,
        type,
        data: clean !== undefined ? JSON.stringify(clean) : null,
        created_at: now,
      })

      if (patterns.length > 0) {
        store.insertEvent({
          convoy_id: ids?.convoy_id ?? null,
          task_id: ids?.task_id ?? null,
          worker_id: ids?.worker_id ?? null,
          type: 'secret_leak_prevented',
          data: JSON.stringify({ original_type: type, patterns: [...new Set(patterns)], context: 'event_redacted' }),
          created_at: now,
        })
      }

      const record = {
        _event_id: eventId,
        timestamp: now,
        type,
        convoy_id: ids?.convoy_id ?? null,
        task_id: ids?.task_id ?? null,
        worker_id: ids?.worker_id ?? null,
        ...withoutReservedKeys(clean),
      }
      writeNdjson(JSON.stringify(record) + '\n', type, ids)
    },

    close() {
      if (fd !== null) {
        closeSync(fd)
        fd = null
      }
    },
  }
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Truncate any trailing partial line in the NDJSON file, then replay any SQLite
 * events for the given convoy that are missing from the file.
 *
 * Replayed rows are masked on the way out: rows written before redaction moved
 * ahead of the SQLite insert can still hold a secret, and this is the path that
 * used to copy one into the log.
 */
export function recoverNdjson(store: ConvoyStore, convoyId: string, ndjsonPath: string): void {
  let fileContent: string
  try {
    fileContent = readFileSync(ndjsonPath, 'utf8')
  } catch {
    fileContent = ''
  }

  if (fileContent.length > 0 && !fileContent.endsWith('\n')) {
    const lastNewline = fileContent.lastIndexOf('\n')
    if (lastNewline === -1) {
      writeFileSync(ndjsonPath, '')
      fileContent = ''
    } else {
      writeFileSync(ndjsonPath, fileContent.slice(0, lastNewline + 1))
      fileContent = fileContent.slice(0, lastNewline + 1)
    }
  }

  const ndjsonIds = new Set<number>()
  for (const line of fileContent.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.convoy_id === convoyId && parsed._event_id != null) {
        ndjsonIds.add(parsed._event_id as number)
      }
    } catch {
      // Skip unparseable lines
    }
  }

  const sqliteEvents = store.getEvents(convoyId)
  const missing = sqliteEvents.filter(e => e.id != null && !ndjsonIds.has(e.id!))
  if (missing.length === 0) return

  mkdirSync(dirname(ndjsonPath), { recursive: true })
  const fd = openSync(ndjsonPath, 'a')
  try {
    for (const event of missing) {
      const parsedData = event.data ? safeJsonParse(event.data) : {}
      const { value: clean } = redactValue(parsedData)
      // Reserved keys are stripped from the data so a stored value cannot
      // override the canonical fields from the DB row.
      const record = {
        ...withoutReservedKeys(clean),
        _event_id: event.id,
        timestamp: event.created_at,
        type: event.type,
        convoy_id: event.convoy_id,
        task_id: event.task_id,
        worker_id: event.worker_id,
      }
      appendFileSync(fd, JSON.stringify(record) + '\n')
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
