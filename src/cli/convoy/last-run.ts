import type { ConvoyRecord, PipelineRecord } from './types.js'

/**
 * Which run "the last run" means, answered once.
 *
 * `resume` decided this for itself and the status screen decided it for itself,
 * and they disagreed: the screen read the newest convoy row, `resume` read the
 * newest *pipeline* row and preferred it unconditionally. A project that ran a
 * pipeline, saw it fail, and then ran a standalone spec got a status screen
 * naming the standalone convoy and printing "Next: opencastle convoy resume",
 * while `resume` reopened the older pipeline. Nothing in the output said so.
 *
 * Worse, it could not be escaped. The pipeline branch was taken whenever the
 * newest pipeline was not `done`, and when it *was* done the surrounding code
 * exited rather than falling through — so once a project had ever run a
 * pipeline, no standalone convoy could be resumed again.
 *
 * The rule is the one a person would state: whichever run was started most
 * recently, provided it is in a state that can be continued.
 */

/** A run `resume` may take over, and which orchestrator owns it. */
export type LastRun =
  | { kind: 'pipeline'; record: PipelineRecord }
  | { kind: 'convoy'; record: ConvoyRecord }

/**
 * A finished run has nothing to continue.
 *
 * `resume` now does everything `retry` did — failed, timed-out, interrupted and
 * skipped tasks all go back to pending — so a convoy is resumable unless it
 * finished `done`. And `done` alone is not trusted: older runs ended `done`
 * with tasks still skipped, and the status screen then said "nothing
 * outstanding" over work that never ran.
 */
const RESUMABLE_PIPELINE = new Set(['pending', 'running', 'failed', 'interrupted'])

export interface LastRunSource {
  getLatestPipeline(): PipelineRecord | undefined
  getLatestStandaloneConvoy(): ConvoyRecord | undefined
  /** When available, a convoy with any task not done counts as resumable, whatever its status. */
  getTasksByConvoy?(convoyId: string): Array<{ status: string }>
}

/**
 * The newest run of either kind, resumable or not.
 *
 * What the status screen reports: it describes where things stand, including
 * when where-things-stand is "finished". `selectResumableRun` narrows this to
 * what `resume` may act on.
 */
export function selectLastRun(store: LastRunSource): LastRun | null {
  const pipeline = store.getLatestPipeline()
  const convoy = store.getLatestStandaloneConvoy()

  if (pipeline && convoy) {
    // Ties go to the pipeline: a chain creates its first convoy in the same
    // instant it creates itself, and the orchestrator is the one that should
    // drive it.
    return convoy.created_at > pipeline.created_at
      ? { kind: 'convoy', record: convoy }
      : { kind: 'pipeline', record: pipeline }
  }
  if (pipeline) return { kind: 'pipeline', record: pipeline }
  if (convoy) return { kind: 'convoy', record: convoy }
  return null
}

/** True when `resume` can continue this run. */
export function isResumable(run: LastRun, store?: Pick<LastRunSource, 'getTasksByConvoy'>): boolean {
  if (run.kind === 'pipeline') return RESUMABLE_PIPELINE.has(run.record.status)
  if (run.record.status !== 'done') return true
  const tasks = store?.getTasksByConvoy?.(run.record.id) ?? []
  return tasks.some((t) => t.status !== 'done')
}

/**
 * The run `resume` should continue, or the newest run explaining why it cannot.
 *
 * Returning the blocking run rather than `null` is what lets the caller say
 * *which* run is finished instead of "nothing to resume" — the message that
 * sent people looking for a database that was in front of them all along.
 */
export function selectResumableRun(
  store: LastRunSource,
): { run: LastRun; resumable: boolean } | null {
  const run = selectLastRun(store)
  if (!run) return null
  return { run, resumable: isResumable(run, store) }
}
