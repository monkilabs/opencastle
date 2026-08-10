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
 * `failed` is resumable for a pipeline — a convoy in the chain failed, the user
 * fixes it, the chain carries on — but not for a standalone convoy, where
 * `retry` is the verb that reopens failed work. That asymmetry is the existing
 * behaviour of both branches; it is preserved here rather than invented.
 */
const RESUMABLE_PIPELINE = new Set(['pending', 'running', 'failed'])
const RESUMABLE_CONVOY = new Set(['pending', 'running'])

export interface LastRunSource {
  getLatestPipeline(): PipelineRecord | undefined
  getLatestStandaloneConvoy(): ConvoyRecord | undefined
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
export function isResumable(run: LastRun): boolean {
  return run.kind === 'pipeline'
    ? RESUMABLE_PIPELINE.has(run.record.status)
    : RESUMABLE_CONVOY.has(run.record.status)
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
  return { run, resumable: isResumable(run) }
}
