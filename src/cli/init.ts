import { resolve, relative } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { multiselect, confirm, closePrompts, c } from './prompt.js'
import { readManifest, writeManifest, createManifest } from './manifest.js'
import { removeDirIfExists, copyDir, getOrchestratorRoot } from './copy.js'
import { updateGitignore } from './gitignore.js'
import { getRequiredMcpEnvVars, getCustomizationsTransform } from './stack-config.js'
import { getPluginsBySubCategory } from '../orchestrator/plugins/index.js'
import type { PluginConfig } from '../orchestrator/plugins/types.js'
import { detectRepoInfo, mergeStackIntoRepoInfo, formatRepoInfo, buildDetectedToolsSet, detectCurrentIde, detectAssistantConfigs } from './detect.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { IDE_LABELS } from './types.js'
import type { CliContext, IdeChoice, TechTool, TeamTool, StackConfig } from './types.js'
import { bootstrapCustomizations } from './bootstrap.js'
import { stripManagedBlock, stripManagedBlockFromFile } from './managed-block.js'
import { resolveManagedPaths } from './managed-paths.js'

const INIT_HELP = `
  opencastle init [options]

  Set up this project: detects your stack and any assistant config you already
  have, shows what it will do, and asks once.

  Options:
    --customize     Choose IDEs and integrations manually
    --yes           Accept the detected setup without asking
    --dry-run       Preview what would be changed without writing files
    --help, -h      Show this help
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
export function detectSelection(projectRoot: string, repoInfo: Awaited<ReturnType<typeof detectRepoInfo>>): Selection {
  const assistants = detectAssistantConfigs(projectRoot)
  let ides = assistants.map((a) => a.ide)

  if (ides.length === 0) {
    const current = detectCurrentIde()
    ides = [current ?? 'vscode']
  }

  const detected = buildDetectedToolsSet(repoInfo)
  const techTools: string[] = []
  const teamTools: string[] = []

  for (const step of CATEGORY_STEPS) {
    const plugins = step.subCategories.flatMap((sc) =>
      getPluginsBySubCategory(sc as PluginConfig['subCategory']),
    )
    for (const p of plugins) {
      if (!p.preselected && !detected.has(p.id)) continue
      if (p.category === 'team') teamTools.push(p.id)
      else techTools.push(p.id)
    }
  }

  return { ides: [...new Set(ides)], techTools, teamTools }
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
    selection = detectSelection(projectRoot, repoInfo)

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
    if (removeOldFiles) {
      // Resolved against today's adapters, not read off the manifest: manifests
      // written before root files became co-owned list them under `framework`,
      // and this loop unlinks that.
      const previous = await resolveManagedPaths(existing)
      for (const p of previous.framework) {
        const fullPath = resolve(projectRoot, p)
        if (p.endsWith('/')) {
          await removeDirIfExists(fullPath)
        } else if (existsSync(fullPath)) {
          await unlink(fullPath)
        }
      }
      // Co-owned files are not ours to delete — take back only the block.
      for (const p of previous.merged) {
        await stripManagedBlockFromFile(resolve(projectRoot, p))
      }
    }
  }

  // ── Run adapters for each selected IDE ──────────────────────────
  let totalCreated = 0
  let totalSkipped = 0
  const skippedPaths: string[] = []
  const allManagedPaths = { framework: [] as string[], customizable: [] as string[], merged: [] as string[] }

  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const results = await adapter.install(pkgRoot, projectRoot, stack, combinedRepoInfo)
    totalCreated += results.created.length
    totalSkipped += results.skipped.length
    skippedPaths.push(...results.skipped)

    const managed = adapter.getManagedPaths()
    allManagedPaths.framework.push(...managed.framework)
    allManagedPaths.customizable.push(...managed.customizable)
    allManagedPaths.merged.push(...(managed.merged ?? []))
  }

  // If all files were skipped (orphaned install — no manifest but files exist)
  if (totalCreated === 0 && totalSkipped > 0 && !isReinit) {
    console.log(`  ${c.yellow('⚠')}  Found ${totalSkipped} existing files from a previous installation.`)
    const overwrite = await confirm('Overwrite existing files?', true)
    if (overwrite) {
      // Delete framework paths and re-run install
      for (const ide of ides) {
        const adapter = await IDE_ADAPTERS[ide]()
        const managed = adapter.getManagedPaths()
        for (const p of managed.framework) {
          const fullPath = resolve(projectRoot, p)
          if (p.endsWith('/')) {
            await removeDirIfExists(fullPath)
          } else if (existsSync(fullPath)) {
            await unlink(fullPath)
          }
        }
        for (const p of managed.merged ?? []) {
          await stripManagedBlockFromFile(resolve(projectRoot, p))
        }
      }
      // Re-run install
      totalCreated = 0
      totalSkipped = 0
      for (const ide of ides) {
        const adapter = await IDE_ADAPTERS[ide]()
        const results = await adapter.install(pkgRoot, projectRoot, stack, combinedRepoInfo)
        totalCreated += results.created.length
        totalSkipped += results.skipped.length
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
  console.log(`\n  ${c.dim('Configuring project...')}`)
  const bootstrapResult = await bootstrapCustomizations(projectRoot, combinedRepoInfo, stack)

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
  manifest.stack = stack
  manifest.repoInfo = combinedRepoInfo
  await writeManifest(projectRoot, manifest)

  // ── Update .gitignore ───────────────────────────────────────────
  // Only local artefacts and .env; the generated config is meant to be committed.
  const envVars = getRequiredMcpEnvVars(stack, combinedRepoInfo)
  const gitignoreResult = await updateGitignore(projectRoot)

  // ── Summary ─────────────────────────────────────────────────────
  console.log(`  ${c.green('✓')} Created ${c.bold(String(totalCreated))} files`)
  if (gitignoreResult === 'created') {
    console.log(`  ${c.green('✓')} Created .gitignore with OpenCastle entries`)
  } else if (gitignoreResult === 'updated') {
    console.log(`  ${c.green('✓')} Updated .gitignore with OpenCastle entries`)
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
      const createEnv = await confirm('Create a .env file with placeholders for these variables?', true)
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
        const appendEnv = await confirm(`Append ${missing.length} missing variable(s) to .env?`, true)
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
  const needsReload = ides.filter((id) => ['vscode', 'cursor', 'windsurf'].includes(id))
  if (needsReload.length > 0) {
    step++
    if (needsReload.includes('vscode')) {
      console.log(
        `  ${step}. ${c.yellow('Reload VS Code window')} (Cmd+Shift+P → "Developer: Reload Window")`
      )
    }
    if (needsReload.includes('cursor')) {
      console.log(
        `  ${step}. ${c.yellow('Reload Cursor window')} to pick up the new rule files`
      )
    }
    if (needsReload.includes('windsurf')) {
      console.log(
        `  ${step}. ${c.yellow('Reload Windsurf window')} to pick up the new rule files`
      )
    }
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
}
