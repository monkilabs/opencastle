import { basename, resolve } from 'node:path'
import { mkdir, readFile, unlink, rename } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { writeManagedBlock, recordMerge } from '../managed-block.js'
import { mergeCopyResults, copyDir } from '../copy.js'
import { scaffoldMcpConfigInto } from '../mcp.js'
import { getAgentTransform } from '../stack-config.js'
import { withSource, type CompileSource } from '../layers.js'
import type { CopyResults, CopyDirOptions, DoctorCheck, ManagedPaths, RepoInfo, StackConfig } from '../types.js'
import { isOurVscodePrompt, legacyVscodePrompts, vscodePromptFile, withCommandName } from '../command-namespace.js'

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
 *   prompts/<name>.prompt.md   → .github/prompts/oc.<name>.prompt.md  (/oc:<name>)
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
  stack?: StackConfig,
): Pick<CopyDirOptions, 'filter' | 'transform' | 'rename'> {
  if (dir === 'agents') {
    return { transform: stack ? getAgentTransform(stack) : undefined }
  }
  if (dir === 'prompts') {
    // The `oc:` namespace. VS Code reads prompt files from the top of
    // `.github/prompts/` only, so it goes in the file name as `oc.` and in the
    // command name — the frontmatter `name`, which VS Code prefers — as `oc:`.
    const PROMPT = '.prompt.md'
    return {
      rename: (name) => (name.endsWith(PROMPT) ? vscodePromptFile(name) : name),
      transform: (content, srcPath) =>
        srcPath.endsWith(PROMPT)
          ? withCommandName(content, basename(srcPath).slice(0, -PROMPT.length))
          : content,
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
  repoInfo?: RepoInfo,
  source?: CompileSource,
): Promise<CopyResults> {
  return withSource(pkgRoot, stack, source, (src) => installFrom(src, projectRoot, stack, repoInfo))
}

async function installFrom(
  src: CompileSource,
  projectRoot: string,
  stack: StackConfig | undefined,
  repoInfo: RepoInfo | undefined,
): Promise<CopyResults> {
  const srcRoot = src.root
  const destRoot = resolve(projectRoot, '.github')

  await mkdir(destRoot, { recursive: true })

  const results: CopyResults = { copied: [], skipped: [], created: [] }

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

    const sub = await copyDir(srcDir, destDir, copyRulesFor(dir, stack))
    mergeCopyResults(results, sub)
  }

  // MCP server config → .vscode/mcp.json (scaffold once)
  await scaffoldMcpConfigInto(
    results,
    projectRoot,
    '.vscode/mcp.json',
    stack,
    repoInfo,
    'vscode',
    src.mcp,
  )

  return results
}

export async function update(
  pkgRoot: string,
  projectRoot: string,
  stack?: StackConfig,
  _repoInfo?: RepoInfo,
  source?: CompileSource,
): Promise<CopyResults> {
  return withSource(pkgRoot, stack, source, (src) => updateFrom(src, projectRoot, stack))
}

async function updateFrom(src: CompileSource, projectRoot: string, stack: StackConfig | undefined): Promise<CopyResults> {
  const srcRoot = src.root
  const destRoot = resolve(projectRoot, '.github')

  const results: CopyResults = { copied: [], skipped: [], created: [] }

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
    for (const rel of filesUnderDir(abs)) {
      const shown = `.github/${dir}/${rel}`
      // A prompt someone wrote beside ours is theirs to keep.
      if (!ownsFile(shown, projectRoot)) continue
      beforeSweep.set(resolve(abs, rel), shown)
    }
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

    const sub = await copyDir(srcDir, destDir, { overwrite: true, ...copyRulesFor(dir, stack) })
    mergeCopyResults(results, sub)
    for (const abs of sub.visited ?? []) visited.add(abs)
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

const PROMPTS_DIR = '.github/prompts/'

/**
 * `.github/prompts/` is shared: VS Code reads prompt files only at its top, so
 * OpenCastle's `oc.` files and a person's own sit side by side. Every other
 * framework directory is wholly generated.
 */
export function ownsFile(rel: string, projectRoot: string): boolean {
  const norm = rel.replace(/\\/g, '/')
  if (!norm.startsWith(PROMPTS_DIR)) return true
  const name = norm.slice(PROMPTS_DIR.length)
  // VS Code reads nothing deeper, and OpenCastle writes nothing deeper.
  if (name.includes('/')) return false
  return isOurVscodePrompt(name, resolve(projectRoot, norm), projectRoot)
}

/** The one framework directory this target shares with the user. */
export function getSharedDirs(): string[] {
  return [PROMPTS_DIR]
}

/** The un-namespaced prompts an earlier release wrote. `update`'s sweep removes them. */
export function getLegacyOutputs(projectRoot: string): string[] {
  return legacyVscodePrompts(projectRoot)
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
