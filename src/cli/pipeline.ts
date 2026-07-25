import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { stringify } from 'yaml'
import { c, confirm, closePrompts } from './prompt.js'
import { runPromptStep, readProjectMcpServers } from './plan.js'
import type { PromptStepOptions } from './plan.js'
import { cleanupAdapters } from './run/adapters/index.js'
import type { CliContext } from './types.js'
import { parseYaml, validateSpec } from './run/schema.js'
import { buildConvoyYaml, parseTaskPlanWithReason, parsePatches, applyPatches, deriveSpecEnrichment, detectJsonTruncation } from './convoy/spec-builder.js'
import type { TaskPlan, SpecEnrichment } from './convoy/spec-builder.js'

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

  let currentSection = ''
  let inTaskBreakdown = false
  let inRelevantPhase = false
  let skipSection = false

  for (const line of lines) {
    // Detect heading (## level)
    const h2Match = line.match(/^## (.+)/)
    if (h2Match) {
      const heading = h2Match[1].trim().toLowerCase()
      currentSection = heading
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

const HELP = `
  opencastle convoy plan [options]

  Run the full convoy generation pipeline from a feature prompt:

    Step 1 — Generate PRD        (generate-prd)
    Step 2 — Validate PRD        (validate-prd)
    Step 3 — Fix PRD             (fix-prd, up to 2 retries if invalid)
    Step 4 — Assess complexity    (assess-complexity, determines single vs chain)
    Step 5 — Generate task plan   (generate-convoy outputs JSON, code builds YAML)
    Step 6 — Validate convoy spec (programmatic + semantic validation)
    Step 7 — Fix convoy spec      (patch-based fixing, up to 2 retries)

  Options:
    --text, -t <text>        Feature prompt text (required, unless --prd is set)
    --prd <path>             Skip step 1 — use an existing PRD file
    --output-prd <path>      Override path for the generated PRD
    --output-spec <path>     Override path for the generated convoy spec
    --adapter, -a <name>     Override agent runtime adapter
    --verbose                Show full agent output for each step
    --dry-run                Generate and print the PRD prompt only, then stop
    --complexity <path>      Skip complexity assessment — use an existing complexity file
    --skip-validation        Skip PRD and convoy validation (steps 2, 3, 6, 7)
    --help, -h               Show this help
`

interface PipelineOptions {
  text: string | null
  prd: string | null
  complexity: string | null
  outputPrd: string | null
  outputSpec: string | null
  adapter: string | null
  verbose: boolean
  dryRun: boolean
  skipValidation: boolean
  help: boolean
}

function parseArgs(args: string[]): PipelineOptions {
  const opts: PipelineOptions = {
    text: null,
    prd: null,
    complexity: null,
    outputPrd: null,
    outputSpec: null,
    adapter: null,
    verbose: false,
    dryRun: false,
    skipValidation: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--text':
      case '-t':
        if (i + 1 >= args.length) { console.error('  ✗ --text requires a value'); process.exit(1) }
        opts.text = args[++i]
        if (!opts.text.trim()) { console.error('  ✗ --text cannot be empty'); process.exit(1) }
        break
      case '--prd':
        if (i + 1 >= args.length) { console.error('  ✗ --prd requires a path'); process.exit(1) }
        opts.prd = args[++i]
        break
      case '--complexity':
        if (i + 1 >= args.length) { console.error('  ✗ --complexity requires a path'); process.exit(1) }
        opts.complexity = args[++i]
        break
      case '--output-prd':
        if (i + 1 >= args.length) { console.error('  ✗ --output-prd requires a path'); process.exit(1) }
        opts.outputPrd = args[++i]
        break
      case '--output-spec':
        if (i + 1 >= args.length) { console.error('  ✗ --output-spec requires a path'); process.exit(1) }
        opts.outputSpec = args[++i]
        break
      case '--adapter':
      case '-a':
        if (i + 1 >= args.length) { console.error('  ✗ --adapter requires a name'); process.exit(1) }
        opts.adapter = args[++i]
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--dry-run':
      case '--dryRun':
        opts.dryRun = true
        break
      case '--skip-validation':
        opts.skipValidation = true
        break
      default:
        console.error(`  ✗ Unknown option: ${arg}. Run with --help to see available options.`)
        process.exit(1)
    }
  }

  return opts
}

const MAX_FIX_RETRIES = 2

function relPath(abs: string): string {
  return abs.startsWith(process.cwd()) ? abs.slice(process.cwd().length + 1) : abs
}

function stepLabel(n: number, total: number, name: string): string {
  return c.bold(c.cyan(`  [${n}/${total}] ${name}`))
}

async function fixPrd(
  sharedOpts: Omit<PromptStepOptions, 'template' | 'goalText'>,
  prdPath: string,
  prdContent: string,
  initialErrors: string,
  totalSteps: number,
  adapterFlag: string | null,
): Promise<void> {
  const MAX_PRD_FIX_RETRIES = 2
  let fixedPrdContent = prdContent
  let prdValidationErrors = initialErrors
  let prdFixed = false

  for (let attempt = 1; attempt <= MAX_PRD_FIX_RETRIES; attempt++) {
    const label = `Fix PRD attempt ${attempt}/${MAX_PRD_FIX_RETRIES}…`
    console.log(stepLabel(3, totalSteps, label))

    try {
      await runPromptStep({
        ...sharedOpts,
        template: 'fix-prd',
        goalText: fixedPrdContent,
        contextText: prdValidationErrors,
        outputPath: prdPath,
      })
    } catch (err) {
      console.error(`\n  ✗ Step 3 (attempt ${attempt}) failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    console.log(c.dim(`  Re-validating after fix…`))

    fixedPrdContent = await readFile(prdPath, 'utf8')

    let revalidation
    try {
      revalidation = await runPromptStep({
        ...sharedOpts,
        template: 'validate-prd',
        goalText: `<!-- validation-pass: ${attempt + 1} -->\n${fixedPrdContent}`,
      })
    } catch (err) {
      console.error(`\n  ✗ Re-validation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    if (revalidation.isValid) {
      console.log(c.green(`  ✓ PRD fixed and validated\n`))
      prdFixed = true
      break
    }

    prdValidationErrors = revalidation.errors ?? revalidation.rawOutput

    if (attempt < MAX_PRD_FIX_RETRIES) {
      console.log(c.yellow(`  ⚠ Still has issues after fix attempt ${attempt} — retrying…\n`))
      console.log(c.dim(prdValidationErrors))
      console.log()
    }
  }

  if (!prdFixed) {
    console.log(c.yellow(`\n  ⚠ Could not fully auto-fix the PRD after ${MAX_PRD_FIX_RETRIES} attempts — continuing with best-effort PRD.\n`))
    console.log(c.dim(`  Remaining issues:\n`))
    console.log(c.dim(prdValidationErrors))
    console.log(
      c.dim(`\n  PRD saved to ${relPath(prdPath)} with best available fixes.`) +
        c.dim(`\n  You can re-validate later with:\n`) +
        `    opencastle convoy plan --prd ${relPath(prdPath)}${adapterFlag ? ` --adapter ${adapterFlag}` : ''}\n`
    )
  }
}

export default async function pipeline({ args, pkgRoot }: CliContext): Promise<void> {
  const opts = parseArgs(args)

  if (opts.help) {
    console.log(HELP)
    return
  }

  if (!opts.text && !opts.prd) {
    console.error(`  ✗ Either --text or --prd is required.`)
    console.log(HELP)
    process.exit(1)
  }

  if (opts.text && opts.prd) {
    console.error(`  ✗ --text and --prd are mutually exclusive.`)
    process.exit(1)
  }

  if (opts.prd) {
    const resolvedPrd = resolve(process.cwd(), opts.prd)
    if (!existsSync(resolvedPrd)) {
      console.error(`  ✗ PRD file not found: ${opts.prd}`)
      process.exit(1)
    }
  }

  const totalSteps = opts.skipValidation ? 4 : 7
  const mcpServers = await readProjectMcpServers(process.cwd())
  const sharedOpts = {
    adapterName: opts.adapter ?? undefined,
    verbose: opts.verbose,
    pkgRoot,
    ...(mcpServers.length ? { mcpServers } : {}),
  }

  console.log(c.bold('\n  opencastle convoy\n'))

  // ── Step 1: Generate PRD ──────────────────────────────────────────────────
  let prdPath: string

  if (opts.prd) {
    prdPath = resolve(process.cwd(), opts.prd)
    console.log(c.dim(`  [−] Skipping PRD generation — using: ${relPath(prdPath)}`))
  } else {
    console.log(stepLabel(1, totalSteps, 'Generating PRD…'))

    let result
    try {
      result = await runPromptStep({
        ...sharedOpts,
        template: 'generate-prd',
        goalText: opts.text!,
        outputPath: opts.outputPrd ? resolve(process.cwd(), opts.outputPrd) : undefined,
        dryRun: opts.dryRun,
      })
    } catch (err) {
      console.error(`\n  ✗ Step 1 failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    if (opts.dryRun) {
      console.log(c.dim('\n  [dry-run] Stopping after step 1. Remove --dry-run to run the full pipeline.'))
      return
    }

    prdPath = result.outputPath!
    console.log(c.green(`  ✓ PRD written to ${relPath(prdPath)}\n`))
  }

  // Handle --dry-run when PRD was provided externally (not generated)
  if (opts.dryRun && opts.prd) {
    console.log(c.dim('\n  [dry-run] Nothing to preview — PRD already provided via --prd. Remove --dry-run to continue.'))
    return
  }

  // ── Steps 2 + 4: Validate PRD & Assess complexity (in parallel) ────────
  // Both only read the PRD — run them concurrently to save one LLM round-trip.
  // If validation fails we still use the complexity result (fix-prd patches
  // issues without changing the overall structure/phases).

  const complexityStep = opts.skipValidation ? 2 : 4

  let complexity: ComplexityAssessment | null = null
  const complexityFilePath = opts.complexity
    ? resolve(process.cwd(), opts.complexity)
    : deriveComplexityPath(prdPath)

  // Check for cached / provided complexity before launching LLM calls
  if (opts.complexity) {
    if (!existsSync(complexityFilePath)) {
      console.error(`  ✗ Complexity file not found: ${opts.complexity}`)
      process.exit(1)
    }
    try {
      const raw = await readFile(complexityFilePath, 'utf8')
      complexity = parseComplexityAssessment(raw)
      if (complexity) {
        console.log(c.dim(`  [−] Using existing complexity assessment: ${relPath(complexityFilePath)}`))
      } else {
        console.error(`  ✗ Invalid complexity file: ${opts.complexity}`)
        process.exit(1)
      }
    } catch (err) {
      console.error(`  ✗ Failed to read complexity file: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  } else if (existsSync(complexityFilePath)) {
    try {
      const raw = await readFile(complexityFilePath, 'utf8')
      const cached = parseComplexityAssessment(raw)
      if (cached) {
        complexity = cached
        console.log(c.dim(`  [−] Using existing complexity assessment: ${relPath(complexityFilePath)}`))
      }
    } catch {
      // ignore — fall through to LLM assessment
    }
  }

  const needsValidation = !opts.skipValidation
  const needsComplexity = !complexity

  if (needsValidation || needsComplexity) {
    const prdContent = await readFile(prdPath, 'utf8')

    // Launch validation and complexity in parallel when both are needed
    if (needsValidation && needsComplexity) {
      console.log(stepLabel(2, totalSteps, 'Validating PRD…'))
      console.log(stepLabel(complexityStep, totalSteps, 'Assessing complexity…'))
      console.log(c.dim(`  (running in parallel)\n`))

      const [validationResult, complexityResult] = await Promise.all([
        runPromptStep({
          ...sharedOpts,
          template: 'validate-prd',
          goalText: `<!-- validation-pass: 1 -->\n${prdContent}`,
        }).catch((err) => {
          console.error(`\n  ✗ Validation failed: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }),
        runPromptStep({
          ...sharedOpts,
          template: 'assess-complexity',
          filePath: prdPath,
          contextText: opts.text ?? undefined,
        }).catch((err) => {
          console.warn(c.yellow(`  ⚠ Complexity assessment failed: ${err instanceof Error ? err.message : String(err)}`))
          return null
        }),
      ])

      // Process complexity result
      if (complexityResult) {
        complexity = parseComplexityAssessment(complexityResult.rawOutput)
        if (complexity) {
          await writeFile(complexityFilePath, JSON.stringify(complexity, null, 2), 'utf8')
          console.log(c.green(`  ✓ Complexity assessment saved to ${relPath(complexityFilePath)}`))
        }
      }

      // Process validation result
      if (!validationResult) {
        process.exit(1)
      }

      if (!validationResult.isValid) {
        let prdValidationErrors = validationResult.errors ?? validationResult.rawOutput
        console.log(c.yellow(`  ⚠ PRD has validation issues — attempting auto-fix…\n`))
        console.log(c.dim(prdValidationErrors))
        console.log()

        await fixPrd(sharedOpts, prdPath, prdContent, prdValidationErrors, totalSteps, opts.adapter)
      } else {
        console.log(c.green(`  ✓ PRD is valid\n`))
      }
    } else if (needsValidation) {
      // Only validation needed (complexity was cached)
      console.log(stepLabel(2, totalSteps, 'Validating PRD…'))

      let result
      try {
        result = await runPromptStep({
          ...sharedOpts,
          template: 'validate-prd',
          goalText: `<!-- validation-pass: 1 -->\n${prdContent}`,
        })
      } catch (err) {
        console.error(`\n  ✗ Step 2 failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      if (!result.isValid) {
        let prdValidationErrors = result.errors ?? result.rawOutput
        console.log(c.yellow(`  ⚠ PRD has validation issues — attempting auto-fix…\n`))
        console.log(c.dim(prdValidationErrors))
        console.log()

        await fixPrd(sharedOpts, prdPath, prdContent, prdValidationErrors, totalSteps, opts.adapter)
      } else {
        console.log(c.green(`  ✓ PRD is valid\n`))
      }
    } else {
      // Only complexity needed (validation skipped)
      console.log(stepLabel(complexityStep, totalSteps, 'Assessing complexity…'))
      try {
        const complexityResult = await runPromptStep({
          ...sharedOpts,
          template: 'assess-complexity',
          filePath: prdPath,
          contextText: opts.text ?? undefined,
        })
        complexity = parseComplexityAssessment(complexityResult.rawOutput)
        if (complexity) {
          await writeFile(complexityFilePath, JSON.stringify(complexity, null, 2), 'utf8')
          console.log(c.green(`  ✓ Complexity assessment saved to ${relPath(complexityFilePath)}\n`))
        }
      } catch (err) {
        console.warn(c.yellow(`  ⚠ Complexity assessment failed: ${err instanceof Error ? err.message : String(err)}`))
        console.warn(c.dim(`    Falling back to single convoy strategy.\n`))
      }
    }
  }

  if (!complexity) {
    console.log(c.dim(`  Could not determine complexity — using single convoy strategy.\n`))
  }

  if (complexity) {
    if (complexity.recommended_strategy === 'chain' && complexity.convoy_groups.length > 1) {
      // Validate complexity groups before chain generation
      const groupValidation = validateComplexityGroups(complexity)
      if (!groupValidation.valid) {
        console.log(c.yellow(`  ⚠ Complexity groups failed validation: ${groupValidation.reason}`))
        console.log(c.yellow(`  Falling back to single convoy strategy.\n`))
        // Fall through to single-spec generation below
      } else {
        // Sort groups in dependency order
        complexity.convoy_groups = topologicalSortGroups(complexity.convoy_groups)
        console.log(
          c.cyan(`  ℹ`) +
            ` Complexity: ${complexity.complexity} | Strategy: chain | ${complexity.convoy_groups.length} convoy groups\n`
        )
        console.log(`  Chain plan:`)
        for (let i = 0; i < complexity.convoy_groups.length; i++) {
          const g = complexity.convoy_groups[i]
          const depStr =
            g.depends_on.length > 0 ? ` → depends on: ${g.depends_on.join(', ')}` : ''
          console.log(
            `    ${i + 1}. ${g.name.padEnd(20)} (phases: ${g.phases.join(', ')})${depStr}`
          )
        }
        console.log()

        const convoyDir = resolve(process.cwd(), '.opencastle', 'convoys')
        await mkdir(convoyDir, { recursive: true })

        // Extract feature name early for convoy naming
        const chainPrdContent = await readFile(prdPath, 'utf8')
        const featureNameMatch = chainPrdContent.match(/^# (.+?)\s*(?:—|-)?\s*PRD/m)
        const featureName = featureNameMatch
          ? featureNameMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
          : 'feature'

        const groupSpecPaths: string[] = []

        for (let i = 0; i < complexity.convoy_groups.length; i++) {
          const group = complexity.convoy_groups[i]
          console.log(c.cyan(`  [${i + 1}/${complexity.convoy_groups.length}] Generating convoy: ${group.name}`) + c.dim(` (phases: ${group.phases.join(', ')})`))

          const chainGoal = [
            complexity.original_prompt,
            '',
            '## Convoy Group Scope',
            '',
            `This is group **${i + 1} of ${complexity.convoy_groups.length}** in a convoy chain.`,
            `Generate a convoy spec covering ONLY the phases listed below.`,
            '',
            `- **Group name:** ${group.name}`,
            `- **Description:** ${group.description}`,
            `- **Phases to include:** ${group.phases.join(', ')}`,
            group.depends_on.length ? `- **Depends on groups:** ${group.depends_on.join(', ')}` : '',
          ].filter(Boolean).join('\n')

          const prdContent = await readFile(prdPath, 'utf8')
          const relevantPrd = extractRelevantPrdSections(prdContent, group.phases)
          const relevantComplexity = filterTaskComplexityByPhases(complexity?.task_complexity, group.phases)
          const contextForSpec = appendTaskComplexity(relevantPrd, relevantComplexity)
          const groupSpecPath = resolve(convoyDir, `${featureName}-${group.name}.convoy.yml`)

          const { specPath: resolvedGroupSpecPath } = await generateAndValidateSpec({
            sharedOpts,
            goalText: chainGoal,
            contextText: contextForSpec,
            specPath: groupSpecPath,
            skipValidation: opts.skipValidation,
            groupName: group.name,
            featureName,
            enrichment: complexity ? deriveSpecEnrichment(complexity) : undefined,
          })
          groupSpecPaths.push(resolvedGroupSpecPath)
        }

        // Build master pipeline spec (version 2)
        const branchMatch = chainPrdContent.match(/`feat\/([^`]+)`/)
        const branch = branchMatch ? `feat/${branchMatch[1]}` : `feat/${featureName}`

        const masterSpec = {
          name: featureNameMatch ? featureNameMatch[1].trim() : 'Feature Pipeline',
          version: 2,
          branch,
          on_failure: 'stop',
          depends_on_convoy: groupSpecPaths.map(p => relPath(p)),
        }

        const masterSpecPath = resolve(convoyDir, `${featureName}-pipeline.convoy.yml`)
        await writeFile(masterSpecPath, stringify(masterSpec), 'utf8')

        console.log(c.green(`  ✓ Generated convoy chain:\n`))
        for (const p of groupSpecPaths) {
          console.log(`    ${relPath(p)}`)
        }
        console.log(`    ${relPath(masterSpecPath)} ${c.dim('(master)')}`)
        console.log()
        console.log(
          `  ${c.dim('Preview:')} npx opencastle convoy run -f ${relPath(masterSpecPath)} --dry-run\n` +
            `  ${c.dim('Execute:')} npx opencastle convoy run -f ${relPath(masterSpecPath)}\n`
        )

        try {
          const shouldRun = await confirm('Run the convoy chain now?', true)
          if (shouldRun) {
            closePrompts()
            const runModule = await import('./run.js')
            const runArgs = ['-f', masterSpecPath]
            if (opts.adapter) runArgs.push('-a', opts.adapter)
            if (opts.verbose) runArgs.push('--verbose')
            await runModule.default({ args: runArgs, pkgRoot })
          }
        } finally {
          closePrompts()
          await cleanupAdapters()
        }
        return
      }
    } else {
      console.log(
        c.cyan(`  ℹ`) + ` Complexity: ${complexity.complexity} | Strategy: single\n`
      )
    }
  }

  // ── Generate convoy spec ──────────────────────────────────────────────────
  const singlePrdContent = await readFile(prdPath, 'utf8')
  const singleContextForSpec = appendTaskComplexity(singlePrdContent, complexity?.task_complexity)
  const singleGoal = complexity?.original_prompt ?? opts.text ?? ''

  const specResult = await generateAndValidateSpec({
    sharedOpts,
    goalText: singleGoal,
    contextText: singleContextForSpec,
    specPath: opts.outputSpec ? resolve(process.cwd(), opts.outputSpec) : undefined,
    skipValidation: opts.skipValidation,
    enrichment: complexity ? deriveSpecEnrichment(complexity) : undefined,
  })

  await printFinalSummary(prdPath, specResult.specPath, opts, pkgRoot)
}

async function fixViaPatch(
  taskPlan: TaskPlan,
  errors: string,
  sharedOpts: Omit<PromptStepOptions, 'template' | 'goalText' | 'contextText'>,
  specPath: string,
  enrichment?: SpecEnrichment,
): Promise<TaskPlan> {
  let currentPlan = taskPlan
  let currentErrors = errors

  for (let attempt = 1; attempt <= MAX_FIX_RETRIES; attempt++) {
    console.log(c.dim(`  Fix attempt ${attempt}/${MAX_FIX_RETRIES}…`))

    let fixResult
    try {
      fixResult = await runPromptStep({
        ...sharedOpts,
        template: 'fix-convoy',
        goalText: JSON.stringify(currentPlan, null, 2),
        contextText: currentErrors,
      })
    } catch (err) {
      console.error(`\n  ✗ Fix attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    const patches = parsePatches(fixResult.rawOutput)
    if (!patches || patches.length === 0) {
      console.warn(c.yellow(`  ⚠ No valid patches returned`))
      if (attempt >= MAX_FIX_RETRIES) break
      continue
    }

    console.log(c.dim(`  Applied ${patches.length} patches`))
    currentPlan = applyPatches(currentPlan, patches)

    // Rebuild YAML and re-validate
    const yaml = buildConvoyYaml(currentPlan, enrichment)
    try {
      const parsed = parseYaml(yaml)
      const { valid, errors: schemaErrors } = validateSpec(parsed)
      if (!valid) {
        currentErrors = schemaErrors.map(e => `- Schema: ${e}`).join('\n')
        if (attempt < MAX_FIX_RETRIES) {
          console.log(c.yellow(`  ⚠ Still has schema issues — retrying…\n`))
          console.log(c.dim(currentErrors))
        }
        continue
      }
    } catch (err) {
      currentErrors = `YAML error: ${err instanceof Error ? err.message : String(err)}`
      continue
    }

    await writeFile(specPath, yaml, 'utf8')
    console.log(c.dim(`  Re-validating after fix…`))

    let revalidation
    try {
      revalidation = await runPromptStep({
        ...sharedOpts,
        template: 'validate-convoy',
        goalText: `<!-- validation-pass: ${attempt + 1} -->\n${yaml}`,
      })
    } catch (err) {
      console.error(`\n  ✗ Re-validation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    if (revalidation.isValid) {
      console.log(c.green(`  ✓ Fixed and validated\n`))
      return currentPlan
    }

    currentErrors = revalidation.errors ?? revalidation.rawOutput
    if (attempt < MAX_FIX_RETRIES) {
      console.log(c.yellow(`  ⚠ Still has issues — retrying…\n`))
      console.log(c.dim(currentErrors))
    }
  }

  // Exhausted retries — save best effort and continue with warning
  await writeFile(specPath, buildConvoyYaml(currentPlan, enrichment), 'utf8')
  console.log(c.yellow(`\n  ⚠ Could not fully auto-fix after ${MAX_FIX_RETRIES} attempts — continuing with best-effort spec.\n`))
  console.log(c.dim(`  Remaining issues:\n`))
  console.log(c.dim(currentErrors))
  console.log(
    c.dim(`\n  Spec saved to ${relPath(specPath)} with best available fixes.`) +
    c.dim(`\n  You can re-validate later with:\n`) +
    `    opencastle convoy run --file ${relPath(specPath)} --dry-run\n`
  )
  return currentPlan
}

async function generateAndValidateSpec(params: {
  sharedOpts: Omit<PromptStepOptions, 'template' | 'goalText' | 'contextText'>
  goalText: string
  contextText: string
  specPath?: string
  skipValidation: boolean
  groupName?: string
  featureName?: string
  enrichment?: SpecEnrichment
}): Promise<{ specPath: string; taskPlan: TaskPlan }> {
  const label = params.groupName
    ? `Generating task plan: ${params.groupName}…`
    : 'Generating task plan…'
  console.log(c.cyan(`  ${label}`))

  // Temp file for debugging — kept on failure, deleted on success
  const convoyDir = resolve(process.cwd(), '.opencastle', 'convoys')
  await mkdir(convoyDir, { recursive: true })
  const tempJsonName = params.groupName
    ? `${params.featureName ? `${params.featureName}-` : ''}${params.groupName}.task-plan.json`
    : `${params.featureName ?? 'task-plan'}.task-plan.json`
  const tempJsonPath = resolve(convoyDir, tempJsonName)

  let taskPlanResult
  try {
    taskPlanResult = await runPromptStep({
      ...params.sharedOpts,
      template: 'generate-convoy',
      goalText: params.goalText,
      contextText: params.contextText,
    })
  } catch (err) {
    console.error(`\n  ✗ Task plan generation failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // Write raw JSON to temp file for debugging
  await writeFile(tempJsonPath, taskPlanResult.rawOutput + '\n', 'utf8')

  let result = parseTaskPlanWithReason(taskPlanResult.rawOutput)
  if (!result.plan) {
    console.log(c.yellow(`  ⚠ Failed to parse task plan JSON: ${result.reason}`))
    console.log(c.dim(`    Output length: ${taskPlanResult.rawOutput.length} chars`))
    console.log(c.dim(`    Temp file: ${relPath(tempJsonPath)}`))
    console.log(c.yellow(`    Retrying generation…\n`))

    let retryResult
    try {
      retryResult = await runPromptStep({
        ...params.sharedOpts,
        template: 'generate-convoy',
        goalText: params.goalText,
        contextText: params.contextText,
      })
    } catch (err) {
      console.error(`\n  ✗ Retry failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    // Overwrite temp file with retry output
    await writeFile(tempJsonPath, retryResult.rawOutput + '\n', 'utf8')

    result = parseTaskPlanWithReason(retryResult.rawOutput)
    if (!result.plan) {
      console.error(`  ✗ Failed to parse task plan JSON after retry: ${result.reason}`)
      console.error(c.dim(`    Output length: ${retryResult.rawOutput.length} chars`))
      console.error(c.dim(`    Raw JSON saved to ${relPath(tempJsonPath)} for inspection.`))
      console.error(c.dim(`\n${retryResult.rawOutput}`))
      process.exit(1)
    }
  }

  let taskPlan = result.plan

  // Success — clean up temp file
  await unlink(tempJsonPath).catch(() => {})

  console.log(c.green(`  ✓ Task plan generated (${taskPlan.tasks.length} tasks)`))

  // Derive spec path from plan name if not provided
  let resolvedSpecPath = params.specPath
  if (!resolvedSpecPath) {
    const convoyDir = resolve(process.cwd(), '.opencastle', 'convoys')
    await mkdir(convoyDir, { recursive: true })
    const kebab = taskPlan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    resolvedSpecPath = resolve(convoyDir, `${kebab}.convoy.yml`)
  }

  // Build YAML from JSON task plan
  let yamlContent = buildConvoyYaml(taskPlan, params.enrichment)
  await mkdir(resolve(resolvedSpecPath, '..'), { recursive: true })
  await writeFile(resolvedSpecPath, yamlContent, 'utf8')
  console.log(c.green(`  ✓ Convoy spec written to ${relPath(resolvedSpecPath)}\n`))

  if (!params.skipValidation) {
    // Programmatic validation first
    try {
      const parsed = parseYaml(yamlContent)
      const { valid, errors: schemaErrors } = validateSpec(parsed)
      if (!valid) {
        console.log(c.yellow(`  ⚠ Schema validation issues — auto-fixing…\n`))
        const errorText = schemaErrors.map(e => `- Schema: ${e}`).join('\n')
        console.log(c.dim(errorText))
        console.log()
        taskPlan = await fixViaPatch(taskPlan, errorText, params.sharedOpts, resolvedSpecPath, params.enrichment)
        yamlContent = buildConvoyYaml(taskPlan, params.enrichment)
        await writeFile(resolvedSpecPath, yamlContent, 'utf8')
      } else {
        console.log(c.dim(`  ✓ Schema validation passed`))
      }
    } catch (err) {
      console.warn(c.yellow(`  ⚠ YAML warning: ${err instanceof Error ? err.message : String(err)}`))
    }

    // Semantic validation (LLM)
    const valLabel = params.groupName
      ? `Validating spec: ${params.groupName}…`
      : 'Validating convoy spec…'
    console.log(c.cyan(`  ${valLabel}`))

    let semanticResult
    try {
      semanticResult = await runPromptStep({
        ...params.sharedOpts,
        template: 'validate-convoy',
        goalText: `<!-- validation-pass: 1 -->\n${await readFile(resolvedSpecPath, 'utf8')}`,
      })
    } catch (err) {
      console.error(`\n  ✗ Semantic validation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    if (semanticResult.isValid) {
      console.log(c.green(`  ✓ Spec is valid\n`))
    } else {
      const semanticErrors = semanticResult.errors ?? semanticResult.rawOutput
      console.log(c.yellow(`  ⚠ Semantic issues — auto-fixing…\n`))
      console.log(c.dim(semanticErrors))
      console.log()
      taskPlan = await fixViaPatch(taskPlan, semanticErrors, params.sharedOpts, resolvedSpecPath, params.enrichment)
      yamlContent = buildConvoyYaml(taskPlan, params.enrichment)
      await writeFile(resolvedSpecPath, yamlContent, 'utf8')
    }
  }

  return { specPath: resolvedSpecPath, taskPlan }
}

async function printFinalSummary(
  prdPath: string,
  specPath: string,
  opts: PipelineOptions,
  pkgRoot: string,
): Promise<void> {
  const prd = relPath(prdPath)
  const spec = relPath(specPath)
  console.log(c.bold(c.green('  Pipeline complete!\n')))
  console.log(`  PRD:           ${prd}`)
  console.log(`  Convoy spec:   ${spec}\n`)
  console.log(
    `  ${c.dim('Preview:')} npx opencastle convoy run -f ${spec} --dry-run\n` +
      `  ${c.dim('Execute:')} npx opencastle convoy run -f ${spec}\n`
  )

  try {
    const shouldRun = await confirm('Run the convoy now?', true)
    if (shouldRun) {
      closePrompts()
      const runModule = await import('./run.js')
      const runArgs = ['-f', specPath]
      if (opts.adapter) runArgs.push('-a', opts.adapter)
      if (opts.verbose) runArgs.push('--verbose')
      await runModule.default({ args: runArgs, pkgRoot })
    }
  } finally {
    closePrompts()
    await cleanupAdapters()
  }
}
