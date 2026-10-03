import { resolve, join, basename, dirname } from 'node:path'
import { mkdir, writeFile, readdir, readFile, unlink, rename } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { withSource, type CompileSource } from '../layers.js'
import { copyDir, mergeCopyResults } from '../copy.js'
import { scaffoldMcpConfigInto } from '../mcp.js'
import type { CopyResults, DoctorCheck, IdeChoice, ManagedPaths, RepoInfo, StackConfig } from '../types.js'
import { splitFrontmatter, parseFrontmatterString } from './frontmatter.js'
import { writeManagedBlock, recordMerge } from '../managed-block.js'

/**
 * Shared implementation for IDEs that take a root rules file plus a directory of
 * per-rule files with frontmatter — currently Cursor and Windsurf.
 *
 *   copilot-instructions.md → <rootRulesFile>
 *   instructions/*.md       → <configDir>/rules/*<ruleExt>          (always applies)
 *   agents/*.agent.md       → <configDir>/rules/agents/*<ruleExt>
 *   skills/{star}/SKILL.md  → <skillsDir>/<name>/SKILL.md, as Agent Skills
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
  /**
   * Where the IDE reads Agent Skills, relative to the project root.
   *
   * Cursor and Windsurf both read `SKILL.md` folders natively now. Flattened
   * into rules, as every release before this one did, a skill lost its scripts
   * and assets, could not be invoked by name, and was matched on its
   * description as a rule instead of loaded as a skill.
   */
  skillsDir: string
  /** The project MCP config, when it is not `<configDir>/mcp.json`. */
  mcpConfigPath?: string
}

export interface RulesDirAdapter {
  IDE_ID: IdeChoice
  IDE_LABEL: string
  install(pkgRoot: string, projectRoot: string, stack?: StackConfig, repoInfo?: RepoInfo, source?: CompileSource): Promise<CopyResults>
  update(pkgRoot: string, projectRoot: string, stack?: StackConfig, repoInfo?: RepoInfo, source?: CompileSource): Promise<CopyResults>
  getManagedPaths(): ManagedPaths
  getDoctorChecks(): DoctorCheck[]
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

export function createRulesDirAdapter(config: RulesDirConfig): RulesDirAdapter {
  const { ideId, ideLabel, rootRulesFile, configDir, ruleExt, renderFrontmatter } = config
  const rulesPrefix = `${configDir}/rules`
  const mcpPath = config.mcpConfigPath ?? `${configDir}/mcp.json`

  const rootIntro = [
    '# Project Instructions',
    '',
    `All conventions, architecture, and project context live in \`${rulesPrefix}/\`. Read those files before making changes. ` +
      `Skills are in \`${config.skillsDir}/\` — load one when a task matches its description.`,
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
    ;(results.visited ??= []).push(destPath)
    const existed = existsSync(destPath)
    if (!overwrite && existed) {
      results.skipped.push(destPath)
      return
    }
    const content = await convertFile(srcPath, opts)
    // Rewriting a file with what it already contains is not an update. The
    // totals here become "Updated N framework files", and counting every file
    // visited made a sync that changed nothing look identical to one that
    // rewrote the tree.
    // Named and skipped, not fatal. This read only answers "is it already what we
    // would write?", but on a directory wearing a generated file's name it threw
    // `EISDIR` — which Node raises on the descriptor, so it carries no `.path` and
    // the catch-all in `bin/cli.mjs` had nothing to print. `sync` died mid-install
    // naming nothing, on cursor and windsurf, while the gate reading the same tree
    // named the path correctly. The twin of this guard was added to `emit` and to
    // `copyDir` two commits ago and not here.
    if (existed) {
      let onDisk: string | null = null
      try {
        onDisk = await readFile(destPath, 'utf8')
      } catch {
        ;(results.unreadable ??= []).push(`${destPath}\u0000unreadable`)
        results.skipped.push(destPath)
        return
      }
      if (onDisk === content) {
        results.skipped.push(destPath)
        return
      }
    }
    await writeFile(destPath, content)
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

  /** Skills as Agent Skills: each `<name>/` folder, every file in it, frontmatter kept. */
  async function copySkills(srcRoot: string, projectRoot: string, results: CopyResults, overwrite: boolean): Promise<void> {
    const skillsDir = resolve(srcRoot, 'skills')
    if (!existsSync(skillsDir)) return
    const dest = resolve(projectRoot, config.skillsDir)
    await mkdir(dest, { recursive: true })
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(resolve(skillsDir, entry.name, 'SKILL.md'))) continue
      mergeCopyResults(results, await copyDir(resolve(skillsDir, entry.name), resolve(dest, entry.name), { overwrite }))
    }
  }

  async function install(
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
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    // Merged, not skipped: a project that already has a rules file keeps it and
    // gains the generated pointer in a managed block below.
    const rootFile = resolve(projectRoot, rootRulesFile)
    {
      const merge = await writeManagedBlock(rootFile, rootIntro)
      recordMerge(results, rootFile, merge)
    }

    const rulesRoot = resolve(projectRoot, configDir, 'rules')
    await mkdir(rulesRoot, { recursive: true })

    await convertDir(srcRoot, 'instructions', rulesRoot, results, { alwaysApply: true })
    await convertDir(srcRoot, 'agents', resolve(rulesRoot, 'agents'), results, {
      descriptionPrefix: 'Agent: ',
      removeExt: '.agent.md',
    })
    await copySkills(srcRoot, projectRoot, results, false)
    await convertDir(srcRoot, 'agent-workflows', resolve(rulesRoot, 'agent-workflows'), results, {
      descriptionPrefix: 'Workflow: ',
      excludeFiles: new Set(['README.md']),
    })
    await convertDir(srcRoot, 'prompts', resolve(rulesRoot, 'prompts'), results, {
      descriptionPrefix: 'Prompt: ',
      removeExt: '.prompt.md',
    })

    await scaffoldMcpConfigInto(results, projectRoot, mcpPath, stack, repoInfo, ideId, src.mcp)

    return results
  }

  async function update(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig,
    _repoInfo?: RepoInfo,
    source?: CompileSource,
  ): Promise<CopyResults> {
    return withSource(pkgRoot, stack, source, (src) => updateFrom(src, projectRoot))
  }

  async function updateFrom(src: CompileSource, projectRoot: string): Promise<CopyResults> {
    const srcRoot = src.root
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    const rootPath = resolve(projectRoot, rootRulesFile)
    const rootMerge = await writeManagedBlock(rootPath, rootIntro)
    // `unchanged` is not an update; counting it inflated the total by one on
    // every sync, on the same counter the recompilation bug had already made
    // meaningless.
    // Absolute, as `install` reports it and as the sweep compares. Reporting
    // the relative name here put two spellings of one file into the same result
    // arrays, next to a sweep that decides what to delete by matching paths.
    recordMerge(results, rootPath, rootMerge)

    const rulesRoot = resolve(projectRoot, configDir, 'rules')

    // Note what is here, so the sweep below can name what it removes. A file
    // disappearing with no line of output is not a warning the user saw.
    const beforeSweep = new Map<string, string>()
    for (const [root, label] of [
      [rulesRoot, `${configDir}/rules`],
      [resolve(projectRoot, config.skillsDir), config.skillsDir],
    ]) {
      if (!existsSync(root)) continue
      for (const rel of filesUnderDir(root)) beforeSweep.set(resolve(root, rel), `${label}/${rel}`)
    }

    await convertDir(srcRoot, 'instructions', rulesRoot, results, {
      alwaysApply: true,
      overwrite: true,
    })
    await convertDir(srcRoot, 'agents', resolve(rulesRoot, 'agents'), results, {
      descriptionPrefix: 'Agent: ',
      removeExt: '.agent.md',
      overwrite: true,
    })
    await copySkills(srcRoot, projectRoot, results, true)
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

    // Now drop output with no source left. Emptying the directory first was the
    // old shape: it made every regenerated file look new, so the "Updated N"
    // line reported the whole tree on a sync that changed nothing, and any
    // failure in between left this target with no rules at all.
    //
    // The sweep is still the whole directory — `getManagedPaths` declares it
    // and the drift checker compares it, so anything else living here is
    // reported as a stray first and removed here. That is what makes
    // `sync --check` clearable.
    const visited = new Set(results.visited ?? [])
    const emptied = new Set<string>()
    for (const [abs, rel] of beforeSweep) {
      if (await reconcileCase(abs, visited)) continue
      await unlink(abs)
      ;(results.deleted ??= []).push(rel)
      emptied.add(dirname(abs))
    }
    // Folders this sweep emptied — a skill moved out of `rules/skills/`, or one
    // with no source left — go too; the roots themselves stay.
    const roots = [rulesRoot, resolve(projectRoot, config.skillsDir)]
    for (const start of [...emptied].sort((a, b) => b.length - a.length)) {
      for (let dir = start; !roots.includes(dir) && roots.some((r) => dir.startsWith(r)); dir = dirname(dir)) {
        try {
          if (readdirSync(dir).length > 0) break
          rmdirSync(dir)
        } catch {
          break
        }
      }
    }

    // Customizations are NEVER overwritten.

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
      framework: [`${rulesPrefix}/`, `${config.skillsDir}/`],
      customizable: ['.opencastle/', mcpPath],
    }
  }

  function getDoctorChecks(): DoctorCheck[] {
    return [
      { label: `${ideLabel} rules file`, path: rootRulesFile, type: 'file' },
      { label: 'Instruction rules', path: `${rulesPrefix}/`, type: 'dir', countContents: true, countFilter: ruleExt },
      { label: 'Agent rules', path: `${rulesPrefix}/agents/`, type: 'dir', countContents: true, countFilter: ruleExt },
      { label: 'Skills directory', path: `${config.skillsDir}/`, type: 'dir', countContents: true },
      { label: 'Workflow rules', path: `${rulesPrefix}/agent-workflows/`, type: 'dir', countContents: true },
      { label: 'Prompt rules', path: `${rulesPrefix}/prompts/`, type: 'dir', countContents: true },
    ]
  }

  return { IDE_ID: ideId, IDE_LABEL: ideLabel, install, update, getManagedPaths, getDoctorChecks }
}

/** Every file under a directory, relative to it. */
function filesUnderDir(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      else out.push(`${prefix}${entry.name}`)
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}
