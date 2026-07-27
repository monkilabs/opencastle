import { resolve, relative, join, dirname } from 'node:path'
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFile, appendFile, rename, mkdir, writeFile, unlink, copyFile, readdir, rm } from 'node:fs/promises'
import { readManifest, writeManifest } from './manifest.js'
import { multiselect, confirm, closePrompts, c } from './prompt.js'
import { isLegacyStack, migrateStackConfig, IDE_LABELS } from './types.js'
import { TECH_PLUGINS, TEAM_PLUGINS } from '../orchestrator/plugins/index.js'
import { IDE_ADAPTERS, VALID_IDES } from './adapters/index.js'
import { copyDir, getOrchestratorRoot } from './copy.js'
import { bootstrapCustomizations } from './bootstrap.js'
import {
  getRequiredMcpEnvVars,
  updateSkillMatrixFile,
  resolveStack,
  getCustomizationsTransform,
  isEnvVarSatisfied,
} from './stack-config.js'
import { rebuildMcpConfig } from './mcp.js'
import { updateGitignore, LOCAL_DIRS } from './gitignore.js'
import { resolveManagedPaths, REQUIRED_CUSTOMIZATIONS } from './managed-paths.js'
import { detectRepoInfo, mergeStackIntoRepoInfo, buildDetectedToolsSet } from './detect.js'
import type { CliContext, IdeChoice, TechTool, TeamTool, StackConfig, RepoInfo } from './types.js'
import { UnreadableConfigError } from './types.js'

const UPDATE_HELP = `
  opencastle update [options]

  Update framework files to the latest version while preserving
  your customizations in the .opencastle/ directory.

  Options:
    --dry-run         Preview what would be changed without writing files
    --force           Force update even if versions match
    --reconfigure     Re-run IDE and stack selection
    --help, -h        Show this help
`

/**
 * Add back the `.opencastle/` files a working install cannot do without.
 *
 * Deliberately narrow. The first attempt restored every template and then ran
 * `bootstrapCustomizations` over the real project to prune the ones it did not
 * need — and bootstrap, written to run exactly once, renamed and deleted on
 * every sync, eating the user's own writing in the directory the drift checker
 * calls theirs. The second attempt moved that to a scratch copy, which was safe
 * but could not reproduce `init`'s pruning, so it handed back the seven
 * templates `init` had just removed.
 *
 * Templates are `init`'s business. What `sync` owes is the handful of files the
 * tool itself requires — the agent registry and the skill matrix, which a
 * pre-0.36 install never had, and whose absence made `doctor` fail while
 * prescribing this very command. Nothing that exists is touched.
 */
async function restoreMissingCustomizations(
  pkgRoot: string,
  projectRoot: string,
  stack: StackConfig,
  ides: string[],
): Promise<void> {
  const src = resolve(getOrchestratorRoot(pkgRoot), 'customizations')
  if (!existsSync(src)) return

  const transform = getCustomizationsTransform(stack)
  const restored: string[] = []
  for (const rel of REQUIRED_CUSTOMIZATIONS.map((r) => join(...r.split('/')))) {
    const from = resolve(src, rel)
    const to = resolve(projectRoot, '.opencastle', rel)
    if (!existsSync(from) || existsSync(to)) continue
    await mkdir(dirname(to), { recursive: true })
    const body = await readFile(from, 'utf8')
    const out = transform ? await transform(body, from) : body
    // A transform returning null means "do not install this file".
    if (out === null) continue
    await writeFile(to, out)
    restored.push(rel)
  }

  if (restored.length > 0) {
    console.log(`  ${c.green('+')} Restored ${restored.length} missing customization file(s)`)
    for (const ide of ides) await updateSkillMatrixFile(projectRoot, ide, stack)
  }
}

export default async function update({
  pkgRoot,
  args,
}: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(UPDATE_HELP)
    return
  }

  const projectRoot = process.cwd()

  // Deliberately after the dry-run flag is known: this writes and deletes, and
  // `--dry-run` closes by printing "No files were written". It ran first, so
  // that promise was false on exactly the installs the migration exists for.
  const isDryRun = args.includes('--dry-run') || args.includes('--dryRun')
  if (!isDryRun) await migrateCustomizationsDir(projectRoot)

  const manifest = await readManifest(projectRoot)
  if (!manifest) {
    console.error(
      `  ${c.red('✗')} No OpenCastle installation found. Run "npx opencastle init" first.`
    )
    process.exit(1)
  }

  // Determine list of IDEs to update (support legacy single-IDE manifests)
  const recordedIdes = manifest.ides?.length ? manifest.ides : [manifest.ide]
  const invalidIdes = recordedIdes.filter((id) => !VALID_IDES.includes(id))
  // Skipped, not fatal. `sync --check` already filters these, so refusing to run
  // here meant the same manifest passed the check and could not be synced — and
  // an id we no longer recognise is a reason to compile the other six targets,
  // not to compile none of them.
  if (invalidIdes.length > 0) {
    console.log(
      `  ${c.yellow('!')} Skipping unknown target(s) "${invalidIdes.join(', ')}" from the manifest.`,
    )
  }
  const ides = recordedIdes.filter((id): id is string => Boolean(id) && VALID_IDES.includes(id))
  if (ides.length === 0) {
    console.error(
      `  ${c.red('✗')} No known targets in the manifest. Valid: ${VALID_IDES.join(', ')}`,
    )
    process.exit(1)
  }

  // Migrate legacy stack config if needed
  if (manifest.stack && isLegacyStack(manifest.stack)) {
    manifest.stack = migrateStackConfig(manifest.stack, manifest.ide)
    manifest.stack.ides = ides as IdeChoice[]
  }

  const pkg = JSON.parse(
    await readFile(resolve(pkgRoot, 'package.json'), 'utf8')
  ) as { version: string }

  // ── Recreate the local-only directories ─────────────────────────
  // Deliberately gitignored, so a fresh clone has none of them, and only `init`
  // used to create them: `doctor` failed on every clone and told the user to run
  // `sync`, which did not fix it. Done before the up-to-date short-circuit,
  // because a clean clone is precisely the case that short-circuits.
  if (!args.includes('--dry-run') && !args.includes('--dryRun')) {
    for (const dir of LOCAL_DIRS) {
      await mkdir(resolve(projectRoot, dir), { recursive: true })
    }
  }

  const dryRun = args.includes('--dry-run') || args.includes('--dryRun')
  const forceFlag = args.includes('--force')
  const reconfigureFlag = args.includes('--reconfigure')

  const isVersionBump = manifest.version !== pkg.version
  let wantsReconfigure = reconfigureFlag

  // Whether to recompile is a question about content, not about version numbers.
  // Sources change without a release — someone edits a skill, or edits a
  // generated file by hand — and gating on version equality meant `sync --check`
  // could report drift while `sync` insisted everything was up to date. Compare
  // against a fresh compile instead; recompiling is idempotent and cheap.
  const needsSync = await (async () => {
    if (manifest.version !== pkg.version || forceFlag || reconfigureFlag) return true
    try {
      const { buildCheckReport } = await import('./sync-check.js')
      const report = await buildCheckReport(pkgRoot, projectRoot)
      return report.drift.length > 0
    } catch {
      // If the comparison itself fails, err towards doing the work.
      return true
    }
  })()

  const assumeYes = args.includes('--yes')

  // Before the short-circuit, not after. `.opencastle/` is a customizable path,
  // so a missing skill matrix is not drift and `needsSync` is false — which left
  // `doctor` failing, prescribing this command, and this command reporting
  // health while doing nothing. `--force` fixed it, which is a flag the
  // diagnosis never named. The LOCAL_DIRS loop above was hoisted for exactly
  // this reason; these belong beside it.
  if (!dryRun) {
    const stackNow = resolveStack({ ...manifest, ides })
    await restoreMissingCustomizations(pkgRoot, projectRoot, stackNow, ides)
    if ((await updateGitignore(projectRoot)) !== 'unchanged') {
      console.log(`  ${c.green('✓')} Updated .gitignore ${c.dim('(generated config is committed)')}`)
    }
  }

  if (!needsSync && !dryRun) {
    console.log(`  ${c.green('✓')} Everything matches its sources (v${pkg.version}).`)
    // `--yes` means "do not ask me anything". This one slipped the guard, so a CI
    // runner holding stdin open would block here on an up-to-date project, and
    // `add`, which routes through sync, asked twice for one instruction.
    if (assumeYes) {
      closePrompts()
      return
    }
    wantsReconfigure = await confirm(
      'Would you like to change your stack selections?',
      false
    )
    if (!wantsReconfigure) {
      closePrompts()
      return
    }
  }

  // ── Detect repo info ────────────────────────────────────────────
  const repoInfo = await detectRepoInfo(projectRoot)

  // ── Reconfigure stack if requested ──────────────────────────────
  const oldStack = manifest.stack
  // Resolved, never undefined: the adapters read `undefined` as "include every
  // plugin", which is not what a manifest with no stack means, and is not what
  // the drift checker assumes either.
  let newStack: StackConfig = resolveStack({ ...manifest, ides })
  let stackChanged = false
  let addedTools: string[] = []
  let removedTools: string[] = []

  if (wantsReconfigure) {
    const detectedTools = buildDetectedToolsSet(repoInfo)

    const currentTech = new Set(oldStack?.techTools ?? [])
    const currentTeam = new Set(oldStack?.teamTools ?? [])

    console.log(`\n  ${c.bold('── Tech Tools ────────────────────────────────')}`)
    const techTools = await multiselect(
      'Which tools does your project use?',
      TECH_PLUGINS.map((p) => ({
        label: p.label,
        hint: p.hint,
        value: p.id,
        selected: oldStack
          ? currentTech.has(p.id as TechTool)
          : p.preselected || detectedTools.has(p.id),
      }))
    )

    console.log(`  ${c.bold('── Team Tools ────────────────────────────────')}`)
    const teamTools = await multiselect(
      'Which team tools do you use?',
      TEAM_PLUGINS.map((p) => ({
        label: p.label,
        hint: p.hint,
        value: p.id,
        selected: oldStack
          ? currentTeam.has(p.id as TeamTool)
          : !!p.preselected,
      }))
    )

    newStack = {
      ides: ides as IdeChoice[],
      techTools: techTools as TechTool[],
      teamTools: teamTools as TeamTool[],
    }

    // Compute diff
    const newTechSet = new Set(techTools)
    const newTeamSet = new Set(teamTools)
    const techChanged = !sameSet(currentTech as Set<string>, newTechSet)
    const teamChanged = !sameSet(currentTeam as Set<string>, newTeamSet)
    stackChanged = techChanged || teamChanged

    if (stackChanged) {
      const oldAll: string[] = [
        ...(oldStack?.techTools ?? []),
        ...(oldStack?.teamTools ?? []),
      ]
      const newAll: string[] = [...techTools, ...teamTools]
      addedTools = newAll.filter((t) => !oldAll.includes(t))
      removedTools = oldAll.filter((t) => !newAll.includes(t))
    }
  }

  // Nothing to do?
  if (!needsSync && !stackChanged) {
    console.log(`  No changes to apply.`)
    closePrompts()
    return
  }

  // ── Summary ─────────────────────────────────────────────────────
  const ideNames = ides
    .map((id) => IDE_LABELS[id as IdeChoice] ?? id)
    .join(', ')

  if (isVersionBump) {
    console.log(
      `\n  🏰 ${c.bold('OpenCastle')} ${dryRun ? 'dry-run' : 'update'}: ${c.dim(`v${manifest.version}`)} → ${c.green(`v${pkg.version}`)}\n`
    )
  } else {
    console.log(
      `\n  🏰 ${c.bold('OpenCastle')} ${dryRun ? 'dry-run' : 'reconfigure'} ${c.dim(`v${pkg.version}`)}\n`
    )
  }

  console.log(`  IDEs: ${c.cyan(ideNames)}`)

  if (stackChanged) {
    if (addedTools.length > 0) {
      console.log(`  ${c.green('+')} Adding: ${addedTools.join(', ')}`)
    }
    if (removedTools.length > 0) {
      console.log(`  ${c.red('−')} Removing: ${removedTools.join(', ')}`)
    }
  } else if (newStack) {
    if (newStack.techTools.length > 0) {
      console.log(`  Tech: ${c.green(newStack.techTools.join(', '))}`)
    }
    if (newStack.teamTools.length > 0) {
      console.log(`  Team: ${c.green(newStack.teamTools.join(', '))}`)
    }
  }

  if (needsSync) {
    console.log(`  ${c.dim('Framework files will be overwritten.')}`)
    console.log(`  ${c.dim('Customization files will be preserved.')}`)
  }
  console.log()

  // ── Dry run ─────────────────────────────────────────────────────
  if (dryRun) {
    // The resolved classification, not the stored one — a pre-0.36 manifest lists
    // CLAUDE.md under `framework`, so the dry run was previewing the very
    // mislabelling the rest of this command exists to correct.
    const preview = await resolveManagedPaths({ ...manifest, ides })
    console.log(`  ${c.dim('[dry-run]')} Framework files that would be updated:\n`)
    for (const p of preview.framework) {
      console.log(`    ${c.yellow('↻')} ${p}`)
    }
    if (preview.merged.length > 0) {
      console.log(`\n  ${c.dim('[dry-run]')} Files where only the managed block changes:\n`)
      for (const p of preview.merged) {
        console.log(`    ${c.yellow('~')} ${p}`)
      }
    }
    console.log(
      `\n  ${c.dim('[dry-run]')} Customization files that would be preserved:\n`
    )
    for (const p of preview.customizable) {
      console.log(`    ${c.green('✓')} ${p}`)
    }
    if (stackChanged) {
      console.log()
      if (addedTools.length > 0) {
        console.log(
          `  ${c.dim('[dry-run]')} Skills to add: ${addedTools.join(', ')}`
        )
      }
      if (removedTools.length > 0) {
        console.log(
          `  ${c.dim('[dry-run]')} Skills to remove: ${removedTools.join(', ')}`
        )
      }
      console.log(`  ${c.dim('[dry-run]')} Skill matrix would be updated`)
      console.log(`  ${c.dim('[dry-run]')} MCP config would be rebuilt`)
    }
    console.log(`\n  ${c.dim('No files were written.')}\n`)
    closePrompts()
    return
  }

  // `opencastle add sentry` already said what to do. Asking again is a keystroke
  // charged for nothing.
  if (!assumeYes) {
    const proceed = await confirm('Proceed?')
    if (!proceed) {
      console.log('  Aborted.')
      closePrompts()
      return
    }
  }

  // ── Update each IDE ─────────────────────────────────────────────
  let totalCopied = 0
  let totalCreated = 0
  const adoptedRoots: string[] = []
  const staleRoots: string[] = []
  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const results = await adapter.update(pkgRoot, projectRoot, newStack)
    totalCopied += results.copied.length
    totalCreated += results.created.length
    adoptedRoots.push(...(results.adopted ?? []))
    staleRoots.push(...(results.staleRoots ?? []))
  }

  // Deduplicated, and re-sorted by what the adapters declare today — two targets
  // that share AGENTS.md used to record it twice, and a manifest from before
  // root files were co-owned still files them under `framework`.
  const allManagedPaths = await resolveManagedPaths({ ...manifest, ides })

  // The skill matrix and the MCP config are compiled output like everything else,
  // so they are regenerated whenever we recompile. Gating them on `stackChanged`
  // — a flag only ever set inside the interactive reconfigure branch — meant
  // `opencastle add supabase` edited the manifest, recompiled, and left the skill
  // matrix and MCP config describing the stack from before the pack was added.
  const unreadable: string[] = []
  if (newStack) {
    for (const ide of ides) {
      for (const step of [
        () => updateSkillMatrixFile(projectRoot, ide, newStack),
        () => rebuildMcpConfig(projectRoot, ide as IdeChoice, newStack, repoInfo),
      ]) {
        try {
          await step()
        } catch (err) {
          if (!(err instanceof UnreadableConfigError)) throw err
          if (!unreadable.includes(err.file)) unreadable.push(err.file)
        }
      }
    }
  }

  // ── Restore any missing .opencastle/ scaffolding ────────────────
  // Only what is *absent*. The first version of this called `copyDir` and then
  // `bootstrapCustomizations` directly against the project, which was wrong in a
  // way review caught and I had not: bootstrap was written to run once, and its
  // rename and prune steps are unconditional. Restoring `database-config.md`
  // handed bootstrap a template to rename, and the rename overwrote the user's
  // own `supabase-config.md` — on every sync, in the directory the drift checker
  // tells people is theirs.
  //
  // So the scaffolding is built somewhere else and only the missing files are
  // copied in. Nothing that already exists is read, written, renamed, or
  // deleted.

  // ── Rewrite the .gitignore block ────────────────────────────────
  // Not just an init-time concern. Releases before this one ignored every
  // generated path, so an existing install upgrades, keeps CLAUDE.md untracked,
  // and the `sync --check` job the README prescribes reports every generated
  // file as "never generated" on a clean checkout — with a suggested fix that
  // cannot fix it. The population that most needs the new block is the one that
  // never runs `init` again.

  // ── Migrate legacy log files ────────────────────────────────────
  await migrateLegacyLogs(projectRoot)

  // ── Update manifest ─────────────────────────────────────────────
  manifest.version = pkg.version
  manifest.ides = ides
  manifest.updatedAt = new Date().toISOString()
  manifest.managedPaths = allManagedPaths
  manifest.stack = newStack
  manifest.repoInfo = mergeStackIntoRepoInfo(repoInfo, newStack)
  await writeManifest(projectRoot, manifest)

  // ── Results ─────────────────────────────────────────────────────
  console.log(
    `\n  ${c.green('✓')} Updated ${c.bold(String(totalCopied))} framework files`
  )
  if (totalCreated > 0) {
    console.log(
      `  ${c.green('+')} Created ${c.bold(String(totalCreated))} new files`
    )
  }
  if (newStack && unreadable.length === 0) {
    console.log(`  ${c.green('✓')} Updated skill matrix`)
    console.log(`  ${c.green('✓')} Rebuilt MCP config`)
  }
  for (const file of unreadable) {
    console.log(`  ${c.yellow('!')} Left ${file} alone — it is not valid JSON.`)
    console.log(`     ${c.dim('Merge conflict? Fix the file and run sync again.')}`)
  }
  if (adoptedRoots.length > 0) {
    // Loud, because this is the one place the tool replaces a file it did not
    // write in this run. It was generated by an older release, but anything
    // appended to it since goes with it.
    console.log(
      `\n  ${c.yellow('⚠')}  Replaced ${adoptedRoots.length} file(s) generated by an earlier version:\n`,
    )
    for (const p of adoptedRoots) {
      console.log(`     ${c.bold(relative(projectRoot, p))}`)
      console.log(`     ${c.dim('└')} ${c.dim(`previous contents kept as ${relative(projectRoot, p)}.opencastle-backup`)}\n`)
    }
  }
  if (staleRoots.length > 0) {
    // We could not adopt these: the user's own writing comes first in the file,
    // so the older release's output is stranded above our block where it still
    // names agents and skills that no longer exist. The assistant reads both
    // halves, so silence here is worse than the mess.
    console.log(`\n  ${c.yellow('⚠')}  ${new Set(staleRoots).size} file(s) still contain output from an earlier version:\n`)
    for (const p of new Set(staleRoots)) {
      console.log(`     ${c.bold(relative(projectRoot, p))}`)
      console.log(
        `     ${c.dim('└')} ${c.dim('your own writing comes first, so it was not replaced. Delete everything')}`,
      )
      console.log(`     ${c.dim(' ')} ${c.dim('above the OpenCastle block that you did not write.')}\n`)
    }
  }

  // ── Env var notice ──────────────────────────────────────────────
  // Reported by what is actually missing rather than by what changed this run.
  // The old diff-against-previous-stack version was inside the `stackChanged`
  // gate, so `opencastle add sentry` never mentioned the token it now needs.
  if (newStack) {
    const envVars = getRequiredMcpEnvVars(newStack, repoInfo)
    const envFile = await readFile(resolve(projectRoot, '.env'), 'utf8').catch(() => '')
    const missing = envVars.filter(({ envVar }) => !isEnvVarSatisfied(envVar, envFile))
    if (missing.length > 0) {
      console.log(`\n  ${c.yellow('⚠')}  Environment variables still needed:\n`)
      for (const { envVar, hint } of missing) {
        console.log(`     ${c.bold(envVar)}`)
        console.log(`     ${c.dim('└')} ${c.dim(hint)}\n`)
      }
    }

    // Setup guides for newly added tools
    if (addedTools.includes('slack')) {
      console.log(
        `  ${c.cyan('📖')} Slack MCP requires a Slack App with a bot token.`
      )
      console.log(
        `     Setup guide: ${c.cyan('https://www.opencastle.dev/docs/plugins#slack')}\n`
      )
    }
  }

  // ── Reload window message ─────────────────────────────────────
  const needsReload = ides.filter((id) => ['vscode', 'cursor'].includes(id))
  if (needsReload.length > 0) {
    console.log()
    if (needsReload.includes('vscode')) {
      console.log(
        `  ${c.yellow('⟳')} Reload VS Code window (Cmd+Shift+P → "Developer: Reload Window") to pick up changes`
      )
    }
    if (needsReload.includes('cursor')) {
      console.log(
        `  ${c.yellow('⟳')} Reload Cursor window to pick up the updated rule files`
      )
    }
  }
  console.log()

  closePrompts()
}

async function copyDirMigrate(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const srcPath = resolve(srcDir, entry.name)
    const destPath = resolve(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirMigrate(srcPath, destPath)
    } else if (!existsSync(destPath)) {
      await copyFile(srcPath, destPath)
    }
  }
}

async function migrateCustomizationsDir(projectRoot: string): Promise<void> {
  const oldManifestPath = resolve(projectRoot, '.opencastle.json')
  const newOpencastleDir = resolve(projectRoot, '.opencastle')
  const newManifestPath = resolve(newOpencastleDir, 'manifest.json')

  // Migrate manifest from flat location to .opencastle/manifest.json
  if (existsSync(oldManifestPath) && !existsSync(newManifestPath)) {
    await mkdir(newOpencastleDir, { recursive: true })
    const content = await readFile(oldManifestPath, 'utf8')
    await writeFile(newManifestPath, content)
    await unlink(oldManifestPath)
    console.log(`  ${c.green('✓')} Migrated manifest to .opencastle/manifest.json`)
  }

  // Old customizations directory locations per IDE
  const oldCustDirs = [
    resolve(projectRoot, '.github', 'customizations'),
    resolve(projectRoot, '.cursor', 'rules', 'customizations'),
    resolve(projectRoot, '.claude', 'customizations'),
    resolve(projectRoot, '.opencode', 'customizations'),
  ]

  // Copy from every old location, not just the first. The loop below deletes
  // all four, so stopping at the first meant an empty `.github/customizations/`
  // could shadow a populated `.claude/customizations/` — whose contents were
  // then deleted having been copied nowhere. `copyDirMigrate` does not
  // overwrite, so the earlier directory still wins where they overlap.
  let migrated = false
  for (const oldDir of oldCustDirs) {
    if (!existsSync(oldDir)) continue
    await copyDirMigrate(oldDir, newOpencastleDir)
    migrated = true
  }
  if (migrated) console.log(`  ${c.green('✓')} Migrated customizations to .opencastle/`)

  // Remove all old customizations directories
  for (const oldDir of oldCustDirs) {
    if (existsSync(oldDir)) {
      await rm(oldDir, { recursive: true })
    }
  }
}

async function migrateLegacyLogs(projectRoot: string): Promise<void> {
  const candidateLogsDirs = [
    resolve(projectRoot, '.github', 'customizations', 'logs'),
    resolve(projectRoot, '.opencastle', 'logs'),
  ]

  const typeMap: Record<string, string> = {
    'sessions.ndjson': 'session',
    'delegations.ndjson': 'delegation',
    'reviews.ndjson': 'review',
    'panels.ndjson': 'panel',
    'disputes.ndjson': 'dispute',
  }

  for (const logsDir of candidateLogsDirs) {
    if (!existsSync(logsDir)) continue

    const eventsFile = resolve(logsDir, 'events.ndjson')
    let totalMigrated = 0

    for (const [filename, type] of Object.entries(typeMap)) {
      const filePath = resolve(logsDir, filename)
      if (!existsSync(filePath)) continue

      let content: string
      try {
        content = await readFile(filePath, 'utf8')
      } catch {
        continue
      }

      const lines = content.split('\n').filter((line) => line.trim() !== '')
      if (lines.length === 0) continue

      const migratedLines: string[] = []
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (!record['type']) {
            record['type'] = type
          }
          migratedLines.push(JSON.stringify(record))
        } catch {
          console.warn(`  ${c.yellow('⚠')}  Skipping malformed JSON line in ${filename}`)
        }
      }

      if (migratedLines.length > 0) {
        await appendFile(eventsFile, migratedLines.join('\n') + '\n', 'utf8')
        totalMigrated += migratedLines.length
      }

      await rename(filePath, filePath + '.migrated')
    }

    if (totalMigrated > 0) {
      console.log(
        `  ${c.green('✓')} Migrated ${c.bold(String(totalMigrated))} records from legacy log files to events.ndjson`
      )
    }
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}
