import { resolve } from 'node:path'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { writeManagedBlock } from '../managed-block.js'
import { copyDir, getOrchestratorRoot, removeDirIfExists, getPluginsRoot, getPluginSkillEntries } from '../copy.js'
import { scaffoldMcpConfig } from '../mcp.js'
import { getExcludedSkills, getExcludedAgents, getIncludedPluginIds, getAgentTransform } from '../stack-config.js'
import type { CopyResults, CopyDirOptions, DoctorCheck, ManagedPaths, RepoInfo, StackConfig } from '../types.js'

/**
 * VS Code / GitHub Copilot adapter.
 *
 * This is the **native format** — the orchestrator source files map 1:1.
 *
 *   copilot-instructions.md    → .github/copilot-instructions.md
 *   agents/                    → .github/agents/
 *   instructions/              → .github/instructions/
 *   skills/                    → .github/skills/
 *   agent-workflows/           → .github/agent-workflows/
 *   prompts/                   → .github/prompts/
 *   customizations/            → .opencastle/  (scaffolded once)
 */

export const IDE_ID = 'vscode'
export const IDE_LABEL = 'VS Code (GitHub Copilot)'

/** Directories whose contents are framework-managed (overwritten on update). */
const FRAMEWORK_DIRS = [
  'agents',
  'instructions',
  'skills',
  'agent-workflows',
  'prompts',
]

/** Directories scaffolded once and never overwritten. */
const CUSTOMIZABLE_DIRS: string[] = []

export async function install(
  pkgRoot: string,
  projectRoot: string,
  stack?: StackConfig,
  repoInfo?: RepoInfo
): Promise<CopyResults> {
  const srcRoot = getOrchestratorRoot(pkgRoot)
  const destRoot = resolve(projectRoot, '.github')

  await mkdir(destRoot, { recursive: true })

  const results: CopyResults = { copied: [], skipped: [], created: [] }

  const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
  const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

  // copilot-instructions.md — merged, not replaced. A project that already has
  // one keeps it; the generated content goes into a managed block below it.
  const copilotSrc = resolve(srcRoot, 'copilot-instructions.md')
  const copilotDest = resolve(destRoot, 'copilot-instructions.md')
  {
    const merge = await writeManagedBlock(copilotDest, await readFile(copilotSrc, 'utf8'))
    if (merge.staleGeneratedContent) (results.staleRoots ??= []).push(copilotDest)
    if (merge.action === 'adopted' || merge.action === 'repaired') {
      results.created.push(copilotDest)
      ;(results.adopted ??= []).push(copilotDest)
    } else if (merge.action === 'created') {
      results.created.push(copilotDest)
    } else if (merge.action === 'unchanged') {
      results.skipped.push(copilotDest)
    }
    else results.copied.push(copilotDest)
  }

  // Framework directories
  for (const dir of FRAMEWORK_DIRS) {
    const srcDir = resolve(srcRoot, dir)
    if (!existsSync(srcDir)) continue
    const destDir = resolve(destRoot, dir)

    // Build filter based on directory type
    let filter: ((_name: string, _srcPath: string) => boolean) | undefined
    let transform: CopyDirOptions['transform'] | undefined
    if (dir === 'skills') {
      filter = (name) => !excludedSkills.has(name)
    } else if (dir === 'agents') {
      filter = (name) => !excludedAgents.has(name)
      transform = stack ? getAgentTransform(stack) : undefined
    }

    const sub = await copyDir(srcDir, destDir, { filter, transform })
    results.copied.push(...sub.copied)
    results.skipped.push(...sub.skipped)
    results.created.push(...sub.created)
  }

  // Plugin skills → .github/skills/<plugin-id>/
  const pluginsRoot = getPluginsRoot(pkgRoot)
  const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
  const pluginSkills = await getPluginSkillEntries(pluginsRoot, includedPlugins)
  for (const { id, skillPath } of pluginSkills) {
    const pluginDestDir = resolve(destRoot, 'skills', id)
    await mkdir(pluginDestDir, { recursive: true })
    const destPath = resolve(pluginDestDir, 'SKILL.md')
    if (existsSync(destPath)) {
      results.skipped.push(destPath)
    } else {
      await copyFile(skillPath, destPath)
      results.created.push(destPath)
    }
  }

  // MCP server config → .vscode/mcp.json (scaffold once)
  const mcpResult = await scaffoldMcpConfig(
    projectRoot,
    '.vscode/mcp.json',
    stack,
    repoInfo,
    'vscode'
  )
  results[mcpResult.action].push(mcpResult.path)

  return results
}

export async function update(
  pkgRoot: string,
  projectRoot: string,
  stack?: StackConfig
): Promise<CopyResults> {
  const srcRoot = getOrchestratorRoot(pkgRoot)
  const destRoot = resolve(projectRoot, '.github')

  const results: CopyResults = { copied: [], skipped: [], created: [] }

  const excludedSkills = stack ? getExcludedSkills(stack) : new Set<string>()
  const excludedAgents = stack ? getExcludedAgents(stack) : new Set<string>()

  // `.github/` may not exist: a teammate clones a repo whose generated config was
  // never committed, and `update` used to die with ENOENT before writing anything.
  await mkdir(destRoot, { recursive: true })

  // Refresh only the managed block, leaving any surrounding user content alone.
  const copilotDest = resolve(destRoot, 'copilot-instructions.md')
  const rootMerge = await writeManagedBlock(
    copilotDest,
    await readFile(resolve(srcRoot, 'copilot-instructions.md'), 'utf8')
  )
  results.copied.push(copilotDest)
  if (rootMerge.action === 'adopted' || rootMerge.action === 'repaired') (results.adopted ??= []).push(copilotDest)
  if (rootMerge.staleGeneratedContent) (results.staleRoots ??= []).push(copilotDest)

  // Remove existing framework directories to clear stale files
  for (const dir of FRAMEWORK_DIRS) {
    await removeDirIfExists(resolve(destRoot, dir))
  }

  // Re-copy framework directories
  for (const dir of FRAMEWORK_DIRS) {
    const srcDir = resolve(srcRoot, dir)
    if (!existsSync(srcDir)) continue
    const destDir = resolve(destRoot, dir)

    let filter: ((_name: string, _srcPath: string) => boolean) | undefined
    let transform: CopyDirOptions['transform'] | undefined
    if (dir === 'skills') {
      filter = (name) => !excludedSkills.has(name)
    } else if (dir === 'agents') {
      filter = (name) => !excludedAgents.has(name)
      transform = stack ? getAgentTransform(stack) : undefined
    }

    const sub = await copyDir(srcDir, destDir, { overwrite: true, filter, transform })
    // All re-installed framework files count as "updated" (copied), not "created"
    results.copied.push(...sub.copied, ...sub.created)
    results.skipped.push(...sub.skipped)
  }

  // Plugin skills → .github/skills/<plugin-id>/ (overwrite)
  const pluginsRoot = getPluginsRoot(pkgRoot)
  const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
  const pluginSkills = await getPluginSkillEntries(pluginsRoot, includedPlugins)
  for (const { id, skillPath } of pluginSkills) {
    const pluginDestDir = resolve(destRoot, 'skills', id)
    await mkdir(pluginDestDir, { recursive: true })
    const destPath = resolve(pluginDestDir, 'SKILL.md')
    await copyFile(skillPath, destPath)
    results.copied.push(destPath)
  }

  // Customizations are NEVER overwritten during update.

  return results
}

export function getManagedPaths(): ManagedPaths {
  return {
    framework: FRAMEWORK_DIRS.map((d) => `.github/${d}/`),
    merged: ['.github/copilot-instructions.md'],
    customizable: [
      '.opencastle/',
      '.vscode/mcp.json',
    ],
  }
}

export function getDoctorChecks(): DoctorCheck[] {
  return [
    { label: 'Copilot instructions', path: '.github/copilot-instructions.md', type: 'file' },
    { label: 'Instruction files', path: '.github/instructions/', type: 'dir', countContents: true, countFilter: '.md' },
    { label: 'Agent definitions', path: '.github/agents/', type: 'dir', countContents: true, countFilter: '.agent.md' },
    { label: 'Skills directory', path: '.github/skills/', type: 'dir', countContents: true },
    { label: 'Agent workflows', path: '.github/agent-workflows/', type: 'dir', countContents: true },
    { label: 'Prompts directory', path: '.github/prompts/', type: 'dir', countContents: true },
  ]
}
