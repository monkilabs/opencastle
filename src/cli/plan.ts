import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { c } from './prompt.js'
import type { AgentAdapter, Task } from './convoy/spec-types.js'

/**
 * One planning step: fill a prompt template, run it through the adapter the
 * caller resolved, and read the answer the way the template's `output:`
 * frontmatter says.
 *
 * This file used to be a command of its own (`--template`, `--context`, …). No
 * route reached it once `convoy plan` went to the pipeline, so only the step
 * runner is left.
 */

export type PromptOutput = 'prd' | 'validation' | 'json'

export interface PromptStepOptions {
  /** Template name, without `.prompt.md`. */
  template: string
  /** Fills the template's `{{goal}}` line. */
  goalText?: string
  /** Fills the template's `{{context}}` line. */
  contextText?: string
  /** Where a PRD answer is written. Defaults to a new file in `.opencastle/prds/`. */
  outputPath?: string
  /**
   * The runtime, resolved once by the caller. Each step used to detect it
   * afresh, so one plan could in principle be written by two different CLIs.
   */
  adapter: AgentAdapter
  /** Where opencastle is installed; the templates live under it. */
  pkgRoot: string
  /** The project the planner reads. Defaults to the current directory. */
  cwd?: string
  verbose?: boolean
  /** How long one session may run before it is stopped. Defaults to 10 minutes. */
  timeoutMs?: number
}

export interface PromptStepResult {
  /** Where a PRD was written; null for the other outputs. */
  outputPath: string | null
  /** The answer: for `json`, the JSON text alone when it came fenced. */
  rawOutput: string
  outputType: PromptOutput
  /** Set for `validation`. */
  isValid?: boolean
  /** Set for `validation` when the verdict is invalid. */
  errors?: string
}

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000

// ── Templates ───────────────────────────────────────────────────────────────

/** Strip YAML frontmatter (everything between first and second --- delimiters). */
function stripFrontmatter(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (closingIdx === -1) return text
  return lines.slice(closingIdx + 1).join('\n').trimStart()
}

/** Extract key: value pairs from YAML frontmatter (top-level scalar values only). */
export function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return result
  const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (closingIdx === -1) return result
  for (let i = 1; i < closingIdx; i++) {
    const match = lines[i].match(/^(\w[\w-]*):\s*['"]?([^'"]+?)['"]?\s*$/)
    if (match) result[match[1]] = match[2].trim()
  }
  return result
}

export function templatePath(pkgRoot: string, name: string): string {
  return join(pkgRoot, 'src', 'orchestrator', 'prompts', `${name}.prompt.md`)
}

/**
 * Put the inputs into a template.
 *
 * A placeholder is filled only where it stands on a line of its own. The
 * instructions in generate-convoy mentioned `{{goal}}` and `{{context}}` in
 * passing, and a global replace pasted the whole PRD into those sentences as
 * well, so every plan carried its PRD twice.
 *
 * One pass with a function replacement: the text put in is never scanned again
 * (a PRD that mentions `{{context}}` stays as written), and `$&` or `$'` in it
 * are not read as replacement patterns.
 */
export function fillTemplate(body: string, goal: string, context: string): string {
  return body.replace(/^[ \t]*\{\{(goal|context)\}\}[ \t]*$/gm, (_line, key: string) =>
    (key === 'goal' ? goal : context).trim(),
  )
}

/** `'Team Lead (OpenCastle)'` → `team-lead`, the agent slug the adapter introduces. */
function agentSlug(label: string | undefined): string {
  return (label ?? 'team-lead')
    .replace(/\(.*?\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}

// ── Answers ─────────────────────────────────────────────────────────────────

/**
 * Extract Markdown body from AI output.
 * Strips wrapping ```markdown / ```md fences if present.
 * If a heading is present but prefixed with preamble, trims to the first heading.
 */
function extractMarkdownBody(output: string): string {
  const mdFenceMatch = output.match(/^```(?:markdown|md)\s*\n([\s\S]*?)```\s*$/m)
  if (mdFenceMatch) return mdFenceMatch[1].trim()

  const lines = output.trim().split('\n')
  if (lines[0]?.startsWith('```') && lines[lines.length - 1]?.trim() === '```') {
    return lines.slice(1, -1).join('\n').trim()
  }

  const headingIdx = lines.findIndex((l) => /^#{1,3}\s/.test(l))
  if (headingIdx > 0) return lines.slice(headingIdx).join('\n').trim()

  return output.trim()
}

/**
 * The JSON in an answer: the last ```json fence if there is one, else the whole
 * answer. A missing fence used to abort the plan outright, before the one
 * retry generate-convoy is allowed; now the parser downstream sees the text and
 * reports why it is not a plan.
 */
export function extractJson(output: string): string {
  // Greedy, so a prompt inside the plan that shows a fenced example does not
  // cut the block short.
  const fenced = output.match(/```json\s*\n([\s\S]*)```/)
  return (fenced ? fenced[1] : output).trim()
}

/**
 * Parse a validation AI response for VALID / INVALID verdict.
 * Prefers structured JSON output; falls back to VALID/INVALID keyword matching.
 */
export function parseValidationResult(output: string): { isValid: boolean; errors: string } {
  const trimmed = output.trim()

  const jsonFenceMatch = trimmed.match(/```json\s*\n([\s\S]*?)```/)
  const candidate = jsonFenceMatch ? jsonFenceMatch[1].trim() : trimmed.startsWith('{') ? trimmed : null
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as { valid?: boolean; issues?: string[] }
      if (typeof parsed.valid === 'boolean') {
        if (parsed.valid) return { isValid: true, errors: '' }
        const errors = Array.isArray(parsed.issues) ? parsed.issues.join('\n') : ''
        return { isValid: false, errors }
      }
    } catch {
      // Not JSON after all — fall through to the keyword check.
    }
  }

  const hasInvalid = /\bINVALID\b/.test(trimmed)
  const hasValid = /\bVALID\b/.test(trimmed)
  if (hasValid && !hasInvalid) return { isValid: true, errors: '' }
  const errorsMatch = trimmed.match(/(?:Issues|Errors):\s*\n([\s\S]+)/i)
  return { isValid: false, errors: errorsMatch ? errorsMatch[1].trim() : trimmed }
}

/**
 * A path in `dir` that nothing is using yet: `<stem><suffix>`, then
 * `<stem>-2<suffix>` and so on.
 *
 * PRDs and specs were named after their title and overwritten. Two requests
 * that happened to share a title replaced each other's files, hand edits
 * included, and the complexity cache that sat next to the PRD answered for the
 * wrong one.
 */
export function freePath(dir: string, stem: string, suffix: string): string {
  let candidate = join(dir, `${stem}${suffix}`)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem}-${n}${suffix}`)
  return candidate
}

function prdStem(content: string): string {
  const heading = content.match(/^#\s+(.+?)(?:\s*[-—–]+\s*PRD)?\s*$/m)
  const kebab = heading?.[1]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return kebab || `prd-${Date.now()}`
}

// ── Progress ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const TEMPLATE_MESSAGES: Record<string, string> = {
  'generate-prd': 'Writing the PRD',
  'validate-prd': 'Checking the PRD',
  'fix-prd': 'Fixing the PRD',
  'assess-complexity': 'Sizing the work',
  'generate-convoy': 'Breaking it into tasks',
  'validate-convoy': 'Reviewing the plan',
  'fix-convoy': 'Fixing the plan',
}

/**
 * One spinner line for however many steps are running.
 *
 * Steps run side by side now (validation beside sizing, one task plan per
 * group), and a spinner each meant several timers overwriting the same line.
 * Off a terminal there is no line to redraw, and the frames only cluttered a
 * log, so nothing is drawn there.
 */
const running = new Map<number, string>()
let nextId = 0
let ticker: ReturnType<typeof setInterval> | null = null
let startedAt = 0

function startProgress(templateName: string): () => void {
  if (!process.stdout.isTTY) return () => {}
  const id = nextId++
  running.set(id, TEMPLATE_MESSAGES[templateName] ?? templateName)
  if (!ticker) {
    startedAt = Date.now()
    let frame = 0
    ticker = setInterval(() => {
      const labels = [...new Set(running.values())]
      const elapsed = Math.floor((Date.now() - startedAt) / 1000)
      const spinner = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]
      const line = `  ${spinner} ${labels.join(' · ')}… (${elapsed}s)`
      process.stdout.write('\r' + c.dim(line.slice(0, (process.stdout.columns ?? 80) - 1)) + '\x1b[K')
    }, 250)
  }
  return () => {
    running.delete(id)
    if (running.size === 0 && ticker) {
      clearInterval(ticker)
      ticker = null
      process.stdout.write('\r\x1b[K')
    }
  }
}

// ── The step ────────────────────────────────────────────────────────────────

/**
 * Run one planning template through the caller's adapter.
 *
 * Planning sessions run with `permissionMode: 'plan'`: they read the repository
 * to ground the plan in real paths, and they cannot change it. They used to get
 * the workers' `acceptEdits`, so a planner could edit the project it was only
 * meant to describe.
 */
export async function runPromptStep(opts: PromptStepOptions): Promise<PromptStepResult> {
  const path = templatePath(opts.pkgRoot, opts.template)
  if (!existsSync(path)) throw new Error(`Prompt template not found: ${path}`)

  const rawTemplate = await readFile(path, 'utf8')
  const frontmatter = parseFrontmatter(rawTemplate)
  const outputType = (frontmatter['output'] ?? 'json') as PromptOutput
  const prompt = fillTemplate(stripFrontmatter(rawTemplate), opts.goalText ?? '', opts.contextText ?? '')

  const task: Task = {
    id: opts.template,
    prompt,
    agent: agentSlug(frontmatter['agent']),
    timeout: '10m',
    depends_on: [],
    files: [],
    description: frontmatter['description'] ?? opts.template,
    max_retries: 1,
  }

  if (opts.verbose) {
    console.log(c.dim(`    ${opts.template} · ${opts.adapter.name} · read-only · ${prompt.length} chars`))
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const stop = opts.verbose ? null : startProgress(opts.template)
  let timer: ReturnType<typeof setTimeout> | undefined
  let execResult
  try {
    execResult = await Promise.race([
      opts.adapter.execute(task, {
        verbose: opts.verbose ?? false,
        cwd: opts.cwd ?? process.cwd(),
        permissionMode: 'plan',
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // A hung session would otherwise hold the whole plan open forever.
          opts.adapter.kill?.(task)
          reject(new Error(`${opts.template} ran longer than ${Math.round(timeoutMs / 60_000)}m and was stopped`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    stop?.()
  }

  if (!execResult.success) {
    throw new Error(
      `${opts.adapter.name} failed on ${opts.template} (exit code ${execResult.exitCode}).\n` +
        execResult.output.slice(0, 2000),
    )
  }

  const rawOutput = execResult.output

  if (outputType === 'validation') {
    const { isValid, errors } = parseValidationResult(rawOutput)
    return { outputPath: null, rawOutput, outputType, isValid, errors }
  }

  if (outputType === 'prd') {
    const content = extractMarkdownBody(rawOutput)
    let outputPath = opts.outputPath ?? null
    if (!outputPath) {
      const prdDir = resolve(opts.cwd ?? process.cwd(), '.opencastle', 'prds')
      await mkdir(prdDir, { recursive: true })
      outputPath = freePath(prdDir, prdStem(content), '.prd.md')
    }
    await mkdir(resolve(outputPath, '..'), { recursive: true })
    await writeFile(outputPath, content + '\n', 'utf8')
    return { outputPath, rawOutput, outputType }
  }

  return { outputPath: null, rawOutput: extractJson(rawOutput), outputType: 'json' }
}
