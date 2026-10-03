import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, basename } from 'node:path'
import { c, confirm, closePrompts } from './prompt.js'
import { runPromptStep, freePath } from './plan.js'
import type { PromptStepOptions, PromptStepResult } from './plan.js'
import { detectAdapter, getAdapter, cleanupAdapters } from './run/adapters/index.js'
import type { AgentAdapter } from './convoy/spec-types.js'
import type { CliContext } from './types.js'
import {
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
  prdPath: string
  specPath: string
  plan: TaskPlan
  settings: SpecSettings
  /** What still fails the checks after every fix. A spec with any is written, not runnable. */
  problems: string[]
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
async function generatePlan(step: StepRunner, goal: string, context: string, label: string, convoyDir: string): Promise<TaskPlan> {
  let raw = ''
  let reason = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = (await step('generate-convoy', { goalText: goal, contextText: context })).rawOutput
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
 * From a request (or an edited PRD) to a checked spec on disk.
 *
 * Sessions, all read-only, on the one adapter the caller resolved:
 * - generate-prd, unless a PRD was given;
 * - validate-prd beside assess-complexity, which is skipped when this exact
 *   PRD was assessed before; up to two fix-prd + validate-prd rounds;
 * - generate-convoy, once, or once per group at the same time for a large
 *   feature; one retry when an answer cannot be read;
 * - fix-convoy only when the code's checks fail, at most twice;
 * - validate-convoy only as the reviewer for `--yes`.
 *
 * The semantic validate-convoy pass that followed every plan is gone: the
 * checks it was there for are done in code, and a person reads the plan
 * before it runs.
 */
export async function planConvoy(req: PlanRequest): Promise<PlanOutcome> {
  const root = req.projectRoot ?? process.cwd()
  const convoyDir = resolve(root, '.opencastle', 'convoys')
  const step: StepRunner = (template, inputs) =>
    runPromptStep({ template, adapter: req.adapter, pkgRoot: req.pkgRoot, cwd: root, verbose: req.verbose, ...inputs })

  // ── The PRD ───────────────────────────────────────────────────────────────
  let prdPath: string
  if (req.prdPath) {
    prdPath = resolve(root, req.prdPath)
    done('PRD', relPath(prdPath))
  } else {
    const written = await step('generate-prd', { goalText: req.task ?? '' })
    prdPath = written.outputPath!
    done('PRD written', relPath(prdPath))
  }
  let prd = await readFile(prdPath, 'utf8')

  // Both only read the PRD, so they run side by side. fix-prd is told to keep
  // the PRD's phases, so the assessment of this draft still fits a fixed one;
  // it is cached under this draft's text, which is the text it describes.
  const cached = await readCachedComplexity(prdPath, prd)
  const assessedFrom = prd
  const [verdict, complexity] = await settleAll<PromptStepResult | ComplexityAssessment | null>([
    step('validate-prd', { goalText: `<!-- validation-pass: 1 -->\n${prd}` }),
    cached
      ? Promise.resolve(cached)
      : step('assess-complexity', { goalText: prd, contextText: req.task ?? '' })
          .then((r) => parseComplexityAssessment(r.rawOutput))
          .catch((err: unknown) => {
            warn(`Could not size the work (${message(err)}) — planning it as one`)
            return null
          }),
  ]) as [PromptStepResult, ComplexityAssessment | null]

  if (complexity && !cached) await writeCachedComplexity(prdPath, assessedFrom, complexity)

  if (verdict.isValid) {
    done('PRD checked')
  } else {
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
  if (complexity?.recommended_strategy === 'chain' && complexity.convoy_groups.length > 1) {
    const check = validateComplexityGroups(complexity)
    if (check.valid) groups = topologicalSortGroups(complexity.convoy_groups)
    else warn(`Ignoring the suggested groups (${check.reason}) — planning it as one`)
  }

  let plan: TaskPlan
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
    done(`${plan.tasks.length} tasks planned`, `${all.length} groups, planned side by side`)
  } else {
    const goal = req.task ?? complexity?.original_prompt ?? 'Implement the PRD.'
    plan = await generatePlan(step, goal, appendTaskComplexity(prd, complexity?.task_complexity), 'task', convoyDir)
    done(`${plan.tasks.length} tasks planned`)
  }

  const normalized = normalizePlanFiles(plan)
  plan = normalized.plan
  for (const note of normalized.notes) console.log(c.dim(`    files: ${note}`))

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
  return { prdPath, specPath, plan, settings, problems }
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
export function renderPlan(outcome: Pick<PlanOutcome, 'plan' | 'settings' | 'specPath'>, columns = 100): string[] {
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
    '',
  ]
  return out
}

// ── The command ─────────────────────────────────────────────────────────────

const HELP = `
  opencastle convoy plan --prd <file> [options]

  Plan again from a PRD you edited. The PRD is checked, broken into tasks and
  written as a spec; you see the plan and are asked before it runs.

  Options:
    --prd <file>           The PRD to plan from (opencastle convoy "<task>" writes
                           them to .opencastle/prds/)
    --yes, -y              Run the plan without asking
    --dry-run              Plan and write the spec, but do not run it
    --adapter, -a <name>   Agent runtime to plan and run with
    --verbose              Show each planning session's output
    --help, -h             Show this help
`

interface CliOptions {
  task: string | null
  prd: string | null
  yes: boolean
  dryRun: boolean
  adapter: string | null
  verbose: boolean
  help: boolean
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { task: null, prd: null, yes: false, dryRun: false, adapter: null, verbose: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = args[i + 1]
    if (v === undefined || !v.trim()) {
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
      // How `opencastle convoy "<task>"` hands over the task. Not documented:
      // nobody types it, and `convoy plan` exists for planning from a PRD.
      case '--text':
        opts.task = value(i++, arg)
        break
      case '--prd':
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
      case '--verbose':
        opts.verbose = true
        break
      default:
        console.error(`  ✗ Unknown option: ${arg}`)
        console.error(`  ${c.dim('Accepts:')} --yes --dry-run --adapter --verbose --help (and --prd for convoy plan)`)
        process.exit(1)
    }
  }
  return opts
}

function printAdapterError(detectionFailed: boolean, adapterName: string): void {
  if (detectionFailed) {
    console.error(
      `  ✗ No agent CLI found on your PATH.\n` +
        `    Install one of these, or name one with --adapter <name>:\n` +
        `    • claude     — npm install -g @anthropic-ai/claude-code\n` +
        `    • codex      — npm install -g @openai/codex\n` +
        `    • cursor     — https://cursor.com (Cursor > Install CLI)\n` +
        `    • opencode   — https://opencode.ai\n` +
        `    • copilot    — https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli`,
    )
    return
  }
  const cliName = adapterName === 'cursor' ? 'agent' : adapterName
  console.error(
    `  ✗ Adapter "${adapterName}" is not available.\n` +
      `    Make sure the "${cliName}" CLI is installed and on your PATH.`,
  )
}

/**
 * The runtime for the whole plan, chosen once.
 *
 * Detection stands in until `resolveAdapter` lands, which also reads what
 * `opencastle init` configured; the call site is the only thing that changes.
 */
async function chooseAdapter(explicit: string | null): Promise<{ name: string; adapter: AgentAdapter; how: string }> {
  const name = explicit ?? (await detectAdapter())
  if (!name) {
    printAdapterError(true, '')
    process.exit(1)
  }
  let adapter: AgentAdapter
  try {
    adapter = await getAdapter(name)
  } catch (err) {
    console.error(`  ✗ ${message(err)}`)
    process.exit(1)
  }
  if (!(await adapter.isAvailable())) {
    printAdapterError(false, name)
    process.exit(1)
  }
  return { name, adapter, how: explicit ? '--adapter' : 'detected' }
}

/**
 * `opencastle convoy "<task>"` and `opencastle convoy plan --prd <file>`:
 * plan, show the plan once, ask once, run.
 *
 * Nothing runs without a yes. A closed stdin is not one: piped into a script,
 * the old prompt's default-yes started a full convoy nobody had agreed to.
 */
export default async function pipeline({ args, pkgRoot }: CliContext): Promise<void> {
  const opts = parseArgs(args)
  if (opts.help) {
    console.log(HELP)
    return
  }
  if (opts.task !== null && opts.prd !== null) {
    console.error('  ✗ Plan from a task or from a PRD, not both.')
    process.exit(1)
  }
  if (opts.task === null && opts.prd === null) {
    console.error('  ✗ Name the PRD to plan from: opencastle convoy plan --prd <file>')
    console.log(HELP)
    process.exit(1)
  }
  if (opts.prd !== null && !existsSync(resolve(process.cwd(), opts.prd))) {
    console.error(`  ✗ PRD not found: ${opts.prd}`)
    process.exit(1)
  }

  const { name, adapter, how } = await chooseAdapter(opts.adapter)
  console.log(`\n  ${c.bold('opencastle convoy')} ${c.dim(`— planning with ${name} (${how}), read-only`)}\n`)

  let outcome: PlanOutcome
  try {
    outcome = await planConvoy({
      task: opts.task ?? undefined,
      prdPath: opts.prd ?? undefined,
      adapter,
      adapterName: name,
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

  try {
    const runModule = await import('./run.js')
    const runArgs = ['-f', outcome.specPath]
    if (opts.adapter) runArgs.push('-a', opts.adapter)
    if (opts.verbose) runArgs.push('--verbose')
    await runModule.default({ args: runArgs, pkgRoot })
  } finally {
    closePrompts()
    await cleanupAdapters()
  }
}
