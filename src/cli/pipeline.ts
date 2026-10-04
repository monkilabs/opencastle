import { readFile, writeFile, mkdir, rm, rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, basename, dirname } from 'node:path'
import { c, confirm, closePrompts } from './prompt.js'
import { runPromptStep, freePath, StepCancelled } from './plan.js'
import type { PromptStepOptions, PromptStepResult } from './plan.js'
import { resolveAdapter, cleanupAdapters, type ResolvedAdapter } from './run/adapters/index.js'
import { findProjectRoot } from './convoy/read-model.js'
import type { AgentAdapter } from './convoy/spec-types.js'
import type { CliContext } from './types.js'
import { foldTestOnlyTasks,
  applyPatches,
  buildConvoyYaml,
  checkPlan,
  detectGates,
  mergeGroupPlans,
  normalizePlanFiles,
  parsePatches,
  parseTaskPlanWithReason,
  planConcurrency,
  sequenceConflicts,
  slugify,
} from './convoy/spec-builder.js'
import type { SpecSettings, TaskPlan } from './convoy/spec-builder.js'

export interface ConvoyGroup {
  name: string
  description: string
  phases: number[]
  depends_on: string[]
}

function appendTaskComplexity(base: string, taskComplexity: ComplexityAssessment['task_complexity']): string {
  if (!taskComplexity?.length) return base
  let result = base + '\n\n## Pre-Computed Task Complexity\n\n'
  result += '| Workstream | Phase | Complexity | Rationale |\n'
  result += '|-----------|-------|-----------|----------|\n'
  for (const tc of taskComplexity) {
    result += `| ${tc.workstream} | ${tc.phase} | ${tc.complexity} | ${tc.rationale} |\n`
  }
  return result
}

/**
 * For chain mode, extract only the PRD sections relevant to the given phases.
 * Keeps Overview, Technical Requirements, and the matching phase sections from
 * Task Breakdown, while trimming the full User Stories, Implementation Scope,
 * and non-matching phases to reduce context size and avoid output truncation.
 */
function extractRelevantPrdSections(prdContent: string, phases: number[]): string {
  const phaseSet = new Set(phases)
  const lines = prdContent.split('\n')
  const result: string[] = []

  // Sections to always include (key context)
  const alwaysInclude = ['overview', 'goals', 'non-goals', 'technical requirements']
  // Sections to include condensed
  const condenseSection = ['user stories & acceptance criteria', 'implementation scope', 'success criteria', 'risks & open questions']

  let inTaskBreakdown = false
  let inRelevantPhase = false
  let skipSection = false

  for (const line of lines) {
    // Detect heading (## level)
    const h2Match = line.match(/^## (.+)/)
    if (h2Match) {
      const heading = h2Match[1].trim().toLowerCase()
      inTaskBreakdown = heading === 'task breakdown'
      inRelevantPhase = false
      skipSection = false

      if (alwaysInclude.some(s => heading.startsWith(s))) {
        result.push(line)
        continue
      }

      if (inTaskBreakdown) {
        result.push(line)
        result.push('')
        result.push(`*(Only phases ${phases.join(', ')} shown — other phases omitted for brevity)*`)
        result.push('')
        continue
      }

      if (condenseSection.some(s => heading.startsWith(s))) {
        // Include the heading but mark as condensed
        result.push(line)
        result.push('')
        result.push('*(Condensed — see full PRD for details)*')
        result.push('')
        skipSection = true
        continue
      }

      // # title heading — always include
      result.push(line)
      continue
    }

    // H1 heading — always include
    if (line.match(/^# /)) {
      result.push(line)
      continue
    }

    if (skipSection) continue

    if (inTaskBreakdown) {
      // Detect phase headers like "Phase 1 —" or "Phase 2 —"
      const phaseMatch = line.match(/Phase\s+(\d+)/i)
      if (phaseMatch) {
        const phaseNum = parseInt(phaseMatch[1], 10)
        inRelevantPhase = phaseSet.has(phaseNum)
      }
      if (inRelevantPhase) {
        result.push(line)
      }
      continue
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * Filter task complexity entries to only those matching the given phases.
 */
function filterTaskComplexityByPhases(
  taskComplexity: ComplexityAssessment['task_complexity'],
  phases: number[],
): ComplexityAssessment['task_complexity'] {
  if (!taskComplexity?.length) return taskComplexity
  const phaseSet = new Set(phases)
  return taskComplexity.filter(tc => phaseSet.has(tc.phase))
}

export interface ComplexityAssessment {
  original_prompt: string
  total_tasks: number
  total_phases: number
  domains: string[]
  estimated_duration_minutes?: number
  complexity: 'low' | 'medium' | 'high'
  recommended_strategy: 'single' | 'chain'
  chain_rationale?: string
  convoy_groups: ConvoyGroup[]
  task_complexity?: Array<{
    workstream: string
    phase: number
    complexity: 1 | 2 | 3 | 5 | 8 | 13
    rationale: string
  }>
}

export function parseComplexityAssessment(jsonText: string): ComplexityAssessment | null {
  try {
    const parsed = JSON.parse(jsonText.trim()) as ComplexityAssessment
    // Validate required fields
    if (
      typeof parsed.original_prompt !== 'string' ||
      typeof parsed.total_tasks !== 'number' ||
      typeof parsed.total_phases !== 'number' ||
      !Array.isArray(parsed.domains) ||
      !parsed.complexity ||
      !parsed.recommended_strategy ||
      !Array.isArray(parsed.convoy_groups)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function deriveComplexityPath(prdPath: string): string {
  if (prdPath.endsWith('.prd.md')) {
    return prdPath.slice(0, -'.prd.md'.length) + '.complexity.json'
  }
  return prdPath + '.complexity.json'
}

export function validateComplexityGroups(assessment: ComplexityAssessment): { valid: boolean; reason: string } {
  const groups = assessment.convoy_groups

  // Each group must reference at least 1 phase
  for (const group of groups) {
    if (group.phases.length === 0) {
      return { valid: false, reason: `Group "${group.name}" has an empty phases array` }
    }
  }

  // Maximum group count: ≤3 for total_tasks ≤ 15, ≤4 for total_tasks > 15
  const maxGroups = assessment.total_tasks > 15 ? 4 : 3
  if (groups.length > maxGroups) {
    return { valid: false, reason: `Too many groups: ${groups.length} exceeds maximum of ${maxGroups} for total_tasks=${assessment.total_tasks}` }
  }

  // No overlapping phases
  const seenPhases = new Map<number, string>()
  for (const group of groups) {
    for (const phase of group.phases) {
      if (seenPhases.has(phase)) {
        return { valid: false, reason: `Phase ${phase} overlap: referenced by both "${seenPhases.get(phase)}" and "${group.name}"` }
      }
      seenPhases.set(phase, group.name)
    }
  }

  // Valid depends_on references
  const groupNames = new Set(groups.map(g => g.name))
  for (const group of groups) {
    for (const dep of group.depends_on) {
      if (!groupNames.has(dep)) {
        return { valid: false, reason: `Group "${group.name}" depends_on "${dep}" which does not exist` }
      }
    }
  }

  // No dependency cycles (Kahn's algorithm)
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()
  for (const group of groups) {
    inDegree.set(group.name, 0)
    adjList.set(group.name, [])
  }
  for (const group of groups) {
    for (const dep of group.depends_on) {
      adjList.get(dep)!.push(group.name)
      inDegree.set(group.name, (inDegree.get(group.name) ?? 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name)
  }
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()!
    visited++
    for (const neighbor of adjList.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }
  if (visited !== groups.length) {
    return { valid: false, reason: 'Dependency cycle detected in convoy_groups' }
  }

  // Group names must be kebab-case safe
  const kebabCaseRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/
  for (const group of groups) {
    if (!kebabCaseRegex.test(group.name)) {
      return { valid: false, reason: `Group name "${group.name}" is not valid kebab-case` }
    }
  }

  return { valid: true, reason: '' }
}

export function topologicalSortGroups(groups: ConvoyGroup[]): ConvoyGroup[] {
  const groupMap = new Map<string, ConvoyGroup>()
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()

  for (const group of groups) {
    groupMap.set(group.name, group)
    inDegree.set(group.name, 0)
    adjList.set(group.name, [])
  }
  for (const group of groups) {
    for (const dep of group.depends_on) {
      adjList.get(dep)!.push(group.name)
      inDegree.set(group.name, (inDegree.get(group.name) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name)
  }

  const sorted: ConvoyGroup[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    sorted.push(groupMap.get(node)!)
    for (const neighbor of adjList.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  if (sorted.length !== groups.length) {
    throw new Error('Cycle detected in convoy_groups dependency graph')
  }

  return sorted
}

/** The SHA-256 of a PRD's text: the complexity cache's key. */
export function hashPrd(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * The cached assessment of exactly this PRD, or null.
 *
 * The cache sits next to the PRD and records the hash of the text it assessed;
 * it is used only when that hash matches. It used to be trusted by path alone,
 * and PRDs were overwritten by title, so a different request that produced the
 * same title was planned with the previous request's assessment.
 */
export async function readCachedComplexity(prdPath: string, prdContent: string): Promise<ComplexityAssessment | null> {
  const path = deriveComplexityPath(prdPath)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { prd_sha256?: unknown }
    if (raw.prd_sha256 !== hashPrd(prdContent)) return null
    return parseComplexityAssessment(JSON.stringify(raw))
  } catch {
    return null
  }
}

async function writeCachedComplexity(prdPath: string, prdContent: string, assessment: ComplexityAssessment): Promise<void> {
  const record = { prd_sha256: hashPrd(prdContent), ...assessment }
  await writeFile(deriveComplexityPath(prdPath), JSON.stringify(record, null, 2) + '\n', 'utf8')
}

// ── Planning ────────────────────────────────────────────────────────────────

/** Rounds of fix-prd, and of fix-convoy, before the planner stops asking. */
const MAX_FIX_ROUNDS = 2

export interface PlanRequest {
  /** What the user asked for. Absent when re-planning from a PRD. */
  task?: string
  /** An existing PRD to plan from instead of writing one. */
  prdPath?: string
  /** The runtime every step runs on, resolved once by the caller. */
  adapter: AgentAdapter
  /** Its name, recorded in the spec so run and resume stay on it. */
  adapterName: string
  pkgRoot: string
  /** Defaults to the current directory. */
  projectRoot?: string
  verbose?: boolean
  /**
   * Have validate-convoy review the plan. Only when nobody will read it before
   * it runs (`--yes`): a person looking at the plan is the better reviewer,
   * and the session is skipped for them.
   */
  critic?: boolean
}

export interface PlanOutcome {
  /** Null for a small change, planned straight from the request. */
  prdPath: string | null
  specPath: string
  plan: TaskPlan
  settings: SpecSettings
  /** What still fails the checks after every fix. A spec with any is written, not runnable. */
  problems: string[]
  /** What planning took: sessions run, time, and spend as the runtime reported it. */
  planning?: PlanningSpend
}

export interface PlanningSpend {
  sessions: number
  ms: number
  tokens: number
  costUsd: number
  /** False when some session reported no cost, so `costUsd` is a lower bound. */
  costComplete: boolean
}

type StepRunner = (template: string, inputs: Omit<PromptStepOptions, 'template' | 'adapter' | 'pkgRoot'>) => Promise<PromptStepResult>

function done(text: string, detail = ''): void {
  console.log(`  ${c.green('✓')} ${text}${detail ? ` ${c.dim(detail)}` : ''}`)
}

function warn(text: string): void {
  console.log(`  ${c.yellow('⚠')} ${text}`)
}

/** Agent-written text, indented under the line that introduced it. */
function indented(text: string): string {
  return c.dim(text.trim().split('\n').map((line) => `    ${line}`).join('\n'))
}

function relPath(abs: string): string {
  const rel = relative(process.cwd(), abs)
  return rel && !rel.startsWith('..') ? rel : abs
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Like Promise.all, but waits for every step before reporting the first failure,
 * so a failed step never leaves its siblings' sessions running unwatched.
 */
async function settleAll<T>(work: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(work)
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value)
}

/** generate-convoy, with the one retry an unreadable answer gets. */
async function generatePlan(
  step: StepRunner,
  goal: string,
  context: string,
  label: string,
  convoyDir: string,
  signal?: AbortSignal,
  onStart?: () => void,
): Promise<TaskPlan> {
  let raw = ''
  let reason = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = (await step('generate-convoy', { goalText: goal, contextText: context, signal, onStart })).rawOutput
    const parsed = parseTaskPlanWithReason(raw)
    if (parsed.plan) return parsed.plan
    reason = parsed.reason ?? 'unreadable'
    if (attempt === 1) warn(`The ${label} plan could not be read (${reason}) — asking once more`)
  }
  await mkdir(convoyDir, { recursive: true })
  const kept = freePath(convoyDir, `${slugify(label) || 'plan'}.task-plan`, '.json')
  await writeFile(kept, raw + '\n', 'utf8')
  throw new Error(`The ${label} plan could not be read after a retry: ${reason}. The answer is in ${relPath(kept)}.`)
}

/** One fix-convoy round: patches applied to the plan, globs reduced again. */
async function fixPlan(step: StepRunner, plan: TaskPlan, problems: string): Promise<TaskPlan> {
  const answer = await step('fix-convoy', { goalText: JSON.stringify(plan, null, 2), contextText: problems })
  const patches = parsePatches(answer.rawOutput)
  if (!patches?.length) {
    warn('No usable patches came back')
    return plan
  }
  return normalizePlanFiles(applyPatches(plan, patches)).plan
}

/**
 * A step started before the planner knows it will use it.
 *
 * Planning was a chain of sessions, each waiting for the one before, and every
 * session costs its start-up and its answer however short the question. Where
 * the next step does not depend on the answer it waits for, it starts at the
 * same time, and is stopped if that answer says it is not needed.
 */
interface Speculation<T> {
  value: Promise<T>
  /**
   * Settles once its session has started, or once the step has failed without
   * one. The planner waits for it before starting the step that decides, so
   * the same answers always lead to the same sessions.
   */
  started: Promise<void>
  /** Stop the session and wait until it has stopped: its answer, if it finished first. */
  drop(): Promise<T | undefined>
}

function speculate<T>(start: (signal: AbortSignal, onStart: () => void) => Promise<T>): Speculation<T> {
  const control = new AbortController()
  let began!: () => void
  const sessionStarted = new Promise<void>((r) => (began = r))
  const value = start(control.signal, began)
  // Settled whether or not anyone awaits it, so a dropped step is not an
  // unhandled rejection.
  const settled = value.then((v) => v, () => undefined)
  return {
    value,
    started: Promise.race([sessionStarted, settled.then(() => undefined)]),
    drop: async () => {
      control.abort()
      return settled
    },
  }
}

/**
 * From a request (or an edited PRD) to a checked spec on disk.
 *
 * Sessions, all read-only, on the one adapter the caller resolved:
 * - assess-complexity on the request, beside a plan written straight from it,
 *   which is kept when the change is small and stopped when it is not;
 * - generate-prd, unless a PRD was given;
 * - validate-prd beside the plan from the PRD when how to plan it is already
 *   known, or beside assess-complexity on the PRD when it is not, which is
 *   skipped when this exact PRD was assessed before; up to two fix-prd +
 *   validate-prd rounds, and the plan is written again from the fixed PRD;
 * - generate-convoy, once, or once per group at the same time for a large
 *   feature; one retry when an answer cannot be read;
 * - fix-convoy only when the code's checks fail, at most twice;
 * - validate-convoy only as the reviewer for `--yes`.
 *
 * The semantic validate-convoy pass that followed every plan is gone: the
 * checks it was there for are done in code, and a person reads the plan
 * before it runs.
 */
function tasksPlanned(plan: TaskPlan): string {
  return `${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}`
}

/** Whether an assessment asks for the work to be planned as groups, side by side. */
function inGroups(c: ComplexityAssessment): boolean {
  return c.recommended_strategy === 'chain' && c.convoy_groups.length > 1
}

/** Where a PRD would go, for a change small enough to plan from the request alone. */
const NO_PRD = 'There is no PRD: this is a small change, planned straight from the request. Read the code it touches before you plan.'

export async function planConvoy(req: PlanRequest): Promise<PlanOutcome> {
  const root = req.projectRoot ?? process.cwd()
  const convoyDir = resolve(root, '.opencastle', 'convoys')
  // Planning is agent sessions too, and the run's own total never counted them.
  const started = Date.now()
  const spend: PlanningSpend = { sessions: 0, ms: 0, tokens: 0, costUsd: 0, costComplete: true }
  const step: StepRunner = async (template, inputs) => {
    let r: PromptStepResult
    try {
      r = await runPromptStep({ template, adapter: req.adapter, pkgRoot: req.pkgRoot, cwd: root, verbose: req.verbose, ...inputs })
    } catch (err) {
      // A stopped session ran, and spent what it never got to report.
      if (err instanceof StepCancelled) {
        spend.sessions++
        spend.costComplete = false
        spend.ms = Date.now() - started
      }
      throw err
    }
    spend.sessions++
    spend.tokens += r.tokens ?? 0
    if (r.costUsd === undefined) spend.costComplete = false
    else spend.costUsd += r.costUsd
    spend.ms = Date.now() - started
    return r
  }

  // ── A small change: no PRD ────────────────────────────────────────────────
  // When the request is small, the plan is written straight from it: a PRD,
  // its review and its fixes were four or five sessions and most of the
  // planning time — 7m 25s in a real run — for a change the request already
  // described. Neither the plan from the request nor the PRD depends on the
  // size, so all three start together, and the size decides which of the two
  // is kept: the other is stopped. Waiting for the size first added its whole
  // session, about 20s, to every plan.
  let prdPath: string | null = null
  let plan: TaskPlan | null = null
  let quick: ComplexityAssessment | null = null
  let drafting: Speculation<PromptStepResult> | null = null
  if (!req.prdPath && req.task) {
    const task = req.task
    const direct = speculate((signal, onStart) => generatePlan(step, task, NO_PRD, 'task', convoyDir, signal, onStart))
    drafting = speculate((signal, onStart) => step('generate-prd', { goalText: task, signal, onStart }))
    await Promise.all([direct.started, drafting.started])
    quick = await step('assess-complexity', { goalText: task, contextText: task })
      .then((r) => parseComplexityAssessment(r.rawOutput))
      .catch(() => null)
    if (quick?.complexity === 'low' && quick.recommended_strategy !== 'chain') {
      done('Sized', 'low — planned straight from the request, without a PRD')
      // A PRD that finished first is not left behind for a change that has none.
      const unneeded = await drafting.drop()
      if (unneeded?.outputPath) {
        await rm(unneeded.outputPath, { force: true })
        await rmdir(dirname(unneeded.outputPath)).catch(() => {})
      }
      plan = await direct.value
      done(`${tasksPlanned(plan)} planned`)
    } else {
      await direct.drop()
    }
  }

  if (!plan) {
    // ── The PRD ───────────────────────────────────────────────────────────────
    if (req.prdPath) {
      prdPath = resolve(root, req.prdPath)
      done('PRD', relPath(prdPath))
    } else {
      const written = drafting ? await drafting.value : await step('generate-prd', { goalText: req.task ?? '' })
      prdPath = written.outputPath!
      done('PRD written', relPath(prdPath))
    }
    let prd = await readFile(prdPath!, 'utf8')

    // Both only read the PRD, so they run side by side. fix-prd is told to keep
    // the PRD's phases, so the assessment of this draft still fits a fixed one;
    // it is cached under this draft's text, which is the text it describes.
    const cached = await readCachedComplexity(prdPath, prd)
    const assessedFrom = prd
    // The request was sized already. Only groups need sizing against the PRD,
    // whose phases they name.
    const known = cached ?? (quick && quick.recommended_strategy !== 'chain' ? quick : null)
    const goalFor = (c: ComplexityAssessment | null): string => req.task ?? c?.original_prompt ?? 'Implement the PRD.'
    // When how to plan it is known already, the plan starts beside the review:
    // most PRDs pass, and a plan from one that does not is written again from
    // the fixed text.
    const draft = prd
    let early = known && !inGroups(known)
      ? speculate((signal, onStart) =>
          generatePlan(step, goalFor(known), appendTaskComplexity(draft, known.task_complexity), 'task', convoyDir, signal, onStart))
      : null
    await early?.started
    let verdict: PromptStepResult
    let complexity: ComplexityAssessment | null
    try {
      ;[verdict, complexity] = await settleAll<PromptStepResult | ComplexityAssessment | null>([
        step('validate-prd', { goalText: `<!-- validation-pass: 1 -->\n${prd}` }),
        known
          ? Promise.resolve(known)
          : step('assess-complexity', { goalText: prd, contextText: req.task ?? '' })
              .then((r) => parseComplexityAssessment(r.rawOutput))
              .catch((err: unknown) => {
                warn(`Could not size the work (${message(err)}) — planning it as one`)
                return null
              }),
      ]) as [PromptStepResult, ComplexityAssessment | null]
    } catch (err) {
      await early?.drop()
      throw err
    }

    if (complexity && !cached && complexity !== quick) await writeCachedComplexity(prdPath, assessedFrom, complexity)

    if (verdict.isValid) {
      done('PRD checked')
    } else {
      await early?.drop()
      early = null
      let issues = verdict.errors || verdict.rawOutput
      let fixed = false
      for (let round = 1; round <= MAX_FIX_ROUNDS && !fixed; round++) {
        warn(`The PRD has issues — fixing (${round}/${MAX_FIX_ROUNDS})`)
        console.log(indented(issues))
        await step('fix-prd', { goalText: prd, contextText: issues, outputPath: prdPath })
        prd = await readFile(prdPath, 'utf8')
        const again = await step('validate-prd', { goalText: `<!-- validation-pass: ${round + 1} -->\n${prd}` })
        fixed = again.isValid === true
        if (!fixed) issues = again.errors || again.rawOutput
      }
      if (fixed) done('PRD fixed and checked')
      else warn(`The PRD still has issues after ${MAX_FIX_ROUNDS} fixes — planning from it anyway:\n${indented(issues)}`)
    }

    if (complexity) {
      done(cached ? 'Sized (cached for this PRD)' : 'Sized', `${complexity.complexity}, ${complexity.total_tasks} workstreams`)
    }

    // ── The tasks ─────────────────────────────────────────────────────────────
    let groups: ConvoyGroup[] | null = null
    if (complexity && inGroups(complexity)) {
      const check = validateComplexityGroups(complexity)
      if (check.valid) groups = topologicalSortGroups(complexity.convoy_groups)
      else warn(`Ignoring the suggested groups (${check.reason}) — planning it as one`)
    }

    if (groups) {
      const featureName =
        prd.match(/^# (.+?)\s*(?:—|-)?\s*PRD/m)?.[1].trim() ?? complexity?.original_prompt ?? 'Feature'
      const request = req.task ?? complexity?.original_prompt ?? ''
      const all = groups
      const plans = await settleAll(
        all.map((group) => {
          const goal = [
            request,
            '',
            '## Convoy Group Scope',
            '',
            `This is one of ${all.length} groups, all planned at the same time. Plan ONLY the phases listed here.`,
            'The planner joins the group plans into one spec: tasks of the groups this one depends on are',
            'finished before this group\'s first tasks start.',
            '',
            `- **Group name:** ${group.name}`,
            `- **Description:** ${group.description}`,
            `- **Phases to include:** ${group.phases.join(', ')}`,
            group.depends_on.length ? `- **Depends on groups:** ${group.depends_on.join(', ')}` : '',
          ].filter((line, i, lines) => line !== '' || lines[i - 1] !== '').join('\n')
          const context = appendTaskComplexity(
            extractRelevantPrdSections(prd, group.phases),
            filterTaskComplexityByPhases(complexity?.task_complexity, group.phases),
          )
          return generatePlan(step, goal, context, group.name, convoyDir)
        }),
      )
      plan = mergeGroupPlans(
        featureName,
        all.map((g, i) => ({ name: g.name, depends_on: g.depends_on, plan: plans[i] })),
      )
      done(`${tasksPlanned(plan)} planned`, `${all.length} groups, planned side by side`)
    } else {
      plan = early
        ? await early.value
        : await generatePlan(step, goalFor(complexity), appendTaskComplexity(prd, complexity?.task_complexity), 'task', convoyDir)
      done(`${tasksPlanned(plan)} planned`)
    }
  }

  const normalized = normalizePlanFiles(plan)
  plan = normalized.plan
  for (const note of normalized.notes) console.log(c.dim(`    files: ${note}`))
  const tests = foldTestOnlyTasks(plan)
  plan = tests.plan
  for (const [from, into] of tests.folded) console.log(c.dim(`    ${from} folded into ${into}: the agent that writes the code writes its tests`))

  // ── The spec ──────────────────────────────────────────────────────────────
  await mkdir(convoyDir, { recursive: true })
  const specPath = freePath(convoyDir, slugify(plan.name) || 'convoy', '.convoy.yml')
  const settings: SpecSettings = {
    adapter: req.adapterName,
    branch: `convoy/${basename(specPath, '.convoy.yml')}`,
    gates: detectGates(root),
  }

  let problems = checkPlan(plan, settings)
  for (let round = 1; round <= MAX_FIX_ROUNDS && problems.length > 0; round++) {
    warn(`The plan fails ${problems.length} check${problems.length === 1 ? '' : 's'} — fixing (${round}/${MAX_FIX_ROUNDS})`)
    console.log(indented(problems.join('\n')))
    plan = await fixPlan(step, plan, problems.map((p) => `- ${p}`).join('\n'))
    problems = checkPlan(plan, settings)
  }
  if (problems.length > 0) {
    const sequenced = sequenceConflicts(plan)
    if (sequenced.added.length > 0) {
      plan = sequenced.plan
      problems = checkPlan(plan, settings)
      for (const [later, earlier] of sequenced.added) {
        console.log(c.dim(`    ${later} now waits for ${earlier}: they claim the same files`))
      }
    }
  }
  if (problems.length === 0) done('Plan checked')

  if (req.critic && problems.length === 0) {
    const review = await step('validate-convoy', { goalText: buildConvoyYaml(plan, settings) })
    if (review.isValid) {
      done('Plan reviewed')
    } else {
      const issues = review.errors || review.rawOutput
      warn('The review found issues — fixing once')
      console.log(indented(issues))
      const revised = await fixPlan(step, plan, issues)
      if (checkPlan(revised, settings).length === 0) {
        plan = revised
        done('Plan revised after review')
      } else {
        warn('The revision fails the checks — keeping the plan as it was')
      }
    }
  }

  await writeFile(specPath, buildConvoyYaml(plan, settings), 'utf8')
  return { prdPath, specPath, plan, settings, problems, planning: spend }
}

// ── Showing the plan ────────────────────────────────────────────────────────

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width)
  return text.slice(0, Math.max(0, width - 1)) + '…'
}

/**
 * The plan as a few lines a person can check before saying yes: who does what,
 * after what, touching which files.
 */
export function renderPlan(outcome: Pick<PlanOutcome, 'plan' | 'settings' | 'specPath' | 'planning'>, columns = 100): string[] {
  const { plan, settings } = outcome
  const rows = plan.tasks.map((t) => ({
    id: t.id,
    agent: t.agent ?? 'developer',
    deps: t.depends_on?.length ? t.depends_on.join(', ') : '–',
    files: t.files?.length ? t.files.join(', ') : '(any)',
  }))
  const width = (pick: (r: (typeof rows)[number]) => string, header: string, cap: number): number =>
    Math.min(cap, Math.max(header.length, ...rows.map((r) => pick(r).length)))
  const idW = width((r) => r.id, 'TASK', 32)
  const agentW = width((r) => r.agent, 'AGENT', 18)
  const depsW = width((r) => r.deps, 'DEPENDS ON', 30)
  const filesW = Math.max(20, columns - 4 - idW - agentW - depsW - 6)
  const line = (a: string, b: string, d: string, f: string): string =>
    `    ${fit(a, idW)}  ${fit(b, agentW)}  ${fit(d, depsW)}  ${fit(f, filesW).trimEnd()}`

  const at = planConcurrency(plan)
  const out = [
    '',
    `  ${c.bold(`Plan: ${plan.name}`)} ${c.dim(`— ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}, up to ${at} at a time`)}`,
    '',
    c.dim(line('TASK', 'AGENT', 'DEPENDS ON', 'FILES')),
    ...rows.map((r) => line(r.id, r.agent, r.deps, r.files)),
    '',
    `  ${c.dim('Branch')} ${settings.branch} ${c.dim('· runtime')} ${settings.adapter}` +
      (settings.gates.length ? ` ${c.dim('· then once:')} ${settings.gates.join(', ')}` : ''),
    `  ${c.dim('Spec')}   ${relPath(outcome.specPath)}`,
    ...(outcome.planning ? [`  ${c.dim('Planned')} ${describeSpend(outcome.planning)}`] : []),
    '',
  ]
  return out
}

function describeSpend(s: PlanningSpend): string {
  const secs = Math.round(s.ms / 1000)
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  const tokens = s.tokens >= 1_000_000 ? `${(s.tokens / 1_000_000).toFixed(1)}M` : s.tokens >= 1000 ? `${Math.round(s.tokens / 1000)}K` : String(s.tokens)
  const cost = s.costUsd > 0 || s.costComplete ? ` · $${s.costUsd.toFixed(2)}${s.costComplete ? '' : '+ (not every session reported a cost)'}` : ''
  return `in ${time} · ${s.sessions} session${s.sessions === 1 ? '' : 's'} · ${tokens} tokens${cost}`
}

// ── The command ─────────────────────────────────────────────────────────────

const HELP = `
  opencastle convoy plan --prd <file> [options]

  Plan again from a PRD you edited. The PRD is checked, broken into tasks and
  written as a spec; you see the plan and are asked before it runs.

  Options:
    --prd <file>             The PRD to plan from (opencastle convoy "<task>" writes
                             them to .opencastle/prds/)
    --yes, -y                Run the plan without asking
    --dry-run                Plan and write the spec, but do not run it
    --adapter, -a <name>     Agent runtime to plan and run with
    --concurrency, -c <n>    Tasks at once when it runs
    --verbose                Show each planning session's output
    --help, -h               Show this help
`

interface CliOptions {
  prd: string | null
  yes: boolean
  dryRun: boolean
  adapter: string | null
  concurrency: number | null
  verbose: boolean
  help: boolean
}

/** Flags `convoy "<task>"` and `convoy plan` share; `--prd` is plan's alone. */
function parseArgs(args: string[], allowPrd: boolean): CliOptions {
  const opts: CliOptions = { prd: null, yes: false, dryRun: false, adapter: null, concurrency: null, verbose: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = args[i + 1]
    if (v === undefined || !v.trim() || v.startsWith('-')) {
      console.error(`  ✗ ${flag} needs a value`)
      process.exit(1)
    }
    return v
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--prd':
        if (!allowPrd) {
          console.error(`  ✗ --prd belongs to \`opencastle convoy plan\`: plan from a task or from a PRD, not both.`)
          process.exit(1)
        }
        opts.prd = value(i++, arg)
        break
      case '--yes':
      case '-y':
        opts.yes = true
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--adapter':
      case '-a':
        opts.adapter = value(i++, arg)
        break
      case '--concurrency':
      case '-c': {
        const raw = value(i++, arg)
        const n = Number(raw)
        if (!/^\d+$/.test(raw) || n < 1 || n > 50) {
          console.error(`  ✗ --concurrency must be a whole number from 1 to 50, not "${raw}"`)
          process.exit(1)
        }
        opts.concurrency = n
        break
      }
      case '--verbose':
        opts.verbose = true
        break
      default:
        console.error(`  ✗ Unknown option: ${arg}`)
        console.error(`  ${c.dim('Accepts:')} --yes --dry-run --adapter --concurrency --verbose --help${allowPrd ? ' --prd' : ''}`)
        process.exit(1)
    }
  }
  return opts
}

/**
 * The runtime for the whole plan, and the run after it, chosen once by the
 * rule `resolveAdapter` owns: `--adapter`, else what `opencastle init` set up,
 * else what is on PATH.
 */
async function chooseRuntime(projectRoot: string, explicit: string | null): Promise<ResolvedAdapter> {
  try {
    return await resolveAdapter({ projectRoot, explicit })
  } catch (err) {
    console.error(`  ${c.red('✗')} ${message(err)}`)
    process.exit(1)
  }
}

/**
 * Plan, show the plan once, ask once, run.
 *
 * Nothing runs without a yes. A closed stdin is not one: piped into a script,
 * the old prompt's default-yes started a full convoy nobody had agreed to.
 */
async function planThenRun(source: { task: string } | { prd: string }, opts: CliOptions, pkgRoot: string): Promise<void> {
  const projectRoot = process.cwd()
  const runtime = await chooseRuntime(findProjectRoot(projectRoot) ?? projectRoot, opts.adapter)
  console.log(`\n  ${c.bold('opencastle convoy')} ${c.dim('— planning, read-only')}`)
  console.log(`  ${c.dim('Runtime:')} ${runtime.detail}\n`)

  let outcome: PlanOutcome
  try {
    outcome = await planConvoy({
      task: 'task' in source ? source.task : undefined,
      prdPath: 'prd' in source ? source.prd : undefined,
      adapter: runtime.adapter,
      adapterName: runtime.name,
      pkgRoot,
      verbose: opts.verbose,
      critic: opts.yes && !opts.dryRun,
    })
  } catch (err) {
    console.error(`\n  ${c.red('✗')} Planning stopped: ${message(err)}`)
    await cleanupAdapters()
    process.exit(1)
  }

  for (const row of renderPlan(outcome, process.stdout.columns ?? 100)) console.log(row)
  const later = `opencastle convoy run ${relPath(outcome.specPath)}`

  if (outcome.problems.length > 0) {
    console.error(`  ${c.red('✗')} The plan still fails these checks, so it was not started:`)
    for (const p of outcome.problems) console.error(`    • ${p}`)
    console.error(`\n  Edit the spec, then: ${later}\n`)
    await cleanupAdapters()
    process.exit(1)
  }

  if (opts.dryRun) {
    console.log(`  ${c.dim('Dry run — not started. To run it:')} ${later}\n`)
    await cleanupAdapters()
    return
  }

  const go = opts.yes || (await confirm('Run it?', true, 'refuse'))
  closePrompts()
  if (!go) {
    console.log(`\n  ${c.dim('Not started. To run it later:')} ${later}\n`)
    await cleanupAdapters()
    return
  }

  // The run takes the spec by its path, as `convoy run <spec>` does, on the
  // runtime already chosen and printed above.
  const { runSpec, exitWith } = await import('./run.js')
  let code = 1
  try {
    code = await runSpec(
      { spec: outcome.specPath, dryRun: false, adapter: opts.adapter, concurrency: opts.concurrency, verbose: opts.verbose, help: false },
      { runtime },
    )
  } finally {
    closePrompts()
    await cleanupAdapters()
  }
  exitWith(code)
}

/** `opencastle convoy "<task>"`: the task comes from the words typed, the flags from `args`. */
export async function planTask({ args, pkgRoot }: CliContext, task: string): Promise<void> {
  const opts = parseArgs(args, false)
  await planThenRun({ task }, opts, pkgRoot)
}

/** `opencastle convoy plan --prd <file>`. */
export default async function pipeline({ args, pkgRoot }: CliContext): Promise<void> {
  const opts = parseArgs(args, true)
  if (opts.help) {
    console.log(HELP)
    return
  }
  if (opts.prd === null) {
    console.error('  ✗ Name the PRD to plan from: opencastle convoy plan --prd <file>')
    console.log(HELP)
    process.exit(1)
  }
  if (!existsSync(resolve(process.cwd(), opts.prd))) {
    console.error(`  ✗ PRD not found: ${opts.prd}`)
    process.exit(1)
  }
  await planThenRun({ prd: opts.prd }, opts, pkgRoot)
}
