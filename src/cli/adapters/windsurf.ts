import { resolve, basename } from 'node:path'
import { mkdir, writeFile, readdir, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { copyDir, getOrchestratorRoot, removeDirIfExists, getPluginsRoot, getPluginSkillEntries } from '../copy.js'
import { scaffoldMcpConfig } from '../mcp.js'
import { getExcludedSkills, getExcludedAgents, getIncludedPluginIds } from '../stack-config.js'
import type { CopyResults, DoctorCheck, ManagedPaths, RepoInfo, StackConfig } from '../types.js'
import { splitFrontmatter, parseFrontmatterString } from './frontmatter.js'

/**
 * Windsurf adapter.
 *
 * Transforms Copilot-format orchestrator files into Windsurf's rule format.
 *
 *   copilot-instructions.md    → .windsurfrules
 *   instructions/*.md          → .windsurf/rules/*.md            (trigger: always_on)
 *   agents/*.agent.md          → .windsurf/rules/agents/*.md     (trigger: model_decision)
 *   skills/\*\/SKILL.md         → .windsurf/rules/skills/*.md     (trigger: model_decision)
 *   agent-workflows/*.md       → .windsurf/rules/agent-workflows/*.md
 *   prompts/*.prompt.md        → .windsurf/rules/prompts/*.md
 *   customizations/            → .windsurf/rules/customizations/  (scaffolded once)
 */

export const IDE_ID = 'windsurf'
export const IDE_LABEL = 'Windsurf'

// ─── Helpers ──────────────────────────────────────────────────────

interface WindsurfRuleOptions {
  description?: string
  globs?: string[]
  trigger: 'always_on' | 'model_decision' | 'glob' | 'manual'
  body: string
}

function toWindsurfRule({ description, globs, trigger, body }: WindsurfRuleOptions): string {
  const lines = ['---']
  lines.push(`trigger: ${trigger}`)
  if (description) lines.push(`description: "${description}"`)
  if (globs && trigger === 'glob') lines.push(`globs: ${JSON.stringify(globs)}`)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

/** Convert a source filename to .md, stripping intermediate extensions. */
function windsurfName(name: string): string {
  const compound = name.replace(/\.(agent|instructions|prompt)\.md$/, '.md')
  if (compound !== name) return compound
  return name  // already .md
}

interface ConvertFileOptions {
  alwaysApply?: boolean
  descriptionFallback?: string
}

/** Read a source .md and produce a Windsurf rule string. */
async function convertFile(
  srcPath: string,
  { alwaysApply = false, descriptionFallback = '' }: ConvertFileOptions = {}
): Promise<string> {
  const content = await readFile(srcPath, 'utf8')
  const { frontmatter, body } = splitFrontmatter(content)
  const meta = parseFrontmatterString(frontmatter)

  // Description: frontmatter > fallback > first heading
  let description = meta['description'] ?? descriptionFallback
  if (!description) {
    const heading = body.match(/^#\s+(.+)/m)
    if (heading) description = heading[1]
  }

  // Determine trigger and globs
  let trigger: WindsurfRuleOptions['trigger']
  let globs: string[] | undefined

  if (meta['applyTo'] === '**') {
    trigger = 'always_on'
  } else if (meta['applyTo']) {
    trigger = 'glob'
    globs = [meta['applyTo']]
  } else if (alwaysApply) {
    trigger = 'always_on'
  } else {
    trigger = 'model_decision'
  }

  return toWindsurfRule({ description, globs, trigger, body: body.trim() })
}

/** Write a converted file; skip if it already exists (unless overwrite). */
async function writeConverted(
  srcPath: string,
  destPath: string,
  opts: ConvertFileOptions,
  results: CopyResults,
  overwrite = false
): Promise<void> {
  if (!overwrite && existsSync(destPath)) {
    results.skipped.push(destPath)
    return
  }
  const existed = existsSync(destPath)
  const rule = await convertFile(srcPath, opts)
  await writeFile(destPath, rule)
  results[existed ? 'copied' : 'created'].push(destPath)
}

// ─── Install ──────────────────────────────────────────────────────

export async function install(
  pkgRoot: string,
  projectRoot: string,
  stack?: StackConfig,
  repoInfo?: RepoInfo
): Promise<CopyResults> {
  const srcRoot = getOrchestratorRoot(pkgRoot)
  const results: CopyResults = { copied: [], skipped: [], created: [] }

  const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
  const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

  // 1. .windsurfrules  ← Windsurf-specific intro
  const windsurfrules = resolve(projectRoot, '.windsurfrules')
  if (!existsSync(windsurfrules)) {
    const windsurfIntro = [
      '# Project Instructions',
      '',
      'All conventions, architecture, and project context live in `.windsurf/rules/`. Read those files before making changes.',
      '',
    ].join('\n')
    await writeFile(windsurfrules, windsurfIntro)
    results.created.push(windsurfrules)
  } else {
    results.skipped.push(windsurfrules)
  }

  const rulesRoot = resolve(projectRoot, '.windsurf', 'rules')
  await mkdir(rulesRoot, { recursive: true })

  // 2. Instructions → .windsurf/rules/*.md  (trigger: always_on)
  await convertDir(srcRoot, 'instructions', rulesRoot, results, {
    alwaysApply: true,
  })

  // 3. Agents → .windsurf/rules/agents/*.md
  await convertDir(srcRoot, 'agents', resolve(rulesRoot, 'agents'), results, {
    descriptionPrefix: 'Agent: ',
    removeExt: '.agent.md',
    excludeFiles: excludedAgents,
  })

  // 4. Skills → .windsurf/rules/skills/*.md
  await convertSkills(srcRoot, resolve(rulesRoot, 'skills'), results, false, excludedSkills)

  // 4b. Plugin skills → .windsurf/rules/skills/<plugin-id>.md
  {
    const pluginsRoot = getPluginsRoot(pkgRoot)
    const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
    const pluginEntries = await getPluginSkillEntries(pluginsRoot, includedPlugins)
    const skillsDest = resolve(rulesRoot, 'skills')
    await mkdir(skillsDest, { recursive: true })
    for (const { id, skillPath } of pluginEntries) {
      const destPath = resolve(skillsDest, `${id}.md`)
      await writeConverted(
        skillPath,
        destPath,
        { descriptionFallback: `Skill: ${id}` },
        results
      )
    }
  }

  // 5. Agent Workflows → .windsurf/rules/agent-workflows/*.md
  await convertDir(
    srcRoot,
    'agent-workflows',
    resolve(rulesRoot, 'agent-workflows'),
    results,
    { descriptionPrefix: 'Workflow: ', excludeFiles: new Set(['README.md']) }
  )

  // 6. Prompts → .windsurf/rules/prompts/*.md
  await convertDir(srcRoot, 'prompts', resolve(rulesRoot, 'prompts'), results, {
    descriptionPrefix: 'Prompt: ',
    removeExt: '.prompt.md',
  })

  // 7. MCP server config → .windsurf/mcp.json (scaffold once)
  const mcpResult = await scaffoldMcpConfig(
    projectRoot,
    '.windsurf/mcp.json',
    stack,
    repoInfo,
    'windsurf'
  )
  results[mcpResult.action].push(mcpResult.path)

  return results
}

// ─── Update ───────────────────────────────────────────────────────

export async function update(
  pkgRoot: string,
  projectRoot: string,
  stack?: StackConfig
): Promise<CopyResults> {
  const srcRoot = getOrchestratorRoot(pkgRoot)
  const results: CopyResults = { copied: [], skipped: [], created: [] }

  const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
  const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

  // Overwrite .windsurfrules with Windsurf-specific intro
  const windsurfIntro = [
    '# Project Instructions',
    '',
    'All conventions, architecture, and project context live in `.windsurf/rules/`. Read those files before making changes.',
    '',
  ].join('\n')
  await writeFile(resolve(projectRoot, '.windsurfrules'), windsurfIntro)
  results.copied.push('.windsurfrules')

  const rulesRoot = resolve(projectRoot, '.windsurf', 'rules')

  // Remove existing framework rule directories to clear stale files
  const FRAMEWORK_RULE_DIRS = ['agents', 'skills', 'agent-workflows', 'prompts']
  for (const dir of FRAMEWORK_RULE_DIRS) {
    await removeDirIfExists(resolve(rulesRoot, dir))
  }

  // Remove stale root-level instruction .md files (in case instructions were renamed)
  if (existsSync(rulesRoot)) {
    for (const file of await readdir(rulesRoot)) {
      if (file.endsWith('.md')) {
        await unlink(resolve(rulesRoot, file))
      }
    }
  }

  // Overwrite framework rules
  await convertDir(srcRoot, 'instructions', rulesRoot, results, {
    alwaysApply: true,
    overwrite: true,
  })
  await convertDir(
    srcRoot,
    'agents',
    resolve(rulesRoot, 'agents'),
    results,
    { descriptionPrefix: 'Agent: ', removeExt: '.agent.md', overwrite: true, excludeFiles: excludedAgents }
  )
  await convertSkills(srcRoot, resolve(rulesRoot, 'skills'), results, true, excludedSkills)

  // Plugin skills → .windsurf/rules/skills/<plugin-id>.md (overwrite)
  {
    const pluginsRoot = getPluginsRoot(pkgRoot)
    const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
    const pluginEntries = await getPluginSkillEntries(pluginsRoot, includedPlugins)
    const skillsDest = resolve(rulesRoot, 'skills')
    await mkdir(skillsDest, { recursive: true })
    for (const { id, skillPath } of pluginEntries) {
      const destPath = resolve(skillsDest, `${id}.md`)
      await writeConverted(
        skillPath,
        destPath,
        { descriptionFallback: `Skill: ${id}` },
        results,
        true
      )
    }
  }

  await convertDir(
    srcRoot,
    'agent-workflows',
    resolve(rulesRoot, 'agent-workflows'),
    results,
    { descriptionPrefix: 'Workflow: ', overwrite: true, excludeFiles: new Set(['README.md']) }
  )
  await convertDir(
    srcRoot,
    'prompts',
    resolve(rulesRoot, 'prompts'),
    results,
    { descriptionPrefix: 'Prompt: ', removeExt: '.prompt.md', overwrite: true }
  )

  // Customizations are NEVER overwritten.

  // All re-installed framework files count as "updated" (copied), not "created"
  results.copied.push(...results.created)
  results.created = []

  return results
}

// ─── Managed paths ────────────────────────────────────────────────

export function getManagedPaths(): ManagedPaths {
  return {
    framework: [
      '.windsurfrules',
      '.windsurf/rules/agents/',
      '.windsurf/rules/skills/',
      '.windsurf/rules/agent-workflows/',
      '.windsurf/rules/prompts/',
      '.windsurf/rules/general.md',
      '.windsurf/rules/ai-optimization.md',
    ],
    customizable: [
      '.opencastle/',
      '.windsurf/mcp.json',
    ],
  }
}

export function getDoctorChecks(): DoctorCheck[] {
  return [
    { label: 'Windsurf rules file', path: '.windsurfrules', type: 'file' },
    { label: 'Instruction rules', path: '.windsurf/rules/', type: 'dir', countContents: true, countFilter: '.md' },
    { label: 'Agent rules', path: '.windsurf/rules/agents/', type: 'dir', countContents: true, countFilter: '.md' },
    { label: 'Skill rules', path: '.windsurf/rules/skills/', type: 'dir', countContents: true, countFilter: '.md' },
    { label: 'Workflow rules', path: '.windsurf/rules/agent-workflows/', type: 'dir', countContents: true },
    { label: 'Prompt rules', path: '.windsurf/rules/prompts/', type: 'dir', countContents: true },
  ]
}

// ─── Internal helpers ─────────────────────────────────────────────

interface ConvertDirOptions {
  alwaysApply?: boolean
  descriptionPrefix?: string
  removeExt?: string
  overwrite?: boolean
  excludeFiles?: Set<string>
}

async function convertDir(
  srcRoot: string,
  dirName: string,
  destDir: string,
  results: CopyResults,
  {
    alwaysApply,
    descriptionPrefix,
    removeExt,
    overwrite,
    excludeFiles,
  }: ConvertDirOptions = {}
): Promise<void> {
  const srcDir = resolve(srcRoot, dirName)
  if (!existsSync(srcDir)) return

  await mkdir(destDir, { recursive: true })

  for (const file of await readdir(srcDir)) {
    if (!file.endsWith('.md')) continue
    if (excludeFiles?.has(file)) continue
    const fallback = descriptionPrefix
      ? `${descriptionPrefix}${basename(file, removeExt ?? '.md')}`
      : ''
    const destPath = resolve(destDir, windsurfName(file))
    await writeConverted(
      resolve(srcDir, file),
      destPath,
      { alwaysApply: alwaysApply ?? false, descriptionFallback: fallback },
      results,
      overwrite
    )
  }
}

async function convertSkills(
  srcRoot: string,
  destDir: string,
  results: CopyResults,
  overwrite = false,
  excludedSkills?: Set<string>
): Promise<void> {
  const skillsDir = resolve(srcRoot, 'skills')
  if (!existsSync(skillsDir)) return

  await mkdir(destDir, { recursive: true })

  const subdirs = await readdir(skillsDir, { withFileTypes: true })
  for (const entry of subdirs) {
    if (!entry.isDirectory()) continue
    if (excludedSkills?.has(entry.name)) continue
    const skillFile = resolve(skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue

    // Main skill → skills/<name>.md
    const destPath = resolve(destDir, `${entry.name}.md`)
    await writeConverted(
      skillFile,
      destPath,
      { descriptionFallback: `Skill: ${entry.name}` },
      results,
      overwrite
    )

    // Extra files in the skill directory (e.g. templates)
    const files = await readdir(resolve(skillsDir, entry.name))
    const extras = files.filter((f) => f !== 'SKILL.md' && f.endsWith('.md'))
    if (extras.length > 0) {
      const subDest = resolve(destDir, entry.name)
      await mkdir(subDest, { recursive: true })
      for (const file of extras) {
        const extraDest = resolve(subDest, windsurfName(file))
        await writeConverted(
          resolve(skillsDir, entry.name, file),
          extraDest,
          { descriptionFallback: `${entry.name}: ${basename(file, '.md')}` },
          results,
          overwrite
        )
      }
    }
  }
}
