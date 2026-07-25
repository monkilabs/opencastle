import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { getAdapter, detectAdapter, cleanupAdapters } from './run/adapters/index.js'
import { parseTaskSpecText } from './run/schema.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'
import type { Task } from './convoy/spec-types.js'
import type { MCPServerConfig } from './convoy/types.js'

const HELP = `
  opencastle convoy plan [options]

  Generate a convoy spec (or other AI output) from a task description by running
  it through a prompt template via an AI adapter.

  Options:
    --file, -f <path>        Path to a text file (fills {{goal}} in the template)
    --text, -t <text>        Inline text to use as {{goal}} (alternative to --file)
    --template <name>        Prompt template name (default: generate-convoy)
                             Built-in templates:
                               generate-prd        — Write a PRD from a feature prompt
                               validate-prd        — Check a PRD for completeness
                               fix-prd             — Fix validation errors in a PRD
                               assess-complexity   — Assess PRD complexity (returns JSON)
                               generate-convoy     — Generate a convoy spec from a PRD (default)
                               validate-convoy     — Check a convoy spec for correctness
                               fix-convoy          — Fix validation errors in a convoy spec
    --context <path>         Optional path to an additional context file (fills {{context}})
    --context-text <text>    Inline text to fill {{context}} (alternative to --context)
    --output, -o <path>      Output path override (skipped for validation output)
    --adapter, -a <name>     Override agent runtime adapter
    --verbose                Show full agent output
    --dry-run                Print the assembled prompt without executing
    --help, -h               Show this help
`

interface PlanOptions {
  file: string | null
  text: string | null
  template: string
  context: string | null
  contextText: string | null
  output: string | null
  adapter: string | null
  verbose: boolean
  dryRun: boolean
  help: boolean
}

// ── Exported types ──────────────────────────────────────────────────────────

export interface PromptStepOptions {
  /** Template name without extension. Default: 'generate-convoy' */
  template?: string
  /** Absolute file path whose content fills {{goal}} */
  filePath?: string
  /** Inline text that fills {{goal}} — alternative to filePath */
  goalText?: string
  /** File path whose content fills {{context}} */
  contextPath?: string
  /** Inline text that fills {{context}} — alternative to contextPath */
  contextText?: string
  /** Explicit output path override */
  outputPath?: string
  /** Adapter name override */
  adapterName?: string
  verbose?: boolean
  dryRun?: boolean
  /** Absolute path to the opencastle package root (for locating prompt templates) */
  pkgRoot: string
  /** MCP servers to make available to the AI adapter during execution. */
  mcpServers?: MCPServerConfig[]
}

export interface PromptStepResult {
  /** Absolute path the output was written to. null for validation output or dry-run */
  outputPath: string | null
  /** Raw text returned by the AI adapter (or assembled prompt on dry-run) */
  rawOutput: string
  /** How the output was interpreted */
  outputType: 'convoy-spec' | 'prd' | 'validation' | 'json'
  /** Set when outputType === 'validation' */
  isValid?: boolean
  /** Set when outputType === 'validation' and isValid === false */
  errors?: string
}

// ── Private helpers ─────────────────────────────────────────────────────────

function printAdapterError(detectionFailed: boolean, adapterName: string): void {
  if (detectionFailed) {
    console.error(
      `  ✗ No agent CLI found on your PATH.\n` +
        `    Install one of the following adapters:\n` +
        `    • copilot    — https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli\n` +
        `    • claude     — npm install -g @anthropic-ai/claude-code\n` +
        `    • cursor     — https://cursor.com (Cursor > Install CLI)\n` +
        `    • opencode   — https://opencode.ai\n` +
        `    • codex      — npm install -g @openai/codex\n` +
        `\n` +
        `    Or specify an adapter explicitly: opencastle convoy plan --adapter <name>`
    )
  } else {
    const hints: Record<string, string> = {
      claude:
        '    Install: npm install -g @anthropic-ai/claude-code\n' +
        '    Docs:    https://docs.anthropic.com/en/docs/claude-code',
      copilot:
        '    Requires the Copilot CLI installed and authenticated:\n' +
        '    https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli\n' +
        '    Docs:    https://docs.github.com/en/copilot',
      cursor:
        '    The Cursor agent CLI ships with the Cursor editor.\n' +
        '    Install Cursor from https://cursor.com and ensure the\n' +
        '    "agent" command is on your PATH (Cursor > Install CLI).',
      opencode:
        '    Install OpenCode from https://opencode.ai\n' +
        '    Ensure the "opencode" command is on your PATH.',
      codex:
        '    Install: npm install -g @openai/codex\n' +
        '    Docs:    https://developers.openai.com/codex',
    }
    const cliName = adapterName === 'cursor' ? 'agent' : adapterName
    const hint = hints[adapterName] ?? ''
    console.error(
      `  ✗ Adapter "${adapterName}" is not available.\n` +
        `    Make sure the "${cliName}" CLI is installed and on your PATH.\n` +
        hint
    )
  }
}

/** Strip YAML frontmatter (everything between first and second --- delimiters). */
function stripFrontmatter(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (closingIdx === -1) return text
  return lines.slice(closingIdx + 1).join('\n').trimStart()
}

/** Extract key: value pairs from YAML frontmatter (top-level scalar values only). */
function parseFrontmatter(text: string): Record<string, string> {
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

/** Extract YAML content from a fenced ```yaml ... ``` block. */
function extractYamlBlock(text: string): string | null {
  // 1. Prefer explicit yaml/yml fence — greedy to skip backticks inside content
  const yamlFence = text.match(/```ya?ml\s*\n([\s\S]*)```/)
  if (yamlFence) return yamlFence[1].trim()

  // 2. Fallback: any code fence whose content looks like a convoy spec
  //    Must contain at least `name:` AND `tasks:` to avoid false positives
  const genericFences = [...text.matchAll(/```\s*\n([\s\S]*?)```/g)]
  for (const m of genericFences) {
    const content = m[1].trim()
    if (/^name:/m.test(content) && /^tasks:/m.test(content)) return content
  }

  return null
}

/**
 * Derive a .convoy.yml filename from YAML content.
 * Checks for a first-line comment, then falls back to the `name:` field.
 */
function deriveOutputFilename(yaml: string): string {
  const firstLine = yaml.split('\n')[0] ?? ''
  const commentMatch = firstLine.match(/^#\s*(.+\.convoy\.ya?ml)\s*$/)
  if (commentMatch) return basename(commentMatch[1])
  const nameMatch = yaml.match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m)
  if (nameMatch) {
    const kebab = nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (kebab) return `${kebab}.convoy.yml`
  }
  return 'convoy-plan.convoy.yml'
}

/**
 * Derive a .prd.md filename from PRD Markdown content.
 * Looks for a # Heading to extract a kebab-case name.
 */
function derivePrdFilename(content: string): string {
  const headingMatch = content.match(/^#\s+(.+?)(?:\s*[-—–]+\s*PRD)?\s*$/m)
  if (headingMatch) {
    const kebab = headingMatch[1]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    if (kebab) return `${kebab}.prd.md`
  }
  return `prd-${Date.now()}.prd.md`
}

/**
 * Extract Markdown body from AI output.
 * Strips wrapping ```markdown / ```md fences if present.
 * If a heading is present but prefixed with preamble, trims to the first heading.
 */
function extractMarkdownBody(output: string): string {
  // Strip explicit markdown fence
  const mdFenceMatch = output.match(/^```(?:markdown|md)\s*\n([\s\S]*?)```\s*$/m)
  if (mdFenceMatch) return mdFenceMatch[1].trim()

  const lines = output.trim().split('\n')
  // Strip plain ``` wrapping (first and last line are fences)
  if (lines[0]?.startsWith('```') && lines[lines.length - 1]?.trim() === '```') {
    return lines.slice(1, -1).join('\n').trim()
  }

  // If there's preamble before the first heading, strip it
  const headingIdx = lines.findIndex((l) => /^#{1,3}\s/.test(l))
  if (headingIdx > 0) return lines.slice(headingIdx).join('\n').trim()

  return output.trim()
}

/**
 * Parse a validation AI response for VALID / INVALID verdict.
 * Prefers structured JSON output; falls back to VALID/INVALID keyword matching.
 */
function parseValidationResult(output: string): { isValid: boolean; errors: string } {
  const trimmed = output.trim()

  // Try structured JSON first (preferred format)
  const jsonFenceMatch = trimmed.match(/```json\s*\n([\s\S]*?)```/)
  if (jsonFenceMatch) {
    try {
      const parsed = JSON.parse(jsonFenceMatch[1].trim()) as { valid?: boolean; issues?: string[] }
      if (typeof parsed.valid === 'boolean') {
        if (parsed.valid) return { isValid: true, errors: '' }
        const errors = Array.isArray(parsed.issues) ? parsed.issues.join('\n') : ''
        return { isValid: false, errors }
      }
    } catch {
      // JSON parse failed — fall through to regex fallback
    }
  }

  // Fallback: regex-based parsing for backward compatibility
  const hasInvalid = /\bINVALID\b/.test(trimmed)
  const hasValid = /\bVALID\b/.test(trimmed)
  if (hasValid && !hasInvalid) return { isValid: true, errors: '' }
  const errorsMatch = trimmed.match(/(?:Issues|Errors):\s*\n([\s\S]+)/i)
  return { isValid: false, errors: errorsMatch ? errorsMatch[1].trim() : trimmed }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const TEMPLATE_MESSAGES: Record<string, string> = {
  'generate-prd': 'Generating PRD…',
  'generate-convoy': 'Generating convoy spec…',
  'validate-prd': 'Validating PRD…',
  'validate-convoy': 'Validating convoy spec…',
  'fix-prd': 'Fixing PRD…',
  'fix-convoy': 'Fixing convoy spec…',
}

/** Show an in-place spinner with elapsed time during a long-running adapter call. Returns a stop function. */
function startProgress(templateName: string): () => void {
  const message = TEMPLATE_MESSAGES[templateName] ?? `Running ${templateName}…`
  const startTime = Date.now()
  let frame = 0
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000)
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!
    process.stdout.write(c.dim(`\r  ${spinner} ${message} (${elapsed}s)`))
    frame++
  }, 250)
  return () => {
    clearInterval(interval)
    process.stdout.write('\r' + ' '.repeat(60) + '\r')
  }
}

// ── Exported programmatic API ───────────────────────────────────────────────

/**
 * Execute a single prompt template step via an AI adapter.
 * Used by the start command to chain steps programmatically.
 */
export async function runPromptStep(opts: PromptStepOptions): Promise<PromptStepResult> {
  const templateName = opts.template ?? 'generate-convoy'

  const templatePath = join(
    opts.pkgRoot,
    'src',
    'orchestrator',
    'prompts',
    `${templateName}.prompt.md`
  )
  if (!existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`)
  }

  const rawTemplate = await readFile(templatePath, 'utf8')
  const frontmatter = parseFrontmatter(rawTemplate)
  const outputType = (frontmatter['output'] ?? 'convoy-spec') as 'convoy-spec' | 'prd' | 'validation' | 'json'
  const template = stripFrontmatter(rawTemplate)

  let goalContent = opts.goalText ?? ''
  if (!goalContent && opts.filePath) {
    if (!existsSync(opts.filePath)) throw new Error(`File not found: ${opts.filePath}`)
    goalContent = await readFile(opts.filePath, 'utf8')
  }

  let contextContent = opts.contextText ?? ''
  if (!contextContent && opts.contextPath) {
    if (!existsSync(opts.contextPath)) throw new Error(`Context file not found: ${opts.contextPath}`)
    contextContent = await readFile(opts.contextPath, 'utf8')
  }

  const assembledPrompt = template
    .replace(/\{\{goal\}\}/g, goalContent.trim())
    .replace(/\{\{context\}\}/g, contextContent.trim())

  if (opts.dryRun) {
    console.log(c.bold(c.cyan(`  [${templateName}] Assembled prompt (dry-run):\n`)))
    console.log(assembledPrompt)
    return { outputPath: null, rawOutput: assembledPrompt, outputType }
  }

  let adapterName = opts.adapterName ?? ''
  if (!adapterName) {
    const detected = await detectAdapter()
    if (!detected) {
      printAdapterError(true, '')
      throw new Error('No adapter available')
    }
    adapterName = detected
  }

  let adapter
  try {
    adapter = await getAdapter(adapterName)
  } catch {
    printAdapterError(false, adapterName)
    throw new Error(`Adapter "${adapterName}" failed to load`)
  }

  if (!(await adapter.isAvailable())) {
    printAdapterError(false, adapterName)
    throw new Error(`Adapter "${adapterName}" is not available`)
  }

  const agentField = (frontmatter['agent'] ?? 'team-lead').toLowerCase().replace(/\s+/g, '-')
  const task: Task = {
    id: templateName,
    prompt: assembledPrompt,
    agent: agentField,
    timeout: '10m',
    depends_on: [],
    files: [],
    description: frontmatter['description'] ?? templateName,
    max_retries: 1,
  }

  if (opts.verbose) {
    console.log(c.dim(`    Adapter: ${adapterName} | Template: ${templateName} | Agent: ${agentField}`))
  }

  const stop = opts.verbose ? null : startProgress(templateName)
  let execResult
  try {
    execResult = await adapter.execute(task, {
      verbose: opts.verbose ?? false,
      ...(opts.mcpServers?.length ? { mcpServers: opts.mcpServers } : {}),
    })
  } finally {
    stop?.()
  }

  if (!execResult.success) {
    throw new Error(
      `Adapter "${adapterName}" returned failure (exit code ${execResult.exitCode}) for template "${templateName}".\n` +
      `Output (${execResult.output.length} chars):\n${execResult.output.slice(0, 2000)}`
    )
  }

  const rawOutput = execResult.output

  if (opts.verbose) {
    console.log(c.dim(`    Output: ${rawOutput.length} chars | Exit code: ${execResult.exitCode}`))
  }

  if (outputType === 'validation') {
    const { isValid, errors } = parseValidationResult(rawOutput)
    return { outputPath: null, rawOutput, outputType, isValid, errors }
  }

  if (outputType === 'json') {
    // Extract JSON from a ```json fenced block — fail fast if missing
    // Use greedy match (.*) to capture up to the LAST closing fence,
    // since task prompts may contain triple backticks in code examples
    const jsonFenceMatch = rawOutput.match(/```json\s*\n([\s\S]*)```/)
    if (!jsonFenceMatch) {
      throw new Error(
        `Expected a fenced \`\`\`json block in the AI response but found none.\n\n` +
        `Adapter: ${adapterName} | Output length: ${rawOutput.length} chars\n\n` +
        `Raw output:\n${rawOutput}\n\n` +
        `Tip: re-run with --verbose to see the full adapter output.`
      )
    }
    const jsonContent = jsonFenceMatch[1].trim()

    const outputPath = opts.outputPath ?? null
    if (outputPath) {
      await mkdir(resolve(outputPath, '..'), { recursive: true })
      await writeFile(outputPath, jsonContent + '\n', 'utf8')
    }
    return { outputPath, rawOutput: jsonContent, outputType }
  }

  if (outputType === 'prd') {
    const content = extractMarkdownBody(rawOutput)
    let outputPath = opts.outputPath ?? null
    if (!outputPath) {
      const prdDir = resolve(process.cwd(), '.opencastle', 'prds')
      await mkdir(prdDir, { recursive: true })
      outputPath = join(prdDir, derivePrdFilename(content))
    }
    await mkdir(resolve(outputPath, '..'), { recursive: true })
    await writeFile(outputPath, content + '\n', 'utf8')
    return { outputPath, rawOutput, outputType }
  }

  // convoy-spec (default)
  const yamlContent = extractYamlBlock(rawOutput)
  if (!yamlContent) {
    const preview = rawOutput.slice(0, 10_000)
    throw new Error(
      `No YAML code block found in the agent response.\n\nRaw output (truncated):\n${preview}`
    )
  }

  let schemaValid = true
  try {
    parseTaskSpecText(yamlContent)
  } catch (err) {
    schemaValid = false
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(c.yellow(`  ⚠ YAML validation warning: ${msg}`))
    console.warn(c.dim(`    The file will still be written — you may need to edit it before running.\n`))
  }

  let outputPath = opts.outputPath ?? null
  if (!outputPath) {
    const convoyDir = resolve(process.cwd(), '.opencastle', 'convoys')
    await mkdir(convoyDir, { recursive: true })
    outputPath = join(convoyDir, deriveOutputFilename(yamlContent))
  }
  await mkdir(resolve(outputPath, '..'), { recursive: true })
  await writeFile(outputPath, yamlContent + '\n', 'utf8')

  return { outputPath, rawOutput, outputType, isValid: schemaValid }
}

/**
 * Read MCP server configurations from the project's MCP config file.
 * Checks in priority order: .vscode/mcp.json, .cursor/mcp.json, .claude/mcp.json, mcp.json
 */
export async function readProjectMcpServers(projectRoot: string): Promise<MCPServerConfig[]> {
  const candidates = [
    join(projectRoot, '.vscode', 'mcp.json'),
    join(projectRoot, '.cursor', 'mcp.json'),
    join(projectRoot, '.claude', 'mcp.json'),
    join(projectRoot, 'mcp.json'),
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>

      // VS Code format: { servers: { name: { type, command, args } } }
      // Cursor/Claude format: { mcpServers: { name: { command, args } } }
      const serversMap =
        (parsed['servers'] as Record<string, unknown> | undefined) ??
        (parsed['mcpServers'] as Record<string, unknown> | undefined)

      if (!serversMap || typeof serversMap !== 'object') continue

      return Object.entries(serversMap).map(([name, cfg]) => {
        const c = cfg as Record<string, unknown>
        const server: MCPServerConfig = { name, type: (c['type'] as string) ?? 'stdio' }
        if (typeof c['command'] === 'string') server.command = c['command']
        if (Array.isArray(c['args'])) server.args = c['args'] as string[]
        if (typeof c['url'] === 'string') server.url = c['url']
        return server
      })
    } catch {
      return []
    }
  }

  return []
}

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(args: string[]): PlanOptions {
  const opts: PlanOptions = {
    file: null,
    text: null,
    template: 'generate-convoy',
    context: null,
    contextText: null,
    output: null,
    adapter: null,
    verbose: false,
    dryRun: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--file':
      case '-f':
        if (i + 1 >= args.length) { console.error('  ✗ --file requires a path'); process.exit(1) }
        opts.file = args[++i]
        if (!opts.file.trim()) { console.error('  ✗ --file cannot be empty'); process.exit(1) }
        break
      case '--text':
      case '-t':
        if (i + 1 >= args.length) { console.error('  ✗ --text requires a value'); process.exit(1) }
        opts.text = args[++i]
        if (!opts.text.trim()) { console.error('  ✗ --text cannot be empty'); process.exit(1) }
        break
      case '--template':
        if (i + 1 >= args.length) { console.error('  ✗ --template requires a name'); process.exit(1) }
        opts.template = args[++i]
        if (!opts.template.trim()) { console.error('  ✗ --template cannot be empty'); process.exit(1) }
        break
      case '--context':
        if (i + 1 >= args.length) { console.error('  ✗ --context requires a path'); process.exit(1) }
        opts.context = args[++i]
        if (!opts.context.trim()) { console.error('  ✗ --context cannot be empty'); process.exit(1) }
        break
      case '--context-text':
        if (i + 1 >= args.length) { console.error('  ✗ --context-text requires a value'); process.exit(1) }
        opts.contextText = args[++i]
        if (!opts.contextText.trim()) { console.error('  ✗ --context-text cannot be empty'); process.exit(1) }
        break
      case '--output':
      case '-o':
        if (i + 1 >= args.length) { console.error('  ✗ --output requires a path'); process.exit(1) }
        opts.output = args[++i]
        if (!opts.output.trim()) { console.error('  ✗ --output cannot be empty'); process.exit(1) }
        break
      case '--adapter':
      case '-a':
        if (i + 1 >= args.length) { console.error('  ✗ --adapter requires a name'); process.exit(1) }
        opts.adapter = args[++i]
        if (!opts.adapter.trim()) { console.error('  ✗ --adapter cannot be empty'); process.exit(1) }
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--dry-run':
      case '--dryRun':
        opts.dryRun = true
        break
      default:
        console.error(`  ✗ Unknown option: ${arg}. Run with --help to see available options.`)
        console.log(HELP)
        process.exit(1)
    }
  }

  return opts
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

export default async function plan({ args, pkgRoot }: CliContext): Promise<void> {
  const opts = parseArgs(args)

  if (opts.help) {
    console.log(HELP)
    return
  }

  if (!opts.file && !opts.text) {
    console.error(`  ✗ Either --file or --text is required.`)
    console.log(HELP)
    process.exit(1)
  }

  if (opts.file && opts.text) {
    console.error(`  ✗ --file and --text are mutually exclusive.`)
    process.exit(1)
  }

  const filePath = opts.file ? resolve(process.cwd(), opts.file) : undefined

  if (filePath && !existsSync(filePath)) {
    console.error(`  ✗ File not found: ${opts.file}`)
    process.exit(1)
  }

  const outputPath = opts.output ? resolve(process.cwd(), opts.output) : undefined
  const source = opts.file
    ? opts.file
    : `"${(opts.text ?? '').slice(0, 60)}${(opts.text ?? '').length > 60 ? '…' : ''}"`

  console.log(c.dim(`  Template: ${opts.template}`))
  console.log(c.dim(`  Input:    ${source}\n`))

  let result: PromptStepResult
  try {
    result = await runPromptStep({
      template: opts.template,
      filePath,
      goalText: opts.text ?? undefined,
      contextPath: opts.context ?? undefined,
      contextText: opts.contextText ?? undefined,
      outputPath,
      adapterName: opts.adapter ?? undefined,
      verbose: opts.verbose,
      dryRun: opts.dryRun,
      pkgRoot,
    })
  } catch (err) {
    console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (opts.dryRun) return

  switch (result.outputType) {
    case 'validation': {
      if (result.isValid) {
        console.log(c.green(`  ✓ VALID`))
      } else {
        console.log(c.red(`  ✗ INVALID\n`))
        console.log(result.errors ?? result.rawOutput)
        process.exit(1)
      }
      break
    }
    case 'prd': {
      const relPath = result.outputPath!.startsWith(process.cwd())
        ? result.outputPath!.slice(process.cwd().length + 1)
        : result.outputPath!
      console.log(c.green(`  ✓ PRD written to ${relPath}`))
      console.log(`\n  ${c.dim('Next step:')} opencastle convoy plan --prd ${relPath}`)
      break
    }
    case 'json': {
      if (result.outputPath) {
        const relP = result.outputPath.startsWith(process.cwd())
          ? result.outputPath.slice(process.cwd().length + 1)
          : result.outputPath
        console.log(c.green(`  ✓ JSON written to ${relP}`))
      }
      console.log(result.rawOutput)
      break
    }
    default: {
      const relPath = result.outputPath!.startsWith(process.cwd())
        ? result.outputPath!.slice(process.cwd().length + 1)
        : result.outputPath!
      console.log(c.green(`  ✓ Convoy spec written to ${relPath}`))
      if (result.isValid === false) {
        console.log(c.yellow(`    (contains validation warnings — review before running)`))
      }
      console.log(`
  ${c.dim('Preview:')} npx opencastle convoy run -f ${relPath} --dry-run
  ${c.dim('Execute:')} npx opencastle convoy run -f ${relPath}
`)
    }
  }

  await cleanupAdapters()
}
