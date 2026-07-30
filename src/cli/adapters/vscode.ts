import { resolve } from 'node:path'
import { mkdir, readFile, writeFile, copyFile, unlink, rename } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { writeManagedBlock, recordMerge } from '../managed-block.js'
import { mergeCopyResults, copyDir, getOrchestratorRoot, getPluginsRoot, getPluginSkillEntries } from '../copy.js'
import { scaffoldMcpConfigInto } from '../mcp.js'
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

/**
 * What to copy out of a framework source directory.
 *
 * Shared by `install` and `update`, which each had their own copy of this and
 * promptly disagreed: the workflow README was filtered on install and restored
 * on update, so a project drifted the moment it synced.
 */
function copyRulesFor(
  dir: string,
  excludedSkills: Set<string>,
  excludedAgents: Set<string>,
  stack?: StackConfig,
): { filter?: (_name: string, _srcPath: string) => boolean; transform?: CopyDirOptions['transform'] } {
  if (dir === 'skills') return { filter: (name) => !excludedSkills.has(name) }
  if (dir === 'agents') {
    return {
      filter: (name) => !excludedAgents.has(name),
      transform: stack ? getAgentTransform(stack) : undefined,
    }
  }
  if (dir === 'agent-workflows') {
    // The directory's own README documents the templates for contributors; it is
    // not one of them, and no other adapter installs it.
    return { filter: (name) => name !== 'README.md' }
  }
  return {}
}

/**
 * Is this on-disk path one the compile just wrote, under a different spelling?
 *
 * macOS and Windows match filenames case-insensitively, so writing
 * `architect.agent.md` into a directory already holding `Architect.agent.md`
 * updates that file — under its existing name. The sweep then compared the
 * spelling it asked for against the spelling on disk, found no match, and
 * deleted the file it had just written. Renaming to the canonical spelling
 * fixes both halves: the content is kept and `sync --check`, which looks for
 * the compiler's spelling, stops reporting a file that is right there.
 */
async function reconcileCase(onDisk: string, visited: Set<string>): Promise<boolean> {
  if (visited.has(onDisk)) return true
  const lower = onDisk.toLowerCase()
  for (const want of visited) {
    if (want === onDisk || want.toLowerCase() !== lower) continue
    // `resolve` is lexical and would call these two different files. Only the
    // filesystem knows: `realpath.native` returns the real on-disk spelling, so
    // two names for one file resolve to the same string and two genuinely
    // different files on a case-sensitive filesystem do not.
    if (!existsSync(want)) continue
    try {
      if (realpathSync.native(want) !== realpathSync.native(onDisk)) continue
    } catch {
      continue
    }
    await rename(onDisk, want)
    return true
  }
  return false
}

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
    recordMerge(results, copilotDest, merge)
  }

  // Framework directories
  for (const dir of FRAMEWORK_DIRS) {
    const srcDir = resolve(srcRoot, dir)
    if (!existsSync(srcDir)) continue
    const destDir = resolve(destRoot, dir)

    const { filter, transform } = copyRulesFor(dir, excludedSkills, excludedAgents, stack)

    const sub = await copyDir(srcDir, destDir, { filter, transform })
    mergeCopyResults(results, sub)
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
  await scaffoldMcpConfigInto(
    results,
    projectRoot,
    '.vscode/mcp.json',
    stack,
    repoInfo,
    'vscode'
  )

  return results
}

export async function update(
  pkgRoot: string,
  projectRoot: string,
  stack?: StackConfig,
  _repoInfo?: RepoInfo
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
  recordMerge(results, copilotDest, rootMerge)

  // Note what is here before the sweep, so the command can name anything it
  // removed that it did not generate. Only one adapter did this, so five of the
  // seven targets deleted hand-written files in silence.
  const beforeSweep = new Map<string, string>()
  for (const dir of FRAMEWORK_DIRS) {
    const abs = resolve(destRoot, dir)
    for (const rel of filesUnderDir(abs)) beforeSweep.set(resolve(abs, rel), `.github/${dir}/${rel}`)
  }

  // Recompile over the existing tree, then sweep — not the other way round.
  //
  // Emptying the framework directories first meant any later failure left this
  // target with nothing installed, and it made every file look rewritten
  // because every file had just been created: "Updated 80 framework files" on a
  // sync that changed nothing. Writing in place gives an honest count for free,
  // since `copyDir` now compares bytes before it writes.
  const visited = new Set<string>()
  for (const dir of FRAMEWORK_DIRS) {
    const srcDir = resolve(srcRoot, dir)
    if (!existsSync(srcDir)) continue
    const destDir = resolve(destRoot, dir)

    const { filter, transform } = copyRulesFor(dir, excludedSkills, excludedAgents, stack)

    const sub = await copyDir(srcDir, destDir, { overwrite: true, filter, transform })
    mergeCopyResults(results, sub)
    for (const abs of sub.visited ?? []) visited.add(abs)
  }

  // Plugin skills → .github/skills/<plugin-id>/ (overwrite)
  const pluginsRoot = getPluginsRoot(pkgRoot)
  const includedPlugins = stack ? getIncludedPluginIds(stack) : undefined
  const pluginSkills = await getPluginSkillEntries(pluginsRoot, includedPlugins)
  for (const { id, skillPath } of pluginSkills) {
    const pluginDestDir = resolve(destRoot, 'skills', id)
    await mkdir(pluginDestDir, { recursive: true })
    const destPath = resolve(pluginDestDir, 'SKILL.md')
    visited.add(destPath)
    const content = await readFile(skillPath, 'utf8')
    if (existsSync(destPath) && (await readFile(destPath, 'utf8')) === content) {
      results.skipped.push(destPath)
    } else {
      const existed = existsSync(destPath)
      await writeFile(destPath, content)
      results[existed ? 'copied' : 'created'].push(destPath)
    }
  }

  // Now drop output with no source left.
  for (const abs of beforeSweep.keys()) {
    if (await reconcileCase(abs, visited)) continue
    if (existsSync(abs)) await unlink(abs)
  }

  // Customizations are NEVER overwritten during update.

  for (const [abs, rel] of beforeSweep) {
    if (!existsSync(abs)) (results.deleted ??= []).push(rel)
  }

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

/** Every file under a directory, relative to it. */
function filesUnderDir(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(resolve(dir, entry.name), `${prefix}${entry.name}/`)
      else out.push(`${prefix}${entry.name}`)
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}
