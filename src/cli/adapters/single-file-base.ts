import { resolve, basename } from 'node:path'
import { mkdir, writeFile, readdir, readFile, unlink, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { writeManagedBlock } from '../managed-block.js'
import { TIERS, TIER_IDS, isTier, tierForAgent, type Tier } from '../tiers.js'
import { copyDir, getOrchestratorRoot, getPluginsRoot, getPluginSkillEntries } from '../copy.js'
import { scaffoldMcpConfig } from '../mcp.js'
import { getExcludedSkills, getExcludedAgents, getIncludedPluginIds } from '../stack-config.js'
import type { CopyResults, DoctorCheck, IdeAdapter, IdeChoice, ManagedPaths, RepoInfo, StackConfig } from '../types.js'
import { stripFrontmatter, parseFrontmatterMeta } from './frontmatter.js'

/**
 * Configuration for adapters that produce a single root instructions file
 * and a dot-directory structure (e.g. Claude Code → CLAUDE.md + .claude/,
 * OpenCode → AGENTS.md + .opencode/).
 */
export interface SingleFileAdapterConfig {
  /** Root instructions file name, e.g. 'CLAUDE.md' */
  rootFile: string
  /** Dot directory for framework files, e.g. '.claude' */
  dotDir: string
  /** Path for MCP config relative to project root, e.g. '.claude/mcp.json' */
  mcpConfigPath: string
  /** MCP format identifier passed to scaffoldMcpConfig */
  mcpFormat: IdeChoice
  /** Subdirectory name under dotDir for prompt output, e.g. 'commands' or 'prompts' */
  promptsDir: string
  /** Subdirectory name under dotDir for workflow output, e.g. 'commands' or 'workflows' */
  workflowsDir: string
  /** Prefix prepended to workflow filenames, e.g. 'workflow-' or '' */
  workflowPrefix: string
  /** Framework subdirectories (under dotDir) to remove during update */
  frameworkDirs: string[]
}

/**
 * Creates install/update/getManagedPaths functions from a config object.
 *
 * Both Claude Code and OpenCode share the same structure:
 * 1. A single root .md file with embedded instructions, agent index, and skill index
 * 2. Agent definitions stripped of frontmatter
 * 3. Skills stripped of frontmatter
 * 4. Prompts stripped of frontmatter
 * 5. Workflows stripped of frontmatter
 * 6. Customizations scaffolded once
 * 7. MCP config scaffolded once
 *
 * The only differences are directory names and file naming conventions.
 */
/**
 * Targets that compile to the same root file, in resolution order.
 *
 * OpenCode and Codex both own AGENTS.md. With both selected, each adapter wrote
 * the file pointing at its own directory and the last one to run won — so
 * `sync --check` compared the project against two different expected files and
 * reported drift that no amount of syncing could clear. When a root file is
 * shared, every adapter that shares it generates the same block, referencing the
 * first selected owner's directory. Both trees are still installed; the index
 * names one of them, and says so.
 */
const SHARED_ROOT_OWNERS: Record<string, Array<{ ide: string; dotDir: string }>> = {
  'AGENTS.md': [
    { ide: 'opencode', dotDir: '.opencode' },
    { ide: 'codex', dotDir: '.codex' },
  ],
}

/** The directory the shared root file should point at, given what is selected. */
function referenceDir(config: SingleFileAdapterConfig, stack?: StackConfig): {
  dir: string
  sharedWith: string[]
} {
  const owners = SHARED_ROOT_OWNERS[config.rootFile] ?? []
  const selected = new Set<string>(stack?.ides ?? [])
  const present = owners.filter((o) => selected.has(o.ide))
  if (present.length < 2) return { dir: config.dotDir, sharedWith: [] }
  return { dir: present[0].dotDir, sharedWith: present.map((o) => o.dotDir) }
}

export function createSingleFileAdapter(config: SingleFileAdapterConfig): IdeAdapter {
  async function install(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig,
    repoInfo?: RepoInfo
  ): Promise<CopyResults> {
    const srcRoot = getOrchestratorRoot(pkgRoot)
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
    const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

    // 1. Build root instructions file.
    // Always built: the content goes into a managed block, so a file the user
    // already owns keeps its content and gains the generated section.
    const rootPath = resolve(projectRoot, config.rootFile)
    const { dir: refDir, sharedWith } = referenceDir(config, stack)
    {
      const sections: string[] = []

      sections.push(
        '# Project Instructions\n\n' +
        'All conventions, architecture, and project context are embedded below. ' +
        `Skills are in \`${refDir}/skills/\` — read them when a task matches. ` +
        `Agent definitions are in \`${refDir}/agents/\` — read the relevant file when adopting a persona.` +
        (sharedWith.length > 1
          ? `\n\nThis file is shared by more than one assistant. The same content is also installed under ${sharedWith
              .filter((d) => d !== refDir)
              .map((d) => `\`${d}/\``)
              .join(', ')}.`
          : '')
      )

      // Always-loaded instruction files
      const instDir = resolve(srcRoot, 'instructions')
      if (existsSync(instDir)) {
        for (const file of (await readdir(instDir)).sort()) {
          if (!file.endsWith('.md')) continue
          const content = await readFile(resolve(instDir, file), 'utf8')
          sections.push(
            `\n---\n\n<!-- Source: instructions/${file} -->\n\n${stripFrontmatter(content)}`
          )
        }
      }

      // Agent reference
      const agentsDir = resolve(srcRoot, 'agents')
      if (existsSync(agentsDir)) {
        const agentLines: string[] = ['\n---\n\n## Agent Definitions\n']
        agentLines.push(
          'The following agent personas are available. Adopt the appropriate persona when asked.\n'
        )
        agentLines.push(
          'Each names a capability tier — what kind of model the work wants. Pick a ' +
            'concrete model yourself; you know which ones this account can reach.\n'
        )
        const usedTiers = new Set<Tier>()
        for (const file of (await readdir(agentsDir)).sort()) {
          if (!file.endsWith('.md')) continue
          if (excludedAgents.has(file)) continue
          const meta = parseFrontmatterMeta(
            await readFile(resolve(agentsDir, file), 'utf8')
          )
          const name = meta['name'] ?? basename(file, '.agent.md')
          const desc = meta['description'] ?? ''
          const declared = meta['tier'] ?? ''
          const tier = isTier(declared) ? declared : tierForAgent(basename(file, '.agent.md'))
          usedTiers.add(tier)
          agentLines.push(`- **${name}** *(${TIERS[tier].label})*: ${desc}`)
        }
        if (usedTiers.size > 0) {
          agentLines.push('')
          for (const id of TIER_IDS.filter((id) => usedTiers.has(id))) {
            agentLines.push(`- **${TIERS[id].label}** — ${TIERS[id].purpose}`)
          }
        }
        agentLines.push(
          `\nFull agent definitions are in \`${refDir}/agents/\`. Read the relevant file when adopting a persona.`
        )
        sections.push(agentLines.join('\n'))
      }

      // Skill index
      const skillsDir = resolve(srcRoot, 'skills')
      if (existsSync(skillsDir)) {
        const skillLines: string[] = ['\n---\n\n## Available Skills\n']
        skillLines.push(
          'Skills are on-demand knowledge files. Read the file when the task matches.\n'
        )
        const subdirs = (
          await readdir(skillsDir, { withFileTypes: true })
        ).filter((e) => e.isDirectory())
        const skillRef = (name: string): string =>
          `${refDir}/skills/${name}/SKILL.md`
        for (const entry of subdirs.sort((a, b) =>
          a.name.localeCompare(b.name)
        )) {
          if (excludedSkills.has(entry.name)) continue
          const skillFile = resolve(skillsDir, entry.name, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          const meta = parseFrontmatterMeta(await readFile(skillFile, 'utf8'))
          const desc = meta['description'] ?? ''
          skillLines.push(
            `- **${entry.name}** (\`${skillRef(entry.name)}\`): ${desc}`
          )
        }

        // Plugin skills
        const pluginsRoot = getPluginsRoot(pkgRoot)
        const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
        const pluginEntries = await getPluginSkillEntries(pluginsRoot, includedPlugins)
        for (const { id, skillPath } of pluginEntries.sort((a, b) => a.id.localeCompare(b.id))) {
          const pluginMeta = parseFrontmatterMeta(await readFile(skillPath, 'utf8'))
          const pluginDesc = pluginMeta['description'] ?? ''
          skillLines.push(
            `- **${id}** (\`${skillRef(id)}\`): ${pluginDesc}`
          )
        }

        sections.push(skillLines.join('\n'))
      }

      const merge = await writeManagedBlock(rootPath, sections.join('\n'))
      if (merge.staleGeneratedContent) (results.staleRoots ??= []).push(rootPath)
      if (merge.orphanMarker) (results.staleRoots ??= []).push(rootPath)
    if (merge.action === 'adopted' || merge.action === 'repaired') {
        results.created.push(rootPath)
        ;(results.adopted ??= []).push(rootPath)
      } else if (merge.action === 'created') {
        results.created.push(rootPath)
      } else if (merge.action === 'unchanged') {
        results.skipped.push(rootPath)
      } else {
        results.copied.push(rootPath)
      }
    }

    const dotDirPath = resolve(projectRoot, config.dotDir)

    // 2. Agent definitions → dotDir/agents/
    const agentsDir = resolve(srcRoot, 'agents')
    if (existsSync(agentsDir)) {
      const destAgents = resolve(dotDirPath, 'agents')
      await mkdir(destAgents, { recursive: true })
      for (const file of await readdir(agentsDir)) {
        if (!file.endsWith('.md')) continue
        if (excludedAgents.has(file)) continue
        const destPath = resolve(destAgents, file)
        if (existsSync(destPath)) {
          results.skipped.push(destPath)
          continue
        }
        const content = await readFile(resolve(agentsDir, file), 'utf8')
        await writeFile(destPath, stripFrontmatter(content) + '\n')
        results.created.push(destPath)
      }
    }

    // 3. Skills → dotDir/skills/<name>/SKILL.md (+ sibling resources, frontmatter preserved).
    //    Matches the SKILL.md-per-folder format used by Claude Code, OpenCode, Codex,
    //    and Antigravity — agents discover skills via the description: frontmatter field.
    const skillsDir = resolve(srcRoot, 'skills')
    if (existsSync(skillsDir)) {
      const destSkills = resolve(dotDirPath, 'skills')
      await mkdir(destSkills, { recursive: true })
      const subdirs = (
        await readdir(skillsDir, { withFileTypes: true })
      ).filter((e) => e.isDirectory())
      for (const entry of subdirs) {
        if (excludedSkills.has(entry.name)) continue
        const skillFile = resolve(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        const sub = await copyDir(
          resolve(skillsDir, entry.name),
          resolve(destSkills, entry.name)
        )
        results.created.push(...sub.created)
        results.skipped.push(...sub.skipped)
      }
    }

    // 3b. Plugin skills → dotDir/skills/<plugin-id>/SKILL.md
    {
      const pluginsRoot = getPluginsRoot(pkgRoot)
      const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
      const pluginEntries = await getPluginSkillEntries(pluginsRoot, includedPlugins)
      const destSkills = resolve(dotDirPath, 'skills')
      await mkdir(destSkills, { recursive: true })
      for (const { id, skillPath } of pluginEntries) {
        const pluginDestDir = resolve(destSkills, id)
        await mkdir(pluginDestDir, { recursive: true })
        const destPath = resolve(pluginDestDir, 'SKILL.md')
        if (existsSync(destPath)) {
          results.skipped.push(destPath)
          continue
        }
        await copyFile(skillPath, destPath)
        results.created.push(destPath)
      }
    }

    // 4. Prompts → dotDir/<promptsDir>/<name>.md
    const promptDir = resolve(srcRoot, 'prompts')
    if (existsSync(promptDir)) {
      const destPrompts = resolve(dotDirPath, config.promptsDir)
      await mkdir(destPrompts, { recursive: true })
      for (const file of await readdir(promptDir)) {
        if (!file.endsWith('.md')) continue
        const name = basename(file, '.prompt.md') || basename(file, '.md')
        const destPath = resolve(destPrompts, `${name}.md`)
        if (existsSync(destPath)) {
          results.skipped.push(destPath)
          continue
        }
        const content = await readFile(resolve(promptDir, file), 'utf8')
        await writeFile(destPath, stripFrontmatter(content) + '\n')
        results.created.push(destPath)
      }
    }

    // 5. Agent Workflows → dotDir/<workflowsDir>/<prefix><name>.md
    const wfDir = resolve(srcRoot, 'agent-workflows')
    if (existsSync(wfDir)) {
      const destWf = resolve(dotDirPath, config.workflowsDir)
      await mkdir(destWf, { recursive: true })
      for (const file of await readdir(wfDir)) {
        if (!file.endsWith('.md')) continue
        if (file === 'README.md') continue
        const name = basename(file, '.md')
        const destPath = resolve(destWf, `${config.workflowPrefix}${name}.md`)
        if (existsSync(destPath)) {
          results.skipped.push(destPath)
          continue
        }
        const content = await readFile(resolve(wfDir, file), 'utf8')
        await writeFile(destPath, stripFrontmatter(content) + '\n')
        results.created.push(destPath)
      }
    }

    // 7. MCP server config (scaffold once)
    const mcpResult = await scaffoldMcpConfig(
      projectRoot,
      config.mcpConfigPath,
      stack,
      repoInfo,
      config.mcpFormat
    )
    results[mcpResult.action].push(mcpResult.path)

    return results
  }

  async function update(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig
  ): Promise<CopyResults> {
    const results: CopyResults = { copied: [], skipped: [], created: [] }
    const dotDirPath = resolve(projectRoot, config.dotDir)

    // 1. Leave the root file in place. install() rewrites only the managed
    // block inside it, so deleting it here would destroy whatever the user
    // wrote around that block.

    // 2. Remove existing framework directories
    for (const dir of config.frameworkDirs) {
      const dirPath = resolve(dotDirPath, dir)
      if (existsSync(dirPath)) {
        await rm(dirPath, { recursive: true })
      }
    }

    // 3. Re-run full install
    const installResult = await install(pkgRoot, projectRoot, stack)
    results.copied.push(...installResult.created)
    results.skipped.push(...installResult.skipped)
    // Adoption happens inside install(); without this the notice never reaches
    // the user on the one command they actually run to upgrade.
    if (installResult.adopted?.length) results.adopted = installResult.adopted
    if (installResult.staleRoots?.length) results.staleRoots = installResult.staleRoots

    return results
  }

  function getManagedPaths(): ManagedPaths {
    // Deduplicate dirs (e.g. promptsDir === workflowsDir for claude-code's 'commands')
    const dirs = new Set(['agents', 'skills', ...config.frameworkDirs])
    return {
      framework: Array.from(dirs).map((d) => `${config.dotDir}/${d}/`),
      merged: [config.rootFile],
      customizable: ['.opencastle/', config.mcpConfigPath],
    }
  }

  function getDoctorChecks(): DoctorCheck[] {
    const checks: DoctorCheck[] = [
      { label: 'Root instructions file', path: config.rootFile, type: 'file' },
      { label: 'Agent definitions', path: `${config.dotDir}/agents/`, type: 'dir', countContents: true, countFilter: '.md' },
      { label: 'Skills directory', path: `${config.dotDir}/skills/`, type: 'dir', countContents: true },
    ]
    if (config.promptsDir === config.workflowsDir) {
      checks.push({ label: 'Commands directory', path: `${config.dotDir}/${config.promptsDir}/`, type: 'dir', countContents: true })
    } else {
      checks.push({ label: 'Prompts directory', path: `${config.dotDir}/${config.promptsDir}/`, type: 'dir', countContents: true })
      checks.push({ label: 'Workflows directory', path: `${config.dotDir}/${config.workflowsDir}/`, type: 'dir', countContents: true })
    }
    return checks
  }

  return { install, update, getManagedPaths, getDoctorChecks }
}
