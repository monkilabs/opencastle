import { isAbsolute, resolve, relative } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { multiselect, confirm, closePrompts, c } from './prompt.js'
import { readManifest, writeManifest, createManifest } from './manifest.js'
import { removeDirIfExists, copyDir, getOrchestratorRoot } from './copy.js'
import { updateGitignore } from './gitignore.js'
import { getRequiredMcpEnvVars, getCustomizationsTransform } from './stack-config.js'
import { getMcpConfigRelPath, stripManagedMcpServers } from './mcp.js'
import { getPluginsBySubCategory } from '../orchestrator/plugins/index.js'
import type { PluginConfig } from '../orchestrator/plugins/types.js'
import { detectRepoInfo, mergeStackIntoRepoInfo, formatRepoInfo, buildDetectedToolsSet, detectCurrentIde, detectAssistantConfigs } from './detect.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { IDE_LABELS } from './types.js'
import type { CliContext, CopyResults, IdeChoice, TechTool, TeamTool, StackConfig } from './types.js'
import { bootstrapCustomizations } from './bootstrap.js'
import { stripManagedBlock, stripManagedBlockFromFile } from './managed-block.js'
import { resolveManagedPaths, declaredManagedPaths } from './managed-paths.js'
import { noteUnreadable } from './unreadable-report.js'

const INIT_HELP = `
  opencastle init [options]

  Set up this project: detects your stack and any assistant config you already
  have, shows what it will do, and asks once.

  Options:
    --customize, --reconfigure  Choose IDEs and integrations manually
    --yes, -y                   Accept the detected setup without asking
    --dry-run                   Preview what would be changed without writing files
    --help, -h                  Show this help
`

/** Every plugin category, in the order the customize flow presents them. */
const CATEGORY_STEPS: Array<{ title: string; subCategories: string[]; target: 'tech' | 'team' }> = [
  { title: 'Frameworks', subCategories: ['framework'], target: 'tech' },
  { title: 'Databases', subCategories: ['database'], target: 'tech' },
  { title: 'CMS', subCategories: ['cms'], target: 'tech' },
  { title: 'Deployment', subCategories: ['deployment'], target: 'tech' },
  { title: 'Testing', subCategories: ['testing', 'e2e-testing'], target: 'tech' },
  { title: 'Build Tools', subCategories: ['codebase-tool'], target: 'tech' },
  { title: 'More Tools', subCategories: ['design', 'email', 'payments', 'observability', 'knowledge-management'], target: 'tech' },
  { title: 'Project Management', subCategories: ['task-management'], target: 'team' },
  { title: 'Notifications', subCategories: ['notifications'], target: 'team' },
]

export interface Selection {
  ides: IdeChoice[]
  techTools: string[]
  teamTools: string[]
}

/**
 * Choose IDEs and integrations from what is already in the project.
 *
 * Any assistant with config present is a target — that is the whole pitch: you
 * keep what you have and gain the rest. Falls back to the IDE the CLI is running
 * from, then to VS Code. Integrations come from repo detection plus each
 * plugin's own default.
 */
export function detectSelection(
  projectRoot: string,
  repoInfo: Awaited<ReturnType<typeof detectRepoInfo>>,
  /**
   * What this project already had, when re-running over an install.
   *
   * Detection cannot rediscover a pack the user chose deliberately — `add sentry`
   * leaves nothing in the repository for `buildDetectedToolsSet` to find. Without
   * this, a second `init --yes` silently dropped every such pack: the skill was
   * deleted, the manifest forgot it, and its MCP server was orphaned in the
   * config with nothing reporting any of it.
   */
  existing?: { ides?: string[]; techTools?: string[]; teamTools?: string[] },
): Selection {
  const assistants = detectAssistantConfigs(projectRoot)
  let ides = [...(existing?.ides ?? []), ...assistants.map((a) => a.ide)]

  if (ides.length === 0) {
    const current = detectCurrentIde()
    ides = [current ?? 'vscode']
  }

  const detected = buildDetectedToolsSet(repoInfo)
  const kept = new Set([...(existing?.techTools ?? []), ...(existing?.teamTools ?? [])])
  const techTools: string[] = []
  const teamTools: string[] = []

  for (const step of CATEGORY_STEPS) {
    const plugins = step.subCategories.flatMap((sc) =>
      getPluginsBySubCategory(sc as PluginConfig['subCategory']),
    )
    for (const p of plugins) {
      if (!p.preselected && !detected.has(p.id) && !kept.has(p.id)) continue
      if (p.category === 'team') teamTools.push(p.id)
      else techTools.push(p.id)
    }
  }

  return {
    ides: [...new Set(ides)] as Selection['ides'],
    techTools: [...new Set(techTools)],
    teamTools: [...new Set(teamTools)],
  }
}

/** The original category-by-category interrogation, behind --customize. */
async function promptSelection(
  repoInfo: Awaited<ReturnType<typeof detectRepoInfo>>,
  existingTools: Set<string>,
  currentIdes: Set<string> = new Set(),
): Promise<Selection> {
  const detectedIde = detectCurrentIde()
  // A multiselect, because this is the only screen that can add a second target
  // and the tool advertises it as such: init prints "Also used by your team?
  // opencastle init --customize", and status makes that the suggested next
  // command whenever it sees an unmanaged assistant. With a single-choice
  // picker, running it replaced the existing target instead of adding to it, the
  // old target's files were orphaned, and status went on suggesting the same
  // command — a loop that never converged.
  const selectedIdes = await multiselect(
    'Which assistants should this compile for?',
    (Object.keys(IDE_ADAPTERS) as IdeChoice[]).map((ide) => ({
      label: IDE_LABELS[ide],
      value: ide,
      ...((currentIdes.has(ide) || (currentIdes.size === 0 && detectedIde === ide)) && {
        selected: true,
      }),
    })),
  )
  if (selectedIdes.length === 0) {
    console.log(`\n  ${c.red('✗')} Pick at least one assistant.\n`)
    closePrompts()
    process.exit(1)
  }

  const detectedTools = buildDetectedToolsSet(repoInfo)
  const techTools: string[] = []
  const teamTools: string[] = []

  console.log(`  ${c.bold('── Stack ─────────────────────────────────────')}`)
  for (const step of CATEGORY_STEPS) {
    const plugins = step.subCategories.flatMap((sc) =>
      getPluginsBySubCategory(sc as PluginConfig['subCategory']),
    )
    if (plugins.length === 0) continue
    if (step.title === 'Project Management') {
      console.log(`  ${c.bold('── Team ──────────────────────────────────────')}`)
    }
    const selected = await multiselect(
      step.title,
      plugins.map((p) => ({
        label: p.label,
        hint: p.hint,
        value: p.id,
        ...((p.preselected || detectedTools.has(p.id) || existingTools.has(p.id)) && { selected: true }),
      })),
    )
    for (const id of selected) {
      const plugin = plugins.find((p) => p.id === id)
      if (plugin?.category === 'team') teamTools.push(id)
      else techTools.push(id)
    }
  }

  return { ides: selectedIdes as IdeChoice[], techTools, teamTools }
}

export default async function init({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(INIT_HELP)
    return
  }

  const projectRoot = process.cwd()
  const dryRun = args.includes('--dry-run') || args.includes('--dryRun')
  const customize = args.includes('--customize') || args.includes('--reconfigure')
  const assumeYes = args.includes('--yes') || args.includes('-y')

  // Check for existing installation
  const existing = await readManifest(projectRoot)
  let isReinit = false
  if (existing) {
    if (!assumeYes) {
      const proceed = await confirm(
        `OpenCastle already installed (v${existing.version}). Re-initialize?`,
        false
      )
      if (!proceed) {
        console.log('  Aborted.')
        return
      }
    }
    isReinit = true
  }

  const pkg = JSON.parse(
    await readFile(resolve(pkgRoot, 'package.json'), 'utf8')
  ) as { version: string }

  console.log(`\n  🏰 ${c.bold('OpenCastle')} ${c.dim(`v${pkg.version}`)}`)
  console.log(`  ${c.dim('Compiles your AI assistant config for every assistant you use')}\n`)

  // ── Detect ──────────────────────────────────────────────────────
  console.log(`  ${c.dim('Scanning repository…')}`)
  const repoInfo = await detectRepoInfo(projectRoot)
  const assistants = detectAssistantConfigs(projectRoot)

  const existingTools = new Set<string>()
  if (isReinit && existing?.stack) {
    for (const t of existing.stack.techTools ?? []) existingTools.add(t)
    for (const t of existing.stack.teamTools ?? []) existingTools.add(t)
  }

  // Detection over interrogation: propose a complete setup and ask once. The
  // full category-by-category selection is still available via --customize.
  let selection: Selection
  if (customize) {
    const summary = formatRepoInfo(repoInfo)
    if (summary) console.log(`  ${c.green('Detected:')}\n` + summary + '\n')
    console.log(`  ${c.bold('── IDEs ──────────────────────────────────────')}`)
    selection = await promptSelection(
      repoInfo,
      existingTools,
      new Set(existing?.ides ?? (existing?.ide ? [existing.ide] : [])),
    )
  } else {
    selection = detectSelection(projectRoot, repoInfo, existing?.stack ?? {
      ides: existing?.ides ?? (existing?.ide ? [existing.ide] : []),
    })

    console.log('')
    if (assistants.length > 0) {
      console.log(`  ${c.green('Found assistant config:')}`)
      for (const a of assistants) {
        console.log(`    ${c.dim('•')} ${a.label} ${c.dim(`(${a.paths.join(', ')})`)}`)
      }
      console.log('')
    }

    console.log(`  ${c.bold('Will compile for:')}`)
    for (const ide of selection.ides) {
      const known = assistants.some((a) => a.ide === ide)
      console.log(`    ${c.green('→')} ${IDE_LABELS[ide]}${known ? '' : c.dim(' (new)')}`)
    }

    if (selection.techTools.length > 0 || selection.teamTools.length > 0) {
      console.log(`\n  ${c.bold('Integrations detected:')}`)
      const all = [...selection.techTools, ...selection.teamTools]
      console.log(`    ${c.green(all.join(', '))}`)
    } else {
      console.log(`\n  ${c.dim('No stack integrations detected.')}`)
    }

    console.log('')
    if (!assumeYes && !dryRun) {
      const ok = await confirm('Set this up?', true)
      if (!ok) {
        console.log(`\n  Aborted. Run ${c.cyan('opencastle init --customize')} to choose manually.\n`)
        closePrompts()
        return
      }
    }
  }

  const ides = selection.ides

  // Sampled before anything is written: which co-owned MCP configs already
  // existed. Recorded in the manifest below so the uninstall knows which files
  // are ours to delete and which are the user's to leave alone.
  const mcpConfigsBefore = new Map<string, boolean>(
    ides.map((ide) => {
      const rel = getMcpConfigRelPath(ide as IdeChoice)
      return [rel, existsSync(resolve(projectRoot, rel))]
    }),
  )
  const techTools = selection.techTools
  const teamTools = selection.teamTools

  const stack: StackConfig = {
    ides: ides as IdeChoice[],
    techTools: techTools as TechTool[],
    teamTools: teamTools as TeamTool[],
  }

  // ── Merge user choices into detected info ────────────────────
  const combinedRepoInfo = mergeStackIntoRepoInfo(repoInfo, stack)

  const ideNames = ides.map((id) => IDE_LABELS[id as IdeChoice]).join(', ')
  if (customize) {
    // The default flow already printed this summary before confirming.
    console.log(`\n  Installing for ${c.cyan(ideNames)}...`)
    if (techTools.length > 0) console.log(`  Tech: ${c.green(techTools.join(', '))}`)
    if (teamTools.length > 0) console.log(`  Team: ${c.green(teamTools.join(', '))}`)
    console.log()
  }

  // ── Dry run ─────────────────────────────────────────────────────
  if (dryRun) {
    for (const ide of ides) {
      const adapter = await IDE_ADAPTERS[ide]()
      const managed = adapter.getManagedPaths()
      console.log(`  ${c.dim(`[dry-run] ${IDE_LABELS[ide as IdeChoice]} files:`)}\n`)
      for (const p of managed.framework) {
        console.log(`    ${c.green('+')} ${p}`)
      }
      for (const p of managed.customizable) {
        console.log(`    ${c.green('+')} ${p}`)
      }
    }
    console.log(`    ${c.green('+')} .opencastle/manifest.json`)
    console.log(`    ${c.green('+')} .gitignore (OpenCastle entries)`)
    console.log(`\n  ${c.dim('No files were written.')}\n`)
    closePrompts()
    return
  }

  // ── Clean up previous installation on re-init ────────────────
  if (isReinit && existing) {
    // Which previously-installed targets are being dropped — by membership, not
    // by comparing first elements. Adding Cursor to a Claude Code install asked
    // "Remove Claude Code files?" while Claude Code was still selected, which
    // reads as an offer to destroy the thing you just kept.
    const previousIdes: string[] =
      existing.stack?.ides ?? existing.ides ?? (existing.ide ? [existing.ide] : [])
    const dropped = previousIdes.filter((id) => !(ides as string[]).includes(id))
    let removeOldFiles = true
    if (dropped.length > 0) {
      const labels = dropped.map((id) => IDE_LABELS[id as IdeChoice] ?? id).join(', ')
      removeOldFiles = await confirm(`Remove ${labels} files from previous installation?`, false)
    }
    if (removeOldFiles && dropped.length > 0) {
      // Only the targets being dropped. This used to clear *every* previously
      // installed path — `removeOldFiles` starts true and is only ever
      // questioned when something is dropped — so re-running `init` over a
      // healthy install emptied the tree before writing a byte, and a failure
      // in between (an unwritable CLAUDE.md is enough) left four empty
      // directories and a manifest still claiming an install. The targets that
      // survive are recompiled in place by the adapters below, which write
      // before they sweep.
      // `previous` is resolved against the manifest, so a path an old release
      // recorded is still cleaned up. `keeping` is resolved against what the
      // surviving adapters *declare today* — deliberately not from the manifest.
      //
      // Both sides used `resolveManagedPaths`, which unions the manifest's
      // stored paths into its result; since `init` writes the union of every
      // installed target there, the dropped target's directories appeared in
      // `keeping` too and `kept.has(p)` was true for every path. Both loops
      // were no-ops, so dropping a target left its entire tree and its managed
      // block on disk while the manifest said it was gone.
      const previous = await resolveManagedPaths({ ...existing, ide: dropped[0], ides: dropped })
      const keeping = await declaredManagedPaths(ides as string[])
      const kept = new Set([...keeping.framework, ...(keeping.merged ?? [])])
      for (const p of previous.framework) {
        if (kept.has(p)) continue
        const fullPath = resolve(projectRoot, p)
        if (p.endsWith('/')) {
          await removeDirIfExists(fullPath)
        } else if (existsSync(fullPath)) {
          await unlink(fullPath)
        }
      }
      // The dropped target's MCP config is co-owned in the same way: take back
      // our servers, leave anything of theirs. It used to be left untouched
      // *and* dropped from the manifest, so no later command would ever clean
      // it — the one path by which uninstalling could not reach its own output.
      for (const id of dropped) {
        if ((ides as string[]).includes(id)) continue
        await stripManagedMcpServers(projectRoot, id as IdeChoice)
      }

      // Co-owned files are not ours to delete — take back only the block, and
      // only where no surviving target still owns it (opencode and codex share
      // AGENTS.md, so dropping one must not strip the other's block).
      for (const p of previous.merged) {
        if (kept.has(p)) continue
        await stripManagedBlockFromFile(resolve(projectRoot, p))
      }
    }
  }

  // ── Run adapters for each selected IDE ──────────────────────────
  let totalCreated = 0
  let totalSkipped = 0
  const skippedPaths: string[] = []
  const allManagedPaths = { framework: [] as string[], customizable: [] as string[], merged: [] as string[] }
  const adoptedRoots: string[] = []
  const repairedRoots: string[] = []
  const damagedRoots: string[] = []
  const severedRoots: string[] = []
  const staleRoots: string[] = []
  const tornRoots: string[] = []
  // Generated config that exists but will not parse — a hand-written
  // `.vscode/mcp.json` with a `//` comment is legal JSONC to VS Code and does
  // this. Named at the end instead of aborting: the abort left the framework
  // tree written with no manifest beside it, and never said which file.
  const unreadable: string[] = []
  const failedTargets: Array<{ ide: string; message: string }> = []

  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    // Re-running over an existing install recompiles; a first install scaffolds.
    //
    // `install` is scaffold-once by contract, so re-init left every generated
    // file exactly as it found it — and then stamped the manifest with the
    // current version. The record said 0.36 while the tree was still 0.30. It
    // was recoverable, because `sync --check` compares content and not version
    // numbers, but a command that writes a version it did not compile is
    // asserting something it has not done.
    // One target failing must not abort the others, and must not abort the
    // manifest. The loop had no guard, and the manifest is written after it, so
    // a second target throwing — an unwritable `.github/copilot-instructions.md`
    // is enough — left the first target's 78 files on disk with no manifest at
    // all: the front door said "not set up", `sync` said to run `init`, `init`
    // failed the same way, and `remove --all` refused to uninstall what it had
    // just installed. Single-target installs write the root file first and so
    // throw before anything lands, which is why this only showed up with two.
    let results: CopyResults
    try {
      results = isReinit
        ? await adapter.update(pkgRoot, projectRoot, stack, combinedRepoInfo)
        : await adapter.install(pkgRoot, projectRoot, stack, combinedRepoInfo)
    } catch (err) {
      failedTargets.push({ ide, message: (err as Error).message })
      continue
    }
    totalCreated += results.created.length
    totalSkipped += results.skipped.length
    skippedPaths.push(...results.skipped)
    for (const file of results.unreadable ?? []) {
      noteUnreadable(unreadable, file)
    }

    adoptedRoots.push(...(results.adopted ?? []))
    repairedRoots.push(...(results.repaired ?? []))
    damagedRoots.push(...(results.damagedRoots ?? []))
    severedRoots.push(...(results.severedRoots ?? []))
    staleRoots.push(...(results.staleRoots ?? []))
    tornRoots.push(...(results.tornRoots ?? []))

    const managed = adapter.getManagedPaths()
    allManagedPaths.framework.push(...managed.framework)
    allManagedPaths.customizable.push(...managed.customizable)
    // Deduplicated: opencode and codex share AGENTS.md, so a per-adapter push
    // listed it twice — "Merged into your existing …, AGENTS.md, AGENTS.md".
    for (const m of managed.merged ?? []) {
      if (!allManagedPaths.merged.includes(m)) allManagedPaths.merged.push(m)
    }
  }

  // If all files were skipped (orphaned install — no manifest but files exist)
  if (totalCreated === 0 && totalSkipped > 0 && !isReinit) {
    console.log(`  ${c.yellow('⚠')}  Found ${totalSkipped} existing files from a previous installation.`)
    // `--yes` is documented as "accept the detected setup without asking", and
    // this was the one question it did not cover. On a TTY it still asked.
    // `refuse`, because the default here overwrites. A piped run that ran out of
    // answers before this question took the destructive branch in silence.
    const overwrite =
      assumeYes || (await confirm('Overwrite existing files?', true, 'refuse'))
    if (overwrite) {
      // Recompile in place rather than emptying the tree first.
      //
      // Deleting every framework path and re-installing was the old shape, and
      // it made `init` the one command that could destroy an install by
      // failing: an unwritable CLAUDE.md, met after 62 files had already been
      // unlinked, left the directories empty and the manifest claiming an
      // install. `update` writes the new output before sweeping what has no
      // source left, which is the same guarantee `sync` gives.
      totalCreated = 0
      totalSkipped = 0
      for (const ide of ides) {
        const adapter = await IDE_ADAPTERS[ide]()
        // Guarded like the main loop above, and for the same reason: this one
        // was not, so a re-entry over an orphaned install that failed on the
        // second target left 91 files on disk with no manifest and every
        // command dead-ended — the front door saying "not set up", `sync`
        // saying run `init`, `init` failing identically, `remove` refusing.
        let results: CopyResults
        try {
          results = await adapter.update(pkgRoot, projectRoot, stack, combinedRepoInfo)
        } catch (err) {
          failedTargets.push({ ide, message: (err as Error).message })
          continue
        }
        // `copied` too. Counting only `created` and `skipped` made this path
        // report "Created 0 files / Left 29 existing files untouched" over a
        // run that had just rewritten 78 of them — the summary asserting the
        // opposite of what happened, on the one path that exists to overwrite.
        totalCreated += results.created.length + results.copied.length
        totalSkipped += results.skipped.length
        for (const file of results.unreadable ?? []) {
          noteUnreadable(unreadable, file)
        }
      }
    }
  }

  // ── Scaffold customizations to .opencastle/ ──────────────────────────────
  const custSrcDir = resolve(getOrchestratorRoot(pkgRoot), 'customizations')
  if (existsSync(custSrcDir)) {
    const custDestDir = resolve(projectRoot, '.opencastle')
    const custTransform = getCustomizationsTransform(stack)
    const sub = await copyDir(custSrcDir, custDestDir, { transform: custTransform })
    totalCreated += sub.created.length
    totalSkipped += sub.skipped.length
  }

  // ── Project scan ────────────────────────────────────────────────
  // Bootstrap only on a first install. Its rename steps write over the target
  // unconditionally, so on a re-run they replaced the user's own
  // `stack/<provider>-config.md` with a blank template — the same hazard removed
  // from `sync` in an earlier round and left standing here, and newly reachable
  // without a prompt because `--yes` is new on this branch.
  console.log(`\n  ${c.dim('Configuring project...')}`)
  // Keyed off the directory, not the manifest. `isReinit` alone missed two
  // routes onto the destructive path — `remove --keep-files` (which drops only
  // the manifest, by design) and a manifest with merge-conflict markers, which
  // `readManifest` reports as "no install". Both then ran bootstrap's
  // unconditional renames over a populated `.opencastle/` and replaced the
  // user's own stack notes with a blank template.
  const alreadyScaffolded = existsSync(resolve(projectRoot, '.opencastle', 'agents'))
  const bootstrapResult = isReinit || alreadyScaffolded
    ? { populated: [], removed: [], renamed: [] }
    : await bootstrapCustomizations(projectRoot, combinedRepoInfo, stack)

  if (bootstrapResult.populated.length > 0) {
    console.log(`  ${c.green('✓')} Populated ${c.bold(String(bootstrapResult.populated.length))} config files`)
  }
  if (bootstrapResult.renamed.length > 0) {
    for (const r of bootstrapResult.renamed) {
      console.log(`  ${c.dim('→')} Renamed ${r}`)
    }
  }
  if (bootstrapResult.removed.length > 0) {
    console.log(`  ${c.dim('→')} Removed ${bootstrapResult.removed.length} unused template(s)`)
  }

  // ── Write manifest ──────────────────────────────────────────────
  const manifest = createManifest(pkg.version, ides[0], ides)
  manifest.managedPaths = allManagedPaths
  // Which co-owned configs this install brought into existence. The uninstall
  // cannot work it out later: a file holding only our servers looks the same
  // whether we wrote it or the user's copy was empty when we arrived, and
  // guessing deleted two committed files. `scaffoldMcpConfig` reports 'created'
  // for a merge into an existing file as well, so the answer has to come from
  // whether the path existed before the adapters ran.
  //
  // Merged with what a previous install recorded, never replaced. `init` over an
  // existing project finds the config already there and so records nothing — which
  // overwrote the true `[".mcp.json"]` with `[]` on the second run, and the
  // uninstall then left our own stub behind because it no longer knew the file was
  // ours. Found by the command matrix running `init` twice, not by a review round.
  //
  // Whether we created a file is a fact about the past. A later run cannot unlearn
  // it, and the only safe direction for the uninstall is to keep knowing.
  const createdNow = [...mcpConfigsBefore]
    .filter(([, existed]) => !existed)
    .map(([rel]) => rel)
    .filter((rel) => existsSync(resolve(projectRoot, rel)))
  manifest.createdConfigs = [...new Set([...(existing?.createdConfigs ?? []), ...createdNow])]
  // `installedAt` likewise: re-running `init` is a reconfigure, not a first
  // install, and resetting it threw away when the project actually adopted the tool.
  if (existing?.installedAt) manifest.installedAt = existing.installedAt
  manifest.stack = stack
  manifest.repoInfo = combinedRepoInfo
  await writeManifest(projectRoot, manifest)

  // ── Update .gitignore ───────────────────────────────────────────
  // Only local artefacts and .env; the generated config is meant to be committed.
  const envVars = getRequiredMcpEnvVars(stack, combinedRepoInfo)
  const gitignoreResult = await updateGitignore(projectRoot)

  // ── Summary ─────────────────────────────────────────────────────
  console.log(`  ${c.green('✓')} Created ${c.bold(String(totalCreated))} files`)
  for (const { ide, message } of failedTargets) {
    console.log(`  ${c.red('✗')} ${IDE_LABELS[ide as IdeChoice] ?? ide} could not be installed:`)
    console.log(`     ${c.dim(message)}`)
    console.log(`     ${c.dim('Fix that, then run opencastle sync.')}`)
  }
  for (const file of unreadable) {
    const [abs, why] = file.split('\u0000')
    // Reported project-relative, whichever layer recorded it. `copyDir` works in
    // absolute paths and the MCP scaffolder in relative ones, so the same report
    // mixed `/private/tmp/…/.github/prompts/x.md` with `.mcp.json`.
    const name = isAbsolute(abs) ? relative(projectRoot, abs) : abs
    console.log(
      `  ${c.yellow('!')} Left ${name} alone — ` +
        (why === 'unreadable' ? 'it could not be read.' : 'it is not valid JSON.'),
    )
    // `--force` is not decoration. A plain `sync` short-circuits when nothing
    // has drifted, and the MCP config is a customizable path the drift checker
    // does not compare — so the servers were never added, and every command
    // reported the project healthy.
    //
    // The follow-up names what was actually skipped. This said "to add the MCP
    // servers" for every entry, and the list now also carries generated rule and
    // skill files, so a skipped `.cursor/rules/x.mdc` was explained in terms of a
    // feature that has nothing to do with it.
    const isMcp = /(^|[/\\])(\.mcp\.json|mcp\.json|opencode\.json)$/.test(name)
    console.log(
      `     ${c.dim(
        isMcp
          ? 'Fix the file, then run opencastle sync --force to add the MCP servers.'
          : 'Fix the file, then run opencastle sync --force to generate it.',
      )}`,
    )
  }
  if (gitignoreResult === 'created') {
    console.log(`  ${c.green('✓')} Created .gitignore with OpenCastle entries`)
  } else if (gitignoreResult === 'updated' || gitignoreResult === 'repaired') {
    console.log(`  ${c.green('✓')} Updated .gitignore with OpenCastle entries`)
  }
  if (gitignoreResult === 'repaired') {
      console.log(
        `  ${c.yellow('!')} Rewrote .gitignore's OpenCastle block and removed lines that were ` +
          `inside it; .gitignore.opencastle-backup holds what was there before.`,
      )
  }
  if (totalSkipped > 0) {
    const noun = totalSkipped === 1 ? 'file' : 'files'
    console.log(`  ${c.dim('→')} Left ${totalSkipped} existing ${noun} untouched`)
  }

  // Name the root files that already existed and were merged rather than replaced.
  const mergedRoots: string[] = []
  for (const p of allManagedPaths.merged) {
    const abs = resolve(projectRoot, p)
    if (!existsSync(abs)) continue
    try {
      const text = await readFile(abs, 'utf8')
      if (stripManagedBlock(text).trim().length > 0) mergedRoots.push(p)
    } catch { /* not readable — nothing to claim */ }
  }
  // `sync` says both of these loudly; `init` said neither, so the one command
  // most likely to meet a pre-0.36 file was the one that replaced it in silence.
  if (severedRoots.length > 0) {
    console.log(
      `\n  ${c.yellow('⚠')}  Nothing was written to ${new Set(severedRoots).size} file(s):\n`,
    )
    for (const p of [...new Set(severedRoots)]) {
      console.log(`     ${c.dim(relative(projectRoot, p))}`)
    }
    console.log(
      `     ${c.dim('An OpenCastle marker is there with no matching one, so the generated')}`,
    )
    console.log(
      `     ${c.dim('text beside it has nothing delimiting it. Restore the missing marker,')}`,
    )
    console.log(`     ${c.dim('or delete that text, and run sync again.')}`)
  }

  if (damagedRoots.length > 0) {
    // Two blocks and unpaired markers in one file. Reducing it means cutting,
    // and cutting here can sweep the user's own text into a block; so the tool
    // says what it sees and stops. `doctor` fails on this too.
    console.log(
      `\n  ${c.yellow('⚠')}  ${new Set(damagedRoots).size} file(s) hold more than one OpenCastle block and cannot be reduced safely:\n`,
    )
    for (const p of [...new Set(damagedRoots)]) {
      console.log(`     ${c.dim(relative(projectRoot, p))}`)
    }
    console.log(`     ${c.dim('Keep one start/end pair and delete the rest.')}`)
  }

  if (repairedRoots.length > 0) {
    // Not an adoption: nothing here came from an earlier release. The file held
    // two complete blocks — a merge that kept both sides, most often — and the
    // duplicate was removed so the assistant does not read two sets of rules.
    console.log(
      `\n  ${c.yellow('!')} Collapsed a duplicated block in ${repairedRoots.length} file(s); a .opencastle-backup is beside each:\n`,
    )
    for (const p of [...new Set(repairedRoots)]) {
      console.log(`     ${c.dim(relative(projectRoot, p))}`)
    }
  }

  if (adoptedRoots.length > 0) {
    console.log(`\n  ${c.yellow('⚠')}  Replaced ${adoptedRoots.length} file(s) generated by an earlier version:\n`)
    for (const p of new Set(adoptedRoots)) {
      const rel = relative(projectRoot, p)
      console.log(`     ${c.bold(rel)}`)
      console.log(`     ${c.dim('└')} ${c.dim(`previous contents kept as ${rel}.opencastle-backup`)}\n`)
    }
  }
  if (tornRoots.length > 0) {
    console.log(
      `\n  ${c.yellow('⚠')}  ${new Set(tornRoots).size} file(s) carry an OpenCastle marker that opens no block:\n`,
    )
    for (const p of new Set(tornRoots)) {
      console.log(`     ${c.bold(relative(projectRoot, p))}`)
      console.log(
        `     ${c.dim('└')} ${c.dim('text beside it may be stale generated output; only you can tell. Run')} ${c.cyan('opencastle doctor')}\n`,
      )
    }
  }
  if (staleRoots.length > 0) {
    console.log(`\n  ${c.yellow('⚠')}  ${new Set(staleRoots).size} file(s) still contain output from an earlier version:\n`)
    for (const p of new Set(staleRoots)) {
      console.log(`     ${c.bold(relative(projectRoot, p))}`)
      console.log(`     ${c.dim('└')} ${c.dim('your own writing comes first, so it was not replaced.')}\n`)
    }
  }

  if (mergedRoots.length > 0) {
    console.log(`  ${c.green('✓')} Merged into your existing ${mergedRoots.join(', ')}`)
    console.log(`    ${c.dim('your content is above the managed block and is never overwritten')}`)
  }

  // ── Env var notice + .env file generation ────────────────────
  if (envVars.length > 0) {
    console.log(`\n  ${c.yellow('⚠')}  Required environment variables for MCP servers:\n`)
    for (const { envVar, hint } of envVars) {
      console.log(`     ${c.bold(envVar)}`)
      console.log(`     ${c.dim('└')} ${c.dim(hint)}\n`)
    }

    // Offer to create .env if it doesn't exist
    const envPath = resolve(projectRoot, '.env')
    if (!dryRun && !existsSync(envPath)) {
      // `--yes` means every question, not most of them. This one blocked a TTY
      // run and any CI runner that keeps stdin open.
      const createEnv =
        assumeYes || (await confirm('Create a .env file with placeholders for these variables?', true))
      if (createEnv) {
        const { writeFile: writeEnvFile } = await import('node:fs/promises')
        const lines = envVars.map(({ envVar, hint }) => `# ${hint}\n${envVar}=\n`)
        await writeEnvFile(envPath, lines.join('\n') + '\n')
        console.log(`  ${c.green('✓')} Created .env with ${envVars.length} placeholder(s)`)
        console.log(`  ${c.dim('→')} Fill in the values, then reload your IDE\n`)
      }
    } else if (!dryRun && existsSync(envPath)) {
      // Check which vars are already in .env
      const envContent = await readFile(envPath, 'utf8')
      const missing = envVars.filter(({ envVar }) => !envContent.includes(envVar))
      if (missing.length > 0) {
        // `--yes` is documented as "accept the detected setup without asking",
        // and this was the one prompt that ignored it — so an interactive
        // `init --yes` still stopped, on a question that writes to .env.
        const appendEnv = assumeYes || (await confirm(`Append ${missing.length} missing variable(s) to .env?`, true))
        if (appendEnv) {
          const { appendFile } = await import('node:fs/promises')
          const lines = missing.map(({ envVar, hint }) => `# ${hint}\n${envVar}=\n`)
          await appendFile(envPath, '\n' + lines.join('\n'))
          console.log(`  ${c.green('✓')} Appended ${missing.length} placeholder(s) to .env`)
        }
      } else {
        console.log(`  ${c.green('✓')} All required variables found in .env`)
      }
    }
  }

  // ── OAuth setup guides ────────────────────────────────────────
  if (teamTools.includes('slack')) {
    console.log(`  ${c.cyan('📖')} Slack MCP requires a Slack App with a bot token.`)
    console.log(`     Setup guide: ${c.cyan('https://www.opencastle.dev/docs/plugins#slack')}\n`)
  }

  console.log(`\n  ${c.bold('Next steps:')}`)

  let step = 0
  // Reload window messages for relevant IDEs
  const RELOAD: Record<string, string> = {
    vscode: `${c.yellow('Reload VS Code window')} (Cmd+Shift+P → "Developer: Reload Window")`,
    cursor: `${c.yellow('Reload Cursor window')} to pick up the new rule files`,
    windsurf: `${c.yellow('Reload Windsurf window')} to pick up the new rule files`,
  }
  // One number per line. `step++` fired once for the whole group, so a
  // three-target install printed "1." three times and then "2.".
  for (const id of ides) {
    const line = RELOAD[id]
    if (!line) continue
    step++
    console.log(`  ${step}. ${line}`)
  }

  if (envVars.length > 0) {
    step++
    console.log(
      `  ${step}. Set the environment variable${envVars.length > 1 ? 's' : ''} listed above (in .env or your shell)`
    )
  }
  step++
  console.log(`  ${step}. Commit the .opencastle/ folder to your repository`)

  // Name the assistants not yet being compiled for — the reason to come back.
  const configured = new Set(ides)
  const otherIdes = (Object.keys(IDE_ADAPTERS) as IdeChoice[]).filter((id) => !configured.has(id))
  if (otherIdes.length > 0) {
    console.log(`\n  ${c.dim('Also used by your team?')} ${c.cyan('opencastle init --customize')}`)
    console.log(`  ${c.dim(`compiles the same config for ${otherIdes.map((id) => IDE_LABELS[id]).join(', ')}`)}`)
  }
  console.log()

  closePrompts()

  // Non-zero when part of what was asked could not be done — and only then.
  //
  // `init` printed "✗ Cursor could not be installed" and exited 0, so a script read
  // success from an install missing a whole target. That is worth failing on.
  //
  // A config we could not *parse* is not. VS Code reads `mcp.json` as JSONC, so a
  // `//` comment in it is legal to the editor that owns the file and unparseable to
  // us; we name it, skip it, and install everything else. Exiting non-zero there
  // would make `init` fail permanently on a project that is not broken — which is
  // why CLAIM 5 asserts exit 0 for exactly that fixture, and why the first version
  // of this check was wrong.
  //
  // The list already carries which of the two it was: `unreadable` means we could
  // not read the file at all — a directory wearing its name, or permissions — and
  // that is a real gap in the install.
  const couldNotRead = unreadable.filter((e) => e.split('\u0000')[1] === 'unreadable')
  if (couldNotRead.length > 0 || failedTargets.length > 0) process.exit(1)
}
