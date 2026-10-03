import { resolve, basename, dirname, relative, sep } from 'node:path'
import { mkdir, writeFile, readdir, readFile, rm, rename } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { writeManagedBlock, recordMerge } from '../managed-block.js'
import { TIERS, TIER_IDS, isTier, tierForAgent, type Tier } from '../tiers.js'
import { mergeCopyResults, copyDir } from '../copy.js'
import { scaffoldMcpConfigInto } from '../mcp.js'
import { withSource, type CompileSource } from '../layers.js'
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
  /**
   * Where skills go, relative to the project root, when the assistant does not
   * read them from `<dotDir>/skills/`. Codex CLI reads a repository's skills
   * only from `.agents/skills/`, the cross-assistant location; the
   * `.codex/skills/` this wrote was never loaded.
   */
  skillsDir?: string
  /**
   * Output an earlier release wrote outside today's framework directories,
   * present on disk now, relative to the project root. Removed on update.
   */
  legacyOutputs?: (_projectRoot: string) => string[]
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
const SHARED_ROOT_OWNERS: Record<string, Array<{ ide: string; dotDir: string; skillsDir: string }>> = {
  'AGENTS.md': [
    { ide: 'opencode', dotDir: '.opencode', skillsDir: '.opencode/skills' },
    { ide: 'codex', dotDir: '.codex', skillsDir: '.agents/skills' },
  ],
}

/** Where an adapter writes skills, relative to the project root. */
function skillsDirOf(config: SingleFileAdapterConfig): string {
  return config.skillsDir ?? `${config.dotDir}/skills`
}

/**
 * The directories the shared root file should point at, given what is
 * selected, and the other places the same content is installed.
 */
function referenceDir(config: SingleFileAdapterConfig, stack?: StackConfig): {
  dir: string
  skills: string
  sharedWith: string[]
} {
  const owners = SHARED_ROOT_OWNERS[config.rootFile] ?? []
  const selected = new Set<string>(stack?.ides ?? [])
  const present = owners.filter((o) => selected.has(o.ide))
  if (present.length < 2) return { dir: config.dotDir, skills: skillsDirOf(config), sharedWith: [] }
  const [first, ...rest] = present
  const elsewhere = rest.flatMap((o) => (o.skillsDir.startsWith(`${o.dotDir}/`) ? [o.dotDir] : [o.dotDir, o.skillsDir]))
  return { dir: first.dotDir, skills: first.skillsDir, sharedWith: elsewhere }
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

export function createSingleFileAdapter(
  config: SingleFileAdapterConfig,
): IdeAdapter & { getLegacyOutputs(_projectRoot: string): string[] } {
  /**
   * Write one generated file and report what actually happened to it.
   *
   * `install` scaffolds and must never clobber; `update` recompiles and must,
   * or the compiler never delivers new content to an existing install. Those
   * two needs were served by one code path with `existsSync` hard-wired to
   * "skip", so after the write-before-sweep reordering `sync` stopped
   * refreshing anything: it printed "Updated 0 framework files" while
   * `sync --check` stayed red on the very files it had just declined to write,
   * and prescribed itself as the remedy. An upgrade got the new managed block
   * over the previous release's agent bodies.
   *
   * Even when overwriting, an identical file counts as skipped — the "Updated
   * N" line should say what changed, not how many files were visited.
   */
  async function emit(
    projectRoot: string,
    destPath: string,
    content: string,
    overwrite: boolean,
    results: CopyResults
  ): Promise<void> {
    ;(results.visited ??= []).push(destPath)
    if (existsSync(destPath)) {
      // Named and skipped, like a config that will not parse — and for the same
      // reason. This read is only an optimisation ("is it already what we would
      // write?"), but on a directory wearing a generated file's name it threw
      // `EISDIR`, which Node raises on the descriptor and therefore carries no
      // `.path`. The catch-all in `bin/cli.mjs` had nothing to print, so `sync`
      // died with `✗ EISDIR: illegal operation on a directory, read` in the
      // middle of a hundred-file install, naming nothing to act on, while the
      // gate reading the same tree named the path correctly.
      let existing: string
      try {
        existing = await readFile(destPath, 'utf8')
      } catch {
        ;(results.unreadable ??= []).push(
          `${relative(projectRoot, destPath)}\u0000unreadable`,
        )
        results.skipped.push(destPath)
        return
      }
      if (!overwrite || existing === content) {
        results.skipped.push(destPath)
        return
      }
      await writeFile(destPath, content)
      results.copied.push(destPath)
      return
    }
    await writeFile(destPath, content)
    results.created.push(destPath)
  }

  async function compile(
    pkgRoot: string,
    projectRoot: string,
    stack: StackConfig | undefined,
    repoInfo: RepoInfo | undefined,
    overwrite: boolean,
    source: CompileSource | undefined,
  ): Promise<CopyResults> {
    return withSource(pkgRoot, stack, source, (src) => compileFrom(src, projectRoot, stack, repoInfo, overwrite))
  }

  /**
   * One pass over the merged source. What the stack leaves out, what a team
   * excluded, and the integrations' skills are already settled in it, so this
   * compiles what it finds.
   */
  async function compileFrom(
    src: CompileSource,
    projectRoot: string,
    stack: StackConfig | undefined,
    repoInfo: RepoInfo | undefined,
    overwrite: boolean,
  ): Promise<CopyResults> {
    const srcRoot = src.root
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    // 1. Build root instructions file.
    // Always built: the content goes into a managed block, so a file the user
    // already owns keeps its content and gains the generated section.
    const rootPath = resolve(projectRoot, config.rootFile)
    const { dir: refDir, skills: refSkills, sharedWith } = referenceDir(config, stack)
    {
      const sections: string[] = []

      sections.push(
        '# Project Instructions\n\n' +
        'All conventions, architecture, and project context are embedded below. ' +
        `Skills are in \`${refSkills}/\` — read them when a task matches. ` +
        `Agent definitions are in \`${refDir}/agents/\` — read the relevant file when adopting a persona.` +
        (sharedWith.length > 0
          ? `\n\nThis file is shared by more than one assistant. The same content is also installed under ${sharedWith
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
          `${refSkills}/${name}/SKILL.md`
        // Integration skills are listed after the rest, as they always were:
        // reordering the index would change every root file on upgrade for
        // no reason anyone could see in the diff.
        const integrations = new Set(
          [...src.resolved.items.values()].filter((i) => i.plugin && i.layer === 'opencastle').map((i) => i.name),
        )
        // Code-point order, not the machine's locale: under a Danish or
        // Estonian locale `localeCompare` ordered names differently, and the
        // root file then differed between two teammates' checkouts.
        const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        const ordered = [
          ...subdirs.filter((e) => !integrations.has(e.name)).sort(byName),
          ...subdirs.filter((e) => integrations.has(e.name)).sort(byName),
        ]
        for (const entry of ordered) {
          const skillFile = resolve(skillsDir, entry.name, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          const meta = parseFrontmatterMeta(await readFile(skillFile, 'utf8'))
          const desc = meta['description'] ?? ''
          skillLines.push(
            `- **${entry.name}** (\`${skillRef(entry.name)}\`): ${desc}`
          )
        }

        sections.push(skillLines.join('\n'))
      }

      const merge = await writeManagedBlock(rootPath, sections.join('\n'))
      recordMerge(results, rootPath, merge)
    }

    const dotDirPath = resolve(projectRoot, config.dotDir)

    // 2. Agent definitions → dotDir/agents/
    const agentsDir = resolve(srcRoot, 'agents')
    if (existsSync(agentsDir)) {
      const destAgents = resolve(dotDirPath, 'agents')
      await mkdir(destAgents, { recursive: true })
      for (const file of await readdir(agentsDir)) {
        if (!file.endsWith('.md')) continue
        const destPath = resolve(destAgents, file)
        const content = await readFile(resolve(agentsDir, file), 'utf8')
        await emit(projectRoot, destPath, stripFrontmatter(content) + '\n', overwrite, results)
      }
    }

    // 3. Skills → <skillsDir>/<name>/SKILL.md (+ sibling resources, frontmatter preserved).
    //    Matches the SKILL.md-per-folder format used by Claude Code, OpenCode, Codex,
    //    and Antigravity — agents discover skills via the description: frontmatter field.
    const skillsDir = resolve(srcRoot, 'skills')
    if (existsSync(skillsDir)) {
      const destSkills = resolve(projectRoot, skillsDirOf(config))
      await mkdir(destSkills, { recursive: true })
      const subdirs = (
        await readdir(skillsDir, { withFileTypes: true })
      ).filter((e) => e.isDirectory())
      for (const entry of subdirs) {
        const skillFile = resolve(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        const sub = await copyDir(
          resolve(skillsDir, entry.name),
          resolve(destSkills, entry.name),
          { overwrite }
        )
        // All of them, and asked rather than listed. With `overwrite` false a
        // rewritten file was impossible, so dropping `copied` cost nothing; the
        // moment `update` started recompiling in place, every skill it actually
        // refreshed went unrecorded — and the sweep, which deletes whatever the
        // compile did not account for, removed all 43 of them. Naming four
        // instead of three only moved the deadline: `unreadable` was added later
        // and went missing here too, so `sync` skipped a file it could not read
        // and reported nothing.
        mergeCopyResults(results, sub)
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
        const content = await readFile(resolve(promptDir, file), 'utf8')
        await emit(projectRoot, destPath, stripFrontmatter(content) + '\n', overwrite, results)
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
        const content = await readFile(resolve(wfDir, file), 'utf8')
        await emit(projectRoot, destPath, stripFrontmatter(content) + '\n', overwrite, results)
      }
    }

    // 7. MCP server config (scaffold once)
    await scaffoldMcpConfigInto(
      results,
      projectRoot,
      config.mcpConfigPath,
      stack,
      repoInfo,
      config.mcpFormat,
      src.mcp,
    )

    return results
  }

  /** First install: scaffold, and never clobber a file that is already there. */
  async function install(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig,
    repoInfo?: RepoInfo,
    source?: CompileSource,
  ): Promise<CopyResults> {
    return compile(pkgRoot, projectRoot, stack, repoInfo, false, source)
  }

  async function update(
    pkgRoot: string,
    projectRoot: string,
    stack?: StackConfig,
    repoInfo?: RepoInfo,
    source?: CompileSource,
  ): Promise<CopyResults> {
    const results: CopyResults = { copied: [], skipped: [], created: [] }

    // 1. Leave the root file in place. install() rewrites only the managed
    // block inside it, so deleting it here would destroy whatever the user
    // wrote around that block.

    // 2. Note what is there now, so step 4 can say what it removed.
    const sweptDirs = frameworkRoots()
      .map((dir) => resolve(projectRoot, dir))
      .filter((dirPath) => existsSync(dirPath))
    const before = new Map<string, string>()
    for (const dirPath of sweptDirs) {
      for (const rel of filesUnderDir(dirPath)) {
        before.set(resolve(dirPath, rel), `${relative(projectRoot, dirPath).split(sep).join('/')}/${rel}`)
      }
    }

    // 3. Recompile *before* clearing anything, overwriting as we go.
    //
    // Sweeping first meant a failure writing the root file — an unwritable
    // CLAUDE.md is enough — left `.claude/` empty and the manifest unwritten:
    // the command that was asked to repair the install destroyed it. The other
    // two adapters already wrote the root file first.
    //
    // `overwrite` is what makes that reordering safe to keep. Without it the
    // sweep was carrying the refresh — files were replaced by being deleted and
    // written again — and reversing the order silently turned `sync` into a
    // no-op on content. The sweep's job now is only to remove output with no
    // source left, which is the one thing recompiling cannot do.
    const installResult = await compile(pkgRoot, projectRoot, stack, repoInfo, true, source)

    // 4. Now that the new output exists, drop anything stale beside it.
    //
    // Keyed on what the recompile *visited*, not on how it categorised each
    // write. Reassembling this from the report arrays failed twice — once
    // missing `skipped` (first sync deleted all 79 regenerated files), once
    // missing `copied` (an upgrade deleted 43 skills) — and both times the
    // deletion was silent and the categories looked right.
    const written = new Set<string>(installResult.visited ?? [])
    for (const dirPath of sweptDirs) {
      const emptied = new Set<string>()
      for (const rel of filesUnderDir(dirPath)) {
        const abs = resolve(dirPath, rel)
        if (await reconcileCase(abs, written)) continue
        ;(results.deleted ??= []).push(before.get(abs) ?? rel)
        await rm(abs, { force: true })
        emptied.add(dirname(abs))
      }
      // A skill whose last file went leaves its folder, and an assistant that
      // scans the directory sees a skill with no SKILL.md. Only folders this
      // sweep emptied: an empty directory standing where a generated file
      // belongs is a fault for a person, and every check names it as one.
      pruneEmptied(dirPath, emptied)
    }
    // What an earlier release put where this one no longer writes — the
    // un-namespaced commands at the top of `.claude/commands/`. Asked after the
    // recompile, so a failure there leaves the old commands working.
    for (const rel of getLegacyOutputs(projectRoot)) {
      await rm(resolve(projectRoot, rel), { force: true, recursive: rel.endsWith('/') })
      ;(results.deleted ??= []).push(rel)
    }
    // Pass the three categories through as they came back. Folding `created`
    // into `copied` was how "Updated N framework files" stayed plausible while
    // nothing was being rewritten — the count was of files visited, not changed.
    results.created.push(...installResult.created)
    results.copied.push(...installResult.copied)
    results.skipped.push(...installResult.skipped)
    // Adoption happens inside install(); without this the notice never reaches
    // the user on the one command they actually run to upgrade.
    // Every optional field the compile set, forwarded by iterating the object
    // rather than by naming them.
    //
    // The named list is how `repaired` reached three adapter families and
    // `damagedRoots` reached one: a field is added to `MergeResult`, wired at
    // the place it is produced, and this list is not updated — so the user is
    // told nothing on the targets that miss it, including about the backup that
    // is the only way back from a collapse. Both were reported as separate bugs
    // a round apart. They are one bug, and it is the list.
    const COMPUTED_HERE = new Set(['copied', 'skipped', 'created', 'visited', 'deleted'])
    for (const [key, value] of Object.entries(installResult)) {
      if (COMPUTED_HERE.has(key)) continue
      if (Array.isArray(value) && value.length > 0) {
        ;(results as unknown as Record<string, unknown>)[key] = value
      }
    }

    return results
  }

  function getLegacyOutputs(projectRoot: string): string[] {
    return config.legacyOutputs?.(projectRoot) ?? []
  }

  /**
   * Every directory this adapter generates whole, relative to the project
   * root and without a trailing slash: its framework directories under
   * `dotDir`, with skills wherever `skillsDir` puts them.
   */
  function frameworkRoots(): string[] {
    // Deduplicate dirs (e.g. promptsDir === workflowsDir for claude-code's 'commands')
    const dirs = new Set(['agents', 'skills', ...config.frameworkDirs])
    return Array.from(dirs).map((d) => (d === 'skills' ? skillsDirOf(config) : `${config.dotDir}/${d}`))
  }

  function getManagedPaths(): ManagedPaths {
    return {
      framework: frameworkRoots().map((d) => `${d}/`),
      merged: [config.rootFile],
      customizable: ['.opencastle/', config.mcpConfigPath],
    }
  }

  function getDoctorChecks(): DoctorCheck[] {
    const checks: DoctorCheck[] = [
      { label: 'Root instructions file', path: config.rootFile, type: 'file' },
      { label: 'Agent definitions', path: `${config.dotDir}/agents/`, type: 'dir', countContents: true, countFilter: '.md' },
      { label: 'Skills directory', path: `${skillsDirOf(config)}/`, type: 'dir', countContents: true },
    ]
    if (config.promptsDir === config.workflowsDir) {
      checks.push({ label: 'Commands directory', path: `${config.dotDir}/${config.promptsDir}/`, type: 'dir', countContents: true })
    } else {
      checks.push({ label: 'Prompts directory', path: `${config.dotDir}/${config.promptsDir}/`, type: 'dir', countContents: true })
      checks.push({ label: 'Workflows directory', path: `${config.dotDir}/${config.workflowsDir}/`, type: 'dir', countContents: true })
    }
    return checks
  }

  return { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs }
}

/** Remove each of `dirs` that is now empty, and its parents up to `root`, which stays. */
function pruneEmptied(root: string, dirs: Set<string>): void {
  for (const start of [...dirs].sort((a, b) => b.length - a.length)) {
    for (let dir = start; dir !== root && dir.startsWith(root); dir = dirname(dir)) {
      try {
        if (readdirSync(dir).length > 0) break
        rmdirSync(dir)
      } catch {
        break
      }
    }
  }
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
