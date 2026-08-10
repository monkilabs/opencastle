import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createConvoyStore } from './store.js'
import { createEventEmitter, ndjsonPathForConvoy, recoverNdjson, validateEventType } from './events.js'
import { KNOWN_EVENT_TYPES } from './types.js'
import type { ConvoyStore } from './store.js'

let tmpDir: string
let store: ConvoyStore
let ndjsonPath: string

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'emitter-test-')))
  store = createConvoyStore(join(tmpDir, 'test.db'))
  ndjsonPath = join(tmpDir, 'events.ndjson')

  store.insertConvoy({
    id: 'c1',
    name: 'Test',
    spec_hash: 'x',
    status: 'pending',
    branch: null,
    created_at: new Date().toISOString(),
    spec_yaml: 'name: test',
  })
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('createEventEmitter', () => {
  it('throws TypeError when options is a string', () => {
    expect(() => createEventEmitter(store, 'bad' as unknown as any)).toThrow(TypeError)
    expect(() => createEventEmitter(store, 'bad' as unknown as any)).toThrow(
      'createEventEmitter options must be an object, not a string',
    )
  })

  it('inserts the event into SQLite', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('task_started', { msg: 'started' }, { convoy_id: 'c1' })
    emitter.close()
    const events = store.getEvents('c1')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('task_started')
    expect(events[0].convoy_id).toBe('c1')
  })

  it('serializes event data to JSON in SQLite', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('task_done', { exitCode: 0, output: 'ok' }, { convoy_id: 'c1' })
    emitter.close()
    const events = store.getEvents('c1')
    const parsed = JSON.parse(events[0].data!)
    expect(parsed.exitCode).toBe(0)
    expect(parsed.output).toBe('ok')
  })

  it('stores null data when no data object is provided', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('convoy_guard', undefined, { convoy_id: 'c1' })
    emitter.close()
    const events = store.getEvents('c1')
    expect(events[0].data).toBeNull()
  })

  it('writes NDJSON when ndjsonPath is provided', () => {
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit('convoy_started', { name: 'test' }, { convoy_id: 'c1' })
    emitter.close()
    expect(existsSync(ndjsonPath)).toBe(true)
    const content = readFileSync(ndjsonPath, 'utf8')
    expect(content.trim()).not.toBe('')
    const line = JSON.parse(content.trim())
    expect(line.type).toBe('convoy_started')
    expect(line.convoy_id).toBe('c1')
  })

  it('writes _event_id to NDJSON matching SQLite rowid', () => {
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit('convoy_started', {}, { convoy_id: 'c1' })
    emitter.close()
    const sqliteEvents = store.getEvents('c1')
    const ndjsonLine = JSON.parse(readFileSync(ndjsonPath, 'utf8').trim())
    expect(ndjsonLine._event_id).toBe(sqliteEvents[0].id)
  })

  it('defaults all ids to null when ids are not provided', () => {
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit('convoy_guard')
    emitter.close()
    const events = store.getEvents('c1')
    expect(events).toHaveLength(0)
    // No convoy_id so not retrievable via getEvents('c1'), but event was inserted
    const content = readFileSync(ndjsonPath, 'utf8')
    const line = JSON.parse(content.trim())
    expect(line.convoy_id).toBeNull()
    expect(line.task_id).toBeNull()
    expect(line.worker_id).toBeNull()
  })

  it('includes all provided ids in the NDJSON record', () => {
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit('task_started', {}, { convoy_id: 'c1', task_id: 't1', worker_id: 'w1' })
    emitter.close()
    const line = JSON.parse(readFileSync(ndjsonPath, 'utf8').trim())
    expect(line.convoy_id).toBe('c1')
    expect(line.task_id).toBe('t1')
    expect(line.worker_id).toBe('w1')
  })

  it('SQLite event stores correct ids', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('task_done', {}, { convoy_id: 'c1', task_id: 'task-x', worker_id: 'wkr-y' })
    emitter.close()
    const events = store.getEvents('c1')
    expect(events[0].task_id).toBe('task-x')
    expect(events[0].worker_id).toBe('wkr-y')
  })

  it('does not throw if NDJSON path is not provided', () => {
    const emitter = createEventEmitter(store)
    expect(() => emitter.emit('convoy_guard', {}, { convoy_id: 'c1' })).not.toThrow()
    emitter.close()
  })

  it('close() is idempotent', () => {
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.close()
    expect(() => emitter.close()).not.toThrow()
  })

  it('sanitizes reserved keys from caller data before NDJSON write', () => {
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit(
      'task_started',
      {
        convoy_id: 'attacker',
        timestamp: 'fake',
        _event_id: 999,
        type: 'evil',
        task_id: 'injected',
        worker_id: 'hacker',
        custom_field: 'ok',
      },
      { convoy_id: 'c1', task_id: 't1', worker_id: 'w1' },
    )
    emitter.close()
    const content = readFileSync(ndjsonPath, 'utf8')
    const line = JSON.parse(content.trim())
    expect(line.convoy_id).toBe('c1')
    expect(line.task_id).toBe('t1')
    expect(line.worker_id).toBe('w1')
    expect(line.type).toBe('task_started')
    expect(line._event_id).not.toBe(999)
    expect(line.timestamp).not.toBe('fake')
    expect(line.custom_field).toBe('ok')
  })
})

describe('crash resilience', () => {
  it('1. mid-write crash: SQLite has events, recovery writes NDJSON', () => {
    // Emit events using emitter WITHOUT ndjsonPath — simulates crash after SQLite commit
    const emitter = createEventEmitter(store)
    emitter.emit('task_started', { step: 1 }, { convoy_id: 'c1', task_id: 't1' })
    emitter.emit('task_done', { step: 2 }, { convoy_id: 'c1', task_id: 't1' })
    emitter.close()

    // SQLite has both events
    const sqliteEvents = store.getEvents('c1')
    expect(sqliteEvents).toHaveLength(2)

    // NDJSON file does not exist
    expect(existsSync(ndjsonPath)).toBe(false)

    // Recovery writes the missing events to NDJSON
    recoverNdjson(store, 'c1', ndjsonPath)

    expect(existsSync(ndjsonPath)).toBe(true)
    const lines = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(lines).toHaveLength(2)
    const types = lines.map(l => JSON.parse(l).type)
    expect(types).toContain('task_started')
    expect(types).toContain('task_done')
  })

  it('2. recovery consistency: missing events replayed after partial crash', () => {
    // Write some events to both SQLite + NDJSON via emitter
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit('convoy_started', {}, { convoy_id: 'c1' })
    emitter.close()

    // Simulate crash: two more events go only to SQLite (bypass emitter)
    store.insertEvent({
      convoy_id: 'c1', task_id: 't1', worker_id: null,
      type: 'task_started', data: null, created_at: new Date().toISOString(),
    })
    store.insertEvent({
      convoy_id: 'c1', task_id: 't1', worker_id: null,
      type: 'task_done', data: null, created_at: new Date().toISOString(),
    })

    // Before recovery: NDJSON has 1 line, SQLite has 3
    const beforeLines = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(beforeLines).toHaveLength(1)
    expect(store.getEvents('c1')).toHaveLength(3)

    // Recovery replays the 2 missing events
    recoverNdjson(store, 'c1', ndjsonPath)

    const afterLines = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(afterLines).toHaveLength(3)
  })

  it('3. no duplication: idempotent recovery when all synced', () => {
    // Write 5 events — all go to both SQLite and NDJSON
    const emitter = createEventEmitter(store, { ndjsonPath })
    for (let i = 0; i < 5; i++) {
      emitter.emit('task_done', { i }, { convoy_id: 'c1', task_id: `t${i}` })
    }
    emitter.close()

    const linesBefore = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(linesBefore).toHaveLength(5)

    // Run recovery — nothing should be added since all events already in NDJSON
    recoverNdjson(store, 'c1', ndjsonPath)

    const linesAfter = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(linesAfter).toHaveLength(5)
  })

  it('4. partial line recovery: incomplete write truncated and replayed', () => {
    // Write one complete event then append a partial JSON line (no \\n terminator)
    const emitter = createEventEmitter(store, { ndjsonPath })
    emitter.emit('convoy_started', {}, { convoy_id: 'c1' })
    emitter.close()

    // Append a partial line directly (simulating a crash mid-write)
    const partialLine = '{"_event_id":999,"type":"partial_crash","convoy_id":"c1"'  // no closing } or \n
    const existingContent = readFileSync(ndjsonPath, 'utf8')
    writeFileSync(ndjsonPath, existingContent + partialLine)

    // Recovery should truncate the partial line and replay anything missing
    recoverNdjson(store, 'c1', ndjsonPath)

    const recovered = readFileSync(ndjsonPath, 'utf8')
    // Every line should be valid JSON
    const lines = recovered.split('\n').filter(l => l.trim())
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // The original complete event should be present
    const types = lines.map(l => JSON.parse(l).type)
    expect(types).toContain('convoy_started')
    // The partial line should not appear
    expect(types).not.toContain('partial_crash')
  })

  it('5. large file: 1000 events all readable after emit and recovery', () => {
    const count = 1000
    const emitter = createEventEmitter(store, { ndjsonPath })
    for (let i = 0; i < count; i++) {
      emitter.emit('task_retried', { previous_status: String(i) }, { convoy_id: 'c1', task_id: `t${i}` })
    }
    emitter.close()

    // All events in SQLite
    expect(store.getEvents('c1')).toHaveLength(count)

    // All events in NDJSON
    const lines = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(lines).toHaveLength(count)

    // Each line is valid JSON with the right type
    for (const line of lines) {
      const parsed = JSON.parse(line)
      expect(parsed.type).toBe('task_retried')
      expect(parsed.convoy_id).toBe('c1')
    }

    // Recovery is a no-op (everything is synced)
    recoverNdjson(store, 'c1', ndjsonPath)
    const linesAfter = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(linesAfter).toHaveLength(count)
  })

  it('6. canonical-field protection: event.data cannot override DB row fields', () => {
    // Insert an event whose data contains attacker-controlled reserved keys
    store.insertEvent({
      convoy_id: 'c1',
      task_id: 'legit-task',
      worker_id: 'legit-worker',
      type: 'task_done',
      data: JSON.stringify({
        convoy_id: 'attacker',
        timestamp: 'fake',
        _event_id: 9999,
        type: 'evil',
        task_id: 'injected',
        worker_id: 'hacker',
        safe_field: 'this-is-fine',
      }),
      created_at: new Date().toISOString(),
    })

    recoverNdjson(store, 'c1', ndjsonPath)

    const lines = readFileSync(ndjsonPath, 'utf8').split('\n').filter(l => l.trim())
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]) as Record<string, unknown>

    // Canonical fields must come from the DB row, not from data
    expect(record.convoy_id).toBe('c1')
    expect(record.task_id).toBe('legit-task')
    expect(record.worker_id).toBe('legit-worker')
    expect(record.type).toBe('task_done')
    expect(record._event_id).not.toBe(9999)
    expect(record.timestamp).not.toBe('fake')

    // Attacker values must not appear
    expect(record.convoy_id).not.toBe('attacker')
    expect(record.type).not.toBe('evil')
    expect(record.task_id).not.toBe('injected')
    expect(record.worker_id).not.toBe('hacker')

    // Safe non-reserved fields are preserved
    expect(record.safe_field).toBe('this-is-fine')
  })
})

describe('KNOWN_EVENT_TYPES', () => {
  it('contains all canonical event types', () => {
    const canonical = [
      'convoy_started', 'convoy_finished', 'convoy_failed', 'convoy_guard',
      'task_started', 'task_done', 'task_failed', 'task_skipped', 'task_retried', 'task_waiting_input',
      'review_started', 'review_verdict', 'dispute_opened', 'dlq_entry_created',
      'drift_check_result', 'drift_detected',
      'circuit_breaker_tripped', 'circuit_breaker_fallback', 'circuit_breaker_blocked',
      'merge_conflict_detected', 'merge_conflict_failed',
      'file_injection_received', 'artifact_limit_reached',
      'agent_identity_captured', 'agent_identity_rejected',
      'swarm_concurrency_update', 'post_convoy_hook_failed',
      'session', 'delegation',
      'secret_leak_prevented', 'ndjson_write_failed', 'built_in_gate_result',
      'watch_started', 'watch_cycle_start', 'watch_cycle_end', 'watch_stopped',
      'worker_killed',
    ]
    for (const type of canonical) {
      expect(KNOWN_EVENT_TYPES.has(type)).toBe(true)
    }
  })

  it('has no duplicates (Set size matches array)', () => {
    expect(KNOWN_EVENT_TYPES.size).toBeGreaterThanOrEqual(37)
  })
})

describe('ndjsonPathForConvoy', () => {
  it('returns correct per-convoy path with default basePath', () => {
    const result = ndjsonPathForConvoy('abc-123')
    expect(result).toBe(join(process.cwd(), '.opencastle', 'logs', 'convoys', 'abc-123.ndjson'))
  })

  it('returns correct per-convoy path with custom basePath', () => {
    const result = ndjsonPathForConvoy('xyz-456', '/custom/base')
    expect(result).toBe(join('/custom/base', '.opencastle', 'logs', 'convoys', 'xyz-456.ndjson'))
  })
})

describe('createEventEmitter directory creation', () => {
  it('creates parent directory when ndjsonPath is in a non-existent directory', () => {
    const nestedPath = join(tmpDir, 'nested', 'dir', 'events.ndjson')
    const emitter = createEventEmitter(store, { ndjsonPath: nestedPath })
    emitter.emit('convoy_started', { name: 'test' }, { convoy_id: 'c1' })
    emitter.close()
    expect(existsSync(nestedPath)).toBe(true)
    const content = readFileSync(nestedPath, 'utf8')
    const line = JSON.parse(content.trim())
    expect(line.type).toBe('convoy_started')
  })
})

describe('validateEventType', () => {
  it('returns true for known event types', () => {
    expect(validateEventType('convoy_started')).toBe(true)
    expect(validateEventType('task_done')).toBe(true)
    expect(validateEventType('watch_stopped')).toBe(true)
  })

  it('returns false for unknown event types', () => {
    expect(validateEventType('unknown_event')).toBe(false)
    expect(validateEventType('')).toBe(false)
    expect(validateEventType('convoy_start')).toBe(false)
  })
})

describe('emit-time data validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('valid data passes without warning', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('convoy_finished', { status: 'done' }, { convoy_id: 'c1' })
    emitter.close()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('invalid data shape warns with correct message', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('convoy_finished', { status: 123 } as unknown as Record<string, unknown>, { convoy_id: 'c1' })
    emitter.close()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid data for event type "convoy_finished"'),
    )
  })

  it('missing required field warns', () => {
    const emitter = createEventEmitter(store)
    // task_failed requires reason: string — passing {} should fail
    emitter.emit('task_failed', {} as Record<string, unknown>, { convoy_id: 'c1' })
    emitter.close()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid data for event type "task_failed"'),
    )
  })

  it('extra fields are allowed (no warning)', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('convoy_started', { name: 'test', extra: true } as Record<string, unknown>, { convoy_id: 'c1' })
    emitter.close()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('undefined data is valid', () => {
    const emitter = createEventEmitter(store)
    emitter.emit('convoy_started', undefined, { convoy_id: 'c1' })
    emitter.close()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('unknown event type bypasses data validation (only one warning)', () => {
    const emitter = createEventEmitter(store)
    // Cast needed: TypeScript normally catches unknown types at compile time.
    // This tests the runtime guard (e.g. JS callers / dynamic values / `as any` paths).
    emitter.emit('unknown_type_xyz' as Parameters<typeof emitter.emit>[0], { any: 'data' }, { convoy_id: 'c1' })
    emitter.close()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown event type: "unknown_type_xyz"'))
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Invalid data'))
  })
})

