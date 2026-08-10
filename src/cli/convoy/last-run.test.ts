/**
 * Which run "the last run" means.
 *
 * The defect these cover: `resume` preferred the newest *pipeline* row over the
 * newest convoy unconditionally, so a project that ran a pipeline and then ran a
 * standalone spec got a status screen naming one run and a `resume` that
 * continued a different one — permanently, since the done-pipeline branch exited
 * rather than falling through to the convoy.
 */
import { describe, it, expect } from 'vitest'
import { selectLastRun, isResumable, selectResumableRun } from './last-run.js'
import type { LastRunSource } from './last-run.js'
import type { ConvoyRecord, PipelineRecord } from './types.js'

function pipeline(over: Partial<PipelineRecord> = {}): PipelineRecord {
  return {
    id: 'pipe-1',
    name: 'A Pipeline',
    status: 'failed',
    branch: null,
    spec_yaml: 'name: A Pipeline\nversion: 2\n',
    convoy_specs: '[]',
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    total_tokens: null,
    total_cost_usd: null,
    ...over,
  } as PipelineRecord
}

function convoy(over: Partial<ConvoyRecord> = {}): ConvoyRecord {
  return {
    id: 'conv-1',
    name: 'A Convoy',
    spec_hash: 'deadbeef',
    status: 'running',
    branch: null,
    created_at: '2026-08-10T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    spec_yaml: 'name: A Convoy\nversion: 1\n',
    total_tokens: null,
    total_cost_usd: null,
    pipeline_id: null,
    circuit_state: null,
    review_tokens_total: null,
    review_budget: null,
    ...over,
  } as ConvoyRecord
}

function source(p: PipelineRecord | undefined, c: ConvoyRecord | undefined): LastRunSource {
  return { getLatestPipeline: () => p, getLatestStandaloneConvoy: () => c }
}

describe('selectLastRun', () => {
  it('picks the newer run when a convoy was started after a pipeline', () => {
    // The shipped defect: an old failed pipeline shadowed a newer convoy.
    const last = selectLastRun(source(pipeline(), convoy()))
    expect(last).toEqual({ kind: 'convoy', record: expect.objectContaining({ id: 'conv-1' }) })
  })

  it('picks the pipeline when it is the newer run', () => {
    const last = selectLastRun(
      source(pipeline({ created_at: '2026-09-01T00:00:00.000Z' }), convoy()),
    )
    expect(last?.kind).toBe('pipeline')
  })

  it('gives a tie to the pipeline, which creates its first convoy in the same instant', () => {
    const at = '2026-05-05T00:00:00.000Z'
    const last = selectLastRun(source(pipeline({ created_at: at }), convoy({ created_at: at })))
    expect(last?.kind).toBe('pipeline')
  })

  it('returns whichever exists when there is only one', () => {
    expect(selectLastRun(source(pipeline(), undefined))?.kind).toBe('pipeline')
    expect(selectLastRun(source(undefined, convoy()))?.kind).toBe('convoy')
  })

  it('returns null on an empty database', () => {
    expect(selectLastRun(source(undefined, undefined))).toBeNull()
  })
})

describe('isResumable', () => {
  it('treats a failed pipeline as resumable — the chain carries on past a bad link', () => {
    expect(isResumable({ kind: 'pipeline', record: pipeline({ status: 'failed' }) })).toBe(true)
  })

  it('treats a failed convoy as not resumable — retry is that verb', () => {
    expect(isResumable({ kind: 'convoy', record: convoy({ status: 'failed' }) })).toBe(false)
  })

  it('treats a done run of either kind as finished', () => {
    expect(isResumable({ kind: 'pipeline', record: pipeline({ status: 'done' }) })).toBe(false)
    expect(isResumable({ kind: 'convoy', record: convoy({ status: 'done' }) })).toBe(false)
  })

  it('resumes pending and running convoys', () => {
    for (const status of ['pending', 'running'] as const) {
      expect(isResumable({ kind: 'convoy', record: convoy({ status }) })).toBe(true)
    }
  })
})

describe('selectResumableRun', () => {
  it('reaches a standalone convoy even when a done pipeline exists', () => {
    // The trap: the old code exited on a done pipeline instead of falling
    // through, so no standalone convoy could ever be resumed afterwards.
    const selected = selectResumableRun(
      source(pipeline({ status: 'done' }), convoy({ status: 'running' })),
    )
    expect(selected).toEqual({
      run: { kind: 'convoy', record: expect.objectContaining({ id: 'conv-1' }) },
      resumable: true,
    })
  })

  it('names the blocking run rather than reporting an empty database', () => {
    const selected = selectResumableRun(source(undefined, convoy({ status: 'done' })))
    expect(selected?.resumable).toBe(false)
    expect(selected?.run.record.name).toBe('A Convoy')
  })

  it('is null only when there is genuinely nothing recorded', () => {
    expect(selectResumableRun(source(undefined, undefined))).toBeNull()
  })
})
