import { resolve } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { select, multiselect, confirm, closePrompts, c } from './prompt.js'
import { readManifest, writeManifest, createManifest } from './manifest.js'
import { removeDirIfExists, copyDir, getOrchestratorRoot } from './copy.js'
import { updateGitignore } from './gitignore.js'
import { getRequiredMcpEnvVars, getCustomizationsTransform } from './stack-config.js'
import { TECH_PLUGINS, TEAM_PLUGINS } from '../orchestrator/plugins/index.js'
import { detectRepoInfo, mergeStackIntoRepoInfo, formatRepoInfo, buildDetectedToolsSet, detectCurrentIde } from './detect.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { IDE_LABELS } from './types.js'
import type { CliContext, IdeChoice, TechTool, TeamTool, StackConfig } from './types.js'
import { bootstrapCustomizations } from './bootstrap.js'

const INIT_HELP = `
  opencastle init [options]

  Set up OpenCastle in your project — copies framework files, configures
  IDE adapters, and creates the .opencastle/ directory.

  Options:
    --dry-run       Preview what would be changed without writing files
    --help, -h      Show this help
`

export default async function init({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(INIT_HELP)
    return
  }

  const projectRoot = process.cwd()
  const dryRun = args.includes('--dry-run') || args.includes('--dryRun')

  // Check for existing installation
  const existing = await readManifest(projectRoot)
  let isReinit = false
  if (existing) {
    const proceed = await confirm(
      `OpenCastle already installed (v${existing.version}). Re-initialize?`,
      false
    )
    if (!proceed) {
      console.log('  Aborted.')
      return
    }
    isReinit = true
  }

  const pkg = JSON.parse(
    await readFile(resolve(pkgRoot, 'package.json'), 'utf8')
  ) as { version: string }

  console.log(`\n  🏰 ${c.bold('OpenCastle')} ${c.dim(`v${pkg.version}`)}`)
  console.log(
    `  ${c.dim('Multi-agent orchestration framework for AI coding assistants')}\n`
  )

  // ── Repo research ───────────────────────────────────────────────
  console.log(`  ${c.dim('Scanning repository...')}`)
  const repoInfo = await detectRepoInfo(projectRoot)
  const summary = formatRepoInfo(repoInfo)
  if (summary) {
    console.log(`  ${c.green('Detected:')}\n` + summary + '\n')
  } else {
    console.log(`  ${c.dim('No tooling detected (empty project?)')}\n`)
  }

  // ── IDE (single select) ────────────────────────────────────────
  console.log(`  ${c.bold('── IDEs ──────────────────────────────────────')}`)
  const detectedIde = detectCurrentIde()
  const selectedIde = await select('Which IDE do you use?', [
    {
      label: 'VS Code',
      hint: 'GitHub Copilot agents, instructions, skills',
      value: 'vscode',
      ...(detectedIde === 'vscode' && { selected: true }),
    },
    {
      label: 'Cursor',
      hint: '.cursorrules & .cursor/rules/*.mdc',
      value: 'cursor',
      ...(detectedIde === 'cursor' && { selected: true }),
    },
    {
      label: 'Claude Code',
      hint: 'CLAUDE.md & .claude/ commands, skills',
      value: 'claude-code',
      ...(detectedIde === 'claude-code' && { selected: true }),
    },
    {
      label: 'OpenCode',
      hint: 'AGENTS.md & opencode.json',
      value: 'opencode',
      ...(detectedIde === 'opencode' && { selected: true }),
    },
    {
      label: 'Windsurf',
      hint: '.windsurfrules & .windsurf/rules/*.md',
      value: 'windsurf',
      ...(detectedIde === 'windsurf' && { selected: true }),
    },
    {
      label: 'Codex CLI',
      hint: 'AGENTS.md & .codex/',
      value: 'codex',
      ...(detectedIde === 'codex' && { selected: true }),
    },
    {
      label: 'Antigravity',
      hint: 'GEMINI.md & .gemini/',
      value: 'antigravity',
      ...(detectedIde === 'antigravity' && { selected: true }),
    },
  ])
  const ides = [selectedIde]

  // ── Tech Tools (multiselect, 0-N) ──────────────────────────────
  // Pre-select tools already detected in the repo
  const detectedTools = buildDetectedToolsSet(repoInfo)

  console.log(`  ${c.bold('── Tech Tools ────────────────────────────────')}`)
  const techTools = await multiselect('Which tools does your project use?',
    TECH_PLUGINS.map((p) => ({
      label: p.label,
      hint: p.hint,
      value: p.id,
      ...((p.preselected || detectedTools.has(p.id)) && { selected: true }),
    }))
  )

  // ── Team Tools (multiselect, 0-N) ──────────────────────────────
  console.log(`  ${c.bold('── Team Tools ────────────────────────────────')}`)
  const teamTools = await multiselect('Which team tools do you use?',
    TEAM_PLUGINS.map((p) => ({
      label: p.label,
      hint: p.hint,
      value: p.id,
      ...(p.preselected && { selected: true }),
    }))
  )

  const stack: StackConfig = {
    ides: ides as IdeChoice[],
    techTools: techTools as TechTool[],
    teamTools: teamTools as TeamTool[],
  }

  // ── Merge user choices into detected info ────────────────────
  const combinedRepoInfo = mergeStackIntoRepoInfo(repoInfo, stack)

  const ideNames = ides.map((id) => IDE_LABELS[id as IdeChoice]).join(', ')
  console.log(`\n  Installing for ${c.cyan(ideNames)}...`)
  if (techTools.length > 0) {
    console.log(`  Tech: ${c.green(techTools.join(', '))}`)
  }
  if (teamTools.length > 0) {
    console.log(`  Team: ${c.green(teamTools.join(', '))}`)
  }
  console.log()

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
    const frameworkPaths = existing.managedPaths?.framework ?? []
    for (const p of frameworkPaths) {
      const fullPath = resolve(projectRoot, p)
      if (p.endsWith('/')) {
        await removeDirIfExists(fullPath)
      } else if (existsSync(fullPath)) {
        await unlink(fullPath)
      }
    }
    // Remove MCP configs so they get regenerated with new stack
    const mcpCandidates = [
      '.vscode/mcp.json',
      '.cursor/mcp.json',
      '.claude/mcp.json',
      'opencode.json',
      '.windsurf/mcp.json',
      '.codex/mcp.json',
      '.gemini/mcp.json',
    ]
    for (const mcpPath of mcpCandidates) {
      const fullPath = resolve(projectRoot, mcpPath)
      if (existsSync(fullPath)) {
        await unlink(fullPath)
      }
    }
  }

  // ── Run adapters for each selected IDE ──────────────────────────
  let totalCreated = 0
  let totalSkipped = 0
  const allManagedPaths = { framework: [] as string[], customizable: [] as string[] }

  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const results = await adapter.install(pkgRoot, projectRoot, stack, combinedRepoInfo)
    totalCreated += results.created.length
    totalSkipped += results.skipped.length

    const managed = adapter.getManagedPaths()
    allManagedPaths.framework.push(...managed.framework)
    allManagedPaths.customizable.push(...managed.customizable)
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

  // ── Ensure .env is gitignored when MCP env vars are needed ────
  const envVars = getRequiredMcpEnvVars(stack, combinedRepoInfo)
  if (envVars.length > 0 && !allManagedPaths.framework.includes('.env')) {
    allManagedPaths.framework.push('.env')
  }

  // ── Update .gitignore ───────────────────────────────────────────
  const gitignoreResult = await updateGitignore(projectRoot, allManagedPaths)

  // ── Summary ─────────────────────────────────────────────────────
  console.log(`  ${c.green('✓')} Created ${c.bold(String(totalCreated))} files`)
  if (gitignoreResult === 'created') {
    console.log(`  ${c.green('✓')} Created .gitignore with OpenCastle entries`)
  } else if (gitignoreResult === 'updated') {
    console.log(`  ${c.green('✓')} Updated .gitignore with OpenCastle entries`)
  }
  if (totalSkipped > 0) {
    console.log(`  ${c.dim('→')} Skipped ${totalSkipped} existing files`)
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
        console.log(`  ${c.dim('→')} Your .env is missing: ${missing.map((m) => m.envVar).join(', ')}`)
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
  console.log()

  closePrompts()
}
