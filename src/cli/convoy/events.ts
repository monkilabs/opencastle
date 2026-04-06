import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConvoyStore } from './store.js'
import { KNOWN_EVENT_TYPES } from './types.js'
import type { ConvoyEventType } from './types.js'
import { validateEventData } from './event-schemas.js'

const RESERVED_KEYS = new Set(['_event_id', 'convoy_id', 'task_id', 'worker_id', 'timestamp', 'type'])
import { scanForSecrets } from './gates.js'

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

  // NDJSON writes are supplementary — SQLite is the primary store. Use async
  // retries to avoid blocking the Node.js event loop.
  async function writeNdjson(
    type: string,
    data: Record<string, unknown> | undefined,
    ids: { convoy_id?: string; task_id?: string; worker_id?: string } | undefined,
    now: string,
    eventId: number,
    currentFd: number,
  ): Promise<void> {
    const safeData: Record<string, unknown> = {}
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        if (!RESERVED_KEYS.has(k)) safeData[k] = v
      }
    }
    const record = {
      _event_id: eventId,
      timestamp: now,
      type,
      convoy_id: ids?.convoy_id ?? null,
      task_id: ids?.task_id ?? null,
      worker_id: ids?.worker_id ?? null,
      ...safeData,
    }
    const jsonLine = JSON.stringify(record) + '\n'

    const scanResult = scanForSecrets(jsonLine, 'ndjson')
    if (!scanResult.clean) {
      // Block the NDJSON write — record the blocked event in SQLite only
      store.insertEvent({
        convoy_id: ids?.convoy_id ?? null,
        task_id: ids?.task_id ?? null,
        worker_id: ids?.worker_id ?? null,
        type: 'secret_leak_prevented',
        data: JSON.stringify({ original_type: type, patterns: scanResult.findings.map(f => f.pattern) }),
        created_at: now,
      })
      return
    }

    try {
      appendFileSync(currentFd, jsonLine)
      fsyncSync(currentFd)
    } catch {
      // Retry once after 100ms (non-blocking)
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      try {
        appendFileSync(currentFd, jsonLine)
        fsyncSync(currentFd)
      } catch {
        // Emit failure meta-event to SQLite only (do NOT recurse into NDJSON write)
        store.insertEvent({
          convoy_id: ids?.convoy_id ?? null,
          task_id: ids?.task_id ?? null,
          worker_id: ids?.worker_id ?? null,
          type: 'ndjson_write_failed',
          data: JSON.stringify({ original_type: type }),
          created_at: new Date().toISOString(),
        })
      }
    }
  }

  return {
    emit(type, data, ids) {
      // SQLite insert is not scanned; NDJSON write is scanned via writeNdjson().
      // User-generated content (task output, DLQ entries) is scanned at its source
      // before reaching the event emitter. See MF-4 in panel report.
      if (!validateEventType(type)) {
        console.warn(`[convoy] Unknown event type: "${type}"`)
      }
      const dataValidation = validateEventData(type, data)
      if (!dataValidation.valid) {
        console.warn(`[convoy] Invalid data for event type "${type}": ${dataValidation.issues?.join(', ')}`)
      }
      const now = new Date().toISOString()

      const eventId = store.insertEvent({
        convoy_id: ids?.convoy_id ?? null,
        task_id: ids?.task_id ?? null,
        worker_id: ids?.worker_id ?? null,
        type,
        data: data !== undefined ? JSON.stringify(data) : null,
        created_at: now,
      })

      // Fire-and-forget: SQLite record (above) is the source of truth.
      // NDJSON is supplementary — no need to await or block on it.
      if (fd !== null) {
        writeNdjson(type, data, ids, now, eventId, fd).catch(() => {
          // Swallow unhandled rejection — failure already recorded in SQLite via writeNdjson
        })
      }
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
 * Exported for unit testing.
 */
export function recoverNdjson(store: ConvoyStore, convoyId: string, ndjsonPath: string): void {
  // 1. Read the NDJSON file (if it exists)
  let fileContent: string
  try {
    fileContent = readFileSync(ndjsonPath, 'utf8')
  } catch {
    fileContent = ''
  }

  // 2. Truncate any partial trailing line (no \n terminator)
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

  // 3. Count valid NDJSON event IDs for this convoy
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

  // 4. Get all SQLite events for this convoy
  const sqliteEvents = store.getEvents(convoyId)

  // 5. Replay missing events (those in SQLite but not in NDJSON)
  const missing = sqliteEvents.filter(e => e.id != null && !ndjsonIds.has(e.id!))
  if (missing.length > 0) {
    const fd = openSync(ndjsonPath, 'a')
    try {
      for (const event of missing) {
        const parsedData = event.data ? safeJsonParse(event.data) : {}
        // Strip reserved keys from event.data to prevent attacker-controlled
        // values from overriding canonical fields from the DB row.
        const safeData: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(parsedData)) {
          if (!RESERVED_KEYS.has(key)) safeData[key] = value
        }
        const record = {
          ...safeData,
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
}
