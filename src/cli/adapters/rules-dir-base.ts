import { resolve, basename } from 'node:path'
import { mkdir, writeFile, readdir, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getOrchestratorRoot, removeDirIfExists, getPluginsRoot, getPluginSkillEntries } from '../copy.js'
import { scaffoldMcpConfig } from '../mcp.js'
import { getExcludedSkills, getExcludedAgents, getIncludedPluginIds } from '../stack-config.js'
import type { CopyResults, DoctorCheck, IdeChoice, ManagedPaths, RepoInfo, StackConfig } from '../types.js'
import { splitFrontmatter, parseFrontmatterString } from './frontmatter.js'
import { writeManagedBlock } from '../managed-block.js'

/**
 * Shared implementation for IDEs that take a root rules file plus a directory of
 * per-rule files with frontmatter — currently Cursor and Windsurf.
 *
 *   copilot-instructions.md → <rootRulesFile>
 *   instructions/*.md       → <configDir>/rules/*<ruleExt>          (always applies)
 *   agents/*.agent.md       → <configDir>/rules/agents/*<ruleExt>
 *   skills/{star}/SKILL.md  → <configDir>/rules/skills/*<ruleExt>
 *   agent-workflows/*.md    → <configDir>/rules/agent-workflows/*<ruleExt>
 *   prompts/*.prompt.md     → <configDir>/rules/prompts/*<ruleExt>
 *
 * The two IDEs differ only in file extension, the frontmatter dialect that
 * expresses when a rule applies, and their paths — all supplied by RulesDirConfig.
 */

/** How a rule should be scoped, before it is rendered into an IDE's dialect. */
export interface RuleScope {
  description?: string
  /** The source file's `applyTo` glob, if it declared one. */
  applyTo?: string
  /** Whether this rule should apply unconditionally (instructions do). */
  alwaysApply: boolean
  /**
   * The agent's capability tier, when the source declared one.
   *
   * Carried through so an agent rule says what kind of model the work wants. The
   * single-file targets render this into their agent index; dropping it here
   * meant Cursor and Windsurf users were the only ones who could not see it.
   */
  tier?: string
}

export interface RulesDirConfig {
  ideId: IdeChoice
  ideLabel: string
  /** Root file written at the project root, e.g. `.cursorrules`. */
  rootRulesFile: string
  /** IDE config directory holding `rules/` and `mcp.json`, e.g. `.cursor`. */
  configDir: string
  /** Extension for generated rule files, including the dot. */
  ruleExt: string
  /** Renders the YAML frontmatter lines (without the `---` fences). */
  renderFrontmatter(scope: RuleScope): string[]
}

export interface RulesDirAdapter {
  IDE_ID: IdeChoice
  IDE_LABEL: string
  install(pkgRoot: string, projectRoot: string, stack?: StackConfig, repoInfo?: RepoInfo): Promise<CopyResults>
  update(pkgRoot: string, projectRoot: string, stack?: StackConfig): Promise<CopyResults>
  getManagedPaths(): ManagedPaths
  getDoctorChecks(): DoctorCheck[]
}

export function createRulesDirAdapter(config: RulesDirConfig): RulesDirAdapter {
  const { ideId, ideLabel, rootRulesFile, configDir, ruleExt, renderFrontmatter } = config
  const rulesPrefix = `${configDir}/rules`
  const mcpPath = `${configDir}/mcp.json`

  const rootIntro = [
    '# Project Instructions',
    '',
    `All conventions, architecture, and project context live in \`${rulesPrefix}/\`. Read those files before making changes.`,
    '',
  ].join('\n')

  /** Strip the source file's compound extension and apply the IDE's own. */
  function ruleName(name: string): string {
    const compound = name.replace(/\.(agent|instructions|prompt)\.md$/, ruleExt)
    if (compound !== name) return compound
    return name.replace(/\.md$/, ruleExt)
  }

  interface ConvertFileOptions {
    alwaysApply?: boolean
    descriptionFallback?: string
  }

  async function convertFile(
    srcPath: string,
    { alwaysApply = false, descriptionFallback = '' }: ConvertFileOptions = {},
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

    const lines = ['---', ...renderFrontmatter({
      description,
      applyTo: meta['applyTo'],
      alwaysApply,
      tier: meta['tier'],
    }), '---', '', body.trim(), '']
    return lines.join('\n')
  }

  async function writeConverted(
    srcPath: string,
    destPath: string,
    opts: ConvertFileOptions,
    results: CopyResults,
    overwrite = false,
  ): Promise<void> {
    if (!overwrite && existsSync(destPath)) {
      results.skipped.push(destPath)
      return
    }
    const existed = existsSync(destPath)
    await writeFile(destPath, await convertFile(srcPath, opts))
    results[existed ? 'copied' : 'created'].push(destPath)
  }

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
    { alwaysApply, descriptionPrefix, removeExt, overwrite, excludeFiles }: ConvertDirOptions = {},
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
      await writeConverted(
        resolve(srcDir, file),
        resolve(destDir, ruleName(file)),
        { alwaysApply: alwaysApply ?? false, descriptionFallback: fallback },
        results,
        overwrite,
      )
    }
  }

  async function convertSkills(
    srcRoot: string,
    destDir: string,
    results: CopyResults,
    overwrite = false,
    excludedSkills?: Set<string>,
  ): Promise<void> {
    const skillsDir = resolve(srcRoot, 'skills')
    if (!existsSync(skillsDir)) return

    await mkdir(destDir, { recursive: true })

    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (excludedSkills?.has(entry.name)) continue
      const skillFile = resolve(skillsDir, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue

      await writeConverted(
        skillFile,
        resolve(destDir, `${entry.name}${ruleExt}`),
        { descriptionFallback: `Skill: ${entry.name}` },
        results,
        overwrite,
      )

      // Extra files in the skill directory (e.g. templates)
      const files = await readdir(resolve(skillsDir, entry.name))
      const extras = files.filter((f) => f !== 'SKILL.md' && f.endsWith('.md'))
      if (extras.length > 0) {
        const subDest = resolve(destDir, entry.name)
        await mkdir(subDest, { recursive: true })
        for (const file of extras) {
          await writeConverted(
            resolve(skillsDir, entry.name, file),
            resolve(subDest, ruleName(file)),
            { descriptionFallback: `${entry.name}: ${basename(file, '.md')}` },
            results,
            overwrite,
          )
        }
      }
    }
  }

  /** Plugin skills land as a single rule file per plugin id. */
  async function convertPluginSkills(
    pkgRoot: string,
    rulesRoot: string,
    results: CopyResults,
    stack: StackConfig | undefined,
    overwrite: boolean,
  ): Promise<void> {
    const pluginEntries = await getPluginSkillEntries(
      getPluginsRoot(pkgRoot),
      stack ? getIncludedPluginIds(stack) : undefined,
    )
    const skillsDest = resolve(rulesRoot, 'skills')
    await mkdir(skillsDest, { recursive: true })
    for (const { id, skillPath } of pluginEntries) {
      await writeConverted(
        skillPath,
        resolve(skillsDest, `${id}${ruleExt}`),
        { descriptionFallback: `Skill: ${id}` },
        results,
        overwrite,
      )
    }
  }

  async function install(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig,
    repoInfo?: RepoInfo,
  ): Promise<CopyResults> {
    const srcRoot = getOrchestratorRoot(pkgRoot)
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
    const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

    // Merged, not skipped: a project that already has a rules file keeps it and
    // gains the generated pointer in a managed block below.
    const rootFile = resolve(projectRoot, rootRulesFile)
    {
      const merge = await writeManagedBlock(rootFile, rootIntro)
      if (merge.staleGeneratedContent) (results.staleRoots ??= []).push(rootFile)
    if (merge.action === 'adopted' || merge.action === 'repaired') {
        results.created.push(rootFile)
        ;(results.adopted ??= []).push(rootFile)
      } else if (merge.action === 'created') {
        results.created.push(rootFile)
      } else if (merge.action === 'unchanged') {
        results.skipped.push(rootFile)
      }
      else results.copied.push(rootFile)
    }

    const rulesRoot = resolve(projectRoot, configDir, 'rules')
    await mkdir(rulesRoot, { recursive: true })

    await convertDir(srcRoot, 'instructions', rulesRoot, results, { alwaysApply: true })
    await convertDir(srcRoot, 'agents', resolve(rulesRoot, 'agents'), results, {
      descriptionPrefix: 'Agent: ',
      removeExt: '.agent.md',
      excludeFiles: excludedAgents,
    })
    await convertSkills(srcRoot, resolve(rulesRoot, 'skills'), results, false, excludedSkills)
    await convertPluginSkills(pkgRoot, rulesRoot, results, stack, false)
    await convertDir(srcRoot, 'agent-workflows', resolve(rulesRoot, 'agent-workflows'), results, {
      descriptionPrefix: 'Workflow: ',
      excludeFiles: new Set(['README.md']),
    })
    await convertDir(srcRoot, 'prompts', resolve(rulesRoot, 'prompts'), results, {
      descriptionPrefix: 'Prompt: ',
      removeExt: '.prompt.md',
    })

    const mcpResult = await scaffoldMcpConfig(projectRoot, mcpPath, stack, repoInfo, ideId)
    results[mcpResult.action].push(mcpResult.path)

    return results
  }

  async function update(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig,
  ): Promise<CopyResults> {
    const srcRoot = getOrchestratorRoot(pkgRoot)
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
    const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

    const rootPath = resolve(projectRoot, rootRulesFile)
    const rootMerge = await writeManagedBlock(rootPath, rootIntro)
    results.copied.push(rootRulesFile)
    if (rootMerge.action === 'adopted' || rootMerge.action === 'repaired') (results.adopted ??= []).push(rootPath)
    if (rootMerge.staleGeneratedContent) (results.staleRoots ??= []).push(rootPath)

    const rulesRoot = resolve(projectRoot, configDir, 'rules')

    // Clear the whole rules directory, which is what `getManagedPaths` declares
    // and what the drift checker compares. Sweeping only the four known
    // subdirectories plus root-level rule files meant `sync --check` reported
    // `.cursor/rules/NOTES.md` and `.cursor/rules/team/mine.mdc` as "added by
    // hand (deleted on the next sync)" and then `sync` left them there — a
    // report that could never be cleared, so CI stayed red and `needsSync`
    // stayed true forever. Whatever the checker warns about, this removes.
    await removeDirIfExists(rulesRoot)

    await convertDir(srcRoot, 'instructions', rulesRoot, results, {
      alwaysApply: true,
      overwrite: true,
    })
    await convertDir(srcRoot, 'agents', resolve(rulesRoot, 'agents'), results, {
      descriptionPrefix: 'Agent: ',
      removeExt: '.agent.md',
      overwrite: true,
      excludeFiles: excludedAgents,
    })
    await convertSkills(srcRoot, resolve(rulesRoot, 'skills'), results, true, excludedSkills)
    await convertPluginSkills(pkgRoot, rulesRoot, results, stack, true)
    await convertDir(srcRoot, 'agent-workflows', resolve(rulesRoot, 'agent-workflows'), results, {
      descriptionPrefix: 'Workflow: ',
      overwrite: true,
      excludeFiles: new Set(['README.md']),
    })
    await convertDir(srcRoot, 'prompts', resolve(rulesRoot, 'prompts'), results, {
      descriptionPrefix: 'Prompt: ',
      removeExt: '.prompt.md',
      overwrite: true,
    })

    // Customizations are NEVER overwritten.

    // Re-installed framework files count as updated, not created.
    results.copied.push(...results.created)
    results.created = []

    return results
  }

  function getManagedPaths(): ManagedPaths {
    return {
      merged: [rootRulesFile],
      // The whole rules directory, not the six paths inside it that we happen to
      // write. `update` clears every rule file at this root before regenerating,
      // so anything else living here is deleted — and listing only our own paths
      // meant the drift check walked past a hand-written
      // `.cursor/rules/team-conventions.mdc` and reported "all clear" moments
      // before `sync` removed it. This is Cursor's documented place for project
      // rules, so that file is one people really do write.
      framework: [`${rulesPrefix}/`],
      customizable: ['.opencastle/', mcpPath],
    }
  }

  function getDoctorChecks(): DoctorCheck[] {
    return [
      { label: `${ideLabel} rules file`, path: rootRulesFile, type: 'file' },
      { label: 'Instruction rules', path: `${rulesPrefix}/`, type: 'dir', countContents: true, countFilter: ruleExt },
      { label: 'Agent rules', path: `${rulesPrefix}/agents/`, type: 'dir', countContents: true, countFilter: ruleExt },
      { label: 'Skill rules', path: `${rulesPrefix}/skills/`, type: 'dir', countContents: true, countFilter: ruleExt },
      { label: 'Workflow rules', path: `${rulesPrefix}/agent-workflows/`, type: 'dir', countContents: true },
      { label: 'Prompt rules', path: `${rulesPrefix}/prompts/`, type: 'dir', countContents: true },
    ]
  }

  return { IDE_ID: ideId, IDE_LABEL: ideLabel, install, update, getManagedPaths, getDoctorChecks }
}
