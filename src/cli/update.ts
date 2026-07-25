import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, appendFile, rename, mkdir, writeFile, unlink, copyFile, readdir, rm } from 'node:fs/promises'
import { readManifest, writeManifest } from './manifest.js'
import { multiselect, confirm, closePrompts, c } from './prompt.js'
import { isLegacyStack, migrateStackConfig, IDE_LABELS } from './types.js'
import { TECH_PLUGINS, TEAM_PLUGINS } from '../orchestrator/plugins/index.js'
import { IDE_ADAPTERS, VALID_IDES } from './adapters/index.js'
import { getRequiredMcpEnvVars, updateSkillMatrixFile } from './stack-config.js'
import { rebuildMcpConfig } from './mcp.js'
import { detectRepoInfo, mergeStackIntoRepoInfo, buildDetectedToolsSet } from './detect.js'
import type { CliContext, IdeChoice, TechTool, TeamTool, StackConfig } from './types.js'

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

export default async function update({
  pkgRoot,
  args,
}: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(UPDATE_HELP)
    return
  }

  const projectRoot = process.cwd()

  await migrateCustomizationsDir(projectRoot)

  const manifest = await readManifest(projectRoot)
  if (!manifest) {
    console.error(
      `  ${c.red('✗')} No OpenCastle installation found. Run "npx opencastle init" first.`
    )
    process.exit(1)
  }

  // Determine list of IDEs to update (support legacy single-IDE manifests)
  const ides = manifest.ides?.length ? manifest.ides : [manifest.ide]
  const invalidIdes = ides.filter((id) => !VALID_IDES.includes(id))
  if (invalidIdes.length > 0) {
    console.error(
      `  ${c.red('✗')} Invalid IDE(s) "${invalidIdes.join(', ')}" in .opencastle.json. Valid: ${VALID_IDES.join(', ')}`
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

  if (!needsSync && !dryRun) {
    console.log(`  ${c.green('✓')} Everything matches its sources (v${pkg.version}).`)
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
  let newStack: StackConfig | undefined = manifest.stack
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
    console.log(`  ${c.dim('[dry-run]')} Framework files that would be updated:\n`)
    for (const p of manifest.managedPaths?.framework ?? []) {
      console.log(`    ${c.yellow('↻')} ${p}`)
    }
    console.log(
      `\n  ${c.dim('[dry-run]')} Customization files that would be preserved:\n`
    )
    for (const p of manifest.managedPaths?.customizable ?? []) {
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

  const proceed = await confirm('Proceed?')
  if (!proceed) {
    console.log('  Aborted.')
    closePrompts()
    return
  }

  // ── Update each IDE ─────────────────────────────────────────────
  let totalCopied = 0
  let totalCreated = 0
  const allManagedPaths = {
    framework: [] as string[],
    customizable: [] as string[],
  }

  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const results = await adapter.update(pkgRoot, projectRoot, newStack)
    totalCopied += results.copied.length
    totalCreated += results.created.length

    const managed = adapter.getManagedPaths()
    allManagedPaths.framework.push(...managed.framework)
    allManagedPaths.customizable.push(...managed.customizable)
  }

  // ── Handle stack changes ────────────────────────────────────────
  if (stackChanged && newStack) {
    // Update skill matrix for each IDE
    for (const ide of ides) {
      await updateSkillMatrixFile(projectRoot, ide, newStack)
    }

    // Rebuild MCP configs for each IDE
    for (const ide of ides) {
      await rebuildMcpConfig(projectRoot, ide as IdeChoice, newStack, repoInfo)
    }
  }

  // ── Migrate legacy log files ────────────────────────────────────
  await migrateLegacyLogs(projectRoot)

  // ── Update manifest ─────────────────────────────────────────────
  manifest.version = pkg.version
  manifest.ides = ides
  manifest.updatedAt = new Date().toISOString()
  manifest.managedPaths = allManagedPaths
  if (newStack) manifest.stack = newStack
  manifest.repoInfo = newStack
    ? mergeStackIntoRepoInfo(repoInfo, newStack)
    : repoInfo
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
  if (stackChanged) {
    console.log(`  ${c.green('✓')} Updated skill matrix`)
    console.log(`  ${c.green('✓')} Rebuilt MCP config`)
  }

  // ── Env var notice for new tools ────────────────────────────────
  if (stackChanged && newStack) {
    const envVars = getRequiredMcpEnvVars(newStack, repoInfo)
    if (envVars.length > 0) {
      const oldEnvVars = oldStack
        ? new Set(
            getRequiredMcpEnvVars(oldStack, repoInfo).map((e) => e.envVar)
          )
        : new Set<string>()
      const newEnvVars = envVars.filter((e) => !oldEnvVars.has(e.envVar))
      if (newEnvVars.length > 0) {
        console.log(`\n  ${c.yellow('⚠')}  New environment variables needed:\n`)
        for (const { envVar, hint } of newEnvVars) {
          console.log(`     ${c.bold(envVar)}`)
          console.log(`     ${c.dim('└')} ${c.dim(hint)}\n`)
        }
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

  // Copy from the first found old location (content is the same across IDEs)
  for (const oldDir of oldCustDirs) {
    if (!existsSync(oldDir)) continue
    await copyDirMigrate(oldDir, newOpencastleDir)
    console.log(`  ${c.green('✓')} Migrated customizations to .opencastle/`)
    break
  }

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
