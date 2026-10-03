import type { Task } from './spec-types.js'
import type { TaskRecord } from './types.js'
import { normalizePath, pathsOverlap } from './partition.js'

/**
 * Pure scheduling helpers: the plan-time phase split, and which ready tasks may
 * start next to the ones already running.
 */

/**
 * Group tasks into phases by dependency depth (Kahn's algorithm).
 *
 * Phases are no longer barriers — the engine starts a task the moment its
 * dependencies are done. They remain the unit of the plan-time partition
 * check and the `phase` column the viewer groups by.
 */
export function buildPhases(tasks: Task[]): Task[][] {
  const taskMap = new Map<string, Task>()
  for (const t of tasks) taskMap.set(t.id, t)

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    inDegree.set(t.id, (t.depends_on || []).filter((d) => taskMap.has(d)).length)
    dependents.set(t.id, [])
  }
  for (const t of tasks) {
    for (const dep of t.depends_on || []) dependents.get(dep)?.push(t.id)
  }

  const phases: Task[][] = []
  const remaining = new Set(tasks.map((t) => t.id))
  while (remaining.size > 0) {
    const phase: Task[] = []
    for (const id of remaining) {
      if (inDegree.get(id) === 0) phase.push(taskMap.get(id)!)
    }
    if (phase.length === 0) throw new Error('Cannot resolve task order — possible circular dependency')
    phases.push(phase)
    for (const t of phase) {
      remaining.delete(t.id)
      for (const depId of dependents.get(t.id)!) inDegree.set(depId, inDegree.get(depId)! - 1)
    }
  }
  return phases
}

/** A duration for people: `850ms`, `12s`, `4m 12s`, `1h 3m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSec = seconds % 60
  if (minutes < 60) return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`
}

/** The task's declared files, normalised; unparseable entries are kept verbatim. */
export function taskFiles(task: Pick<TaskRecord, 'files'>): string[] {
  if (!task.files) return []
  let raw: unknown
  try {
    raw = JSON.parse(task.files)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((f): f is string => typeof f === 'string').map((f) => {
    try {
      return normalizePath(f)
    } catch {
      return f
    }
  })
}

/** True when two declared file lists share a path, or one contains the other. */
export function filesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  return a.some((x) => b.some((y) => pathsOverlap(x, y) || pathsOverlap(x.toLowerCase(), y.toLowerCase())))
}

/**
 * Which of the ready tasks may start now, in order, given what is running and
 * how many slots are free.
 *
 * A task whose files overlap a running task's waits — the dynamic form of the
 * per-phase partition check, which only ever compared tasks in the same phase.
 * Two tasks picked in the same call are checked against each other too.
 */
export function pickStartable(
  ready: TaskRecord[],
  running: TaskRecord[],
  freeSlots: number,
): TaskRecord[] {
  const picked: TaskRecord[] = []
  const busy = running.map(taskFiles)
  for (const task of ready) {
    if (picked.length >= freeSlots) break
    const files = taskFiles(task)
    if (busy.some((other) => filesOverlap(files, other))) continue
    picked.push(task)
    busy.push(files)
  }
  return picked
}
