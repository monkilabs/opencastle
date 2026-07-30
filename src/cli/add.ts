import { readManifest, writeManifest } from './manifest.js'
import { TECH_PLUGINS, TEAM_PLUGINS } from '../orchestrator/plugins/index.js'
import { c, closePrompts } from './prompt.js'
import type { CliContext, StackConfig, TechTool, TeamTool } from './types.js'

/**
 * Add an integration to an existing install.
 *
 * Before this, the only way to pick up a tool you adopted after init was to
 * re-run the whole nine-screen selection via `update --reconfigure`. This edits
 * the manifest's stack and recompiles, so adopting a tool is one command.
 */

const ADD_HELP = `
  opencastle add <pack>...

  Add an integration to this project and recompile the generated config.

  Examples:
    opencastle add supabase
    opencastle add nextjs vercel sentry
    opencastle add --list

  Options:
    --list          Show every available pack
    --dry-run       Preview without writing
    --help, -h      Show this help
`

function listPacks(): void {
  console.log(`\n  ${c.bold('Available packs')}\n`)
  console.log(`  ${c.dim('Stack')}`)
  for (const p of TECH_PLUGINS) {
    console.log(`    ${p.id.padEnd(16)} ${c.dim(p.name)}`)
  }
  console.log(`\n  ${c.dim('Team')}`)
  for (const p of TEAM_PLUGINS) {
    console.log(`    ${p.id.padEnd(16)} ${c.dim(p.name)}`)
  }
  console.log(`\n  ${c.dim('Add with:')} ${c.cyan('opencastle add <pack>')}\n`)
}

export default async function add({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(ADD_HELP)
    return
  }

  if (args.includes('--list')) {
    listPacks()
    return
  }

  const dryRun = args.includes('--dry-run')
  const requested = args.filter((a) => !a.startsWith('--'))

  if (requested.length === 0) {
    console.log(ADD_HELP)
    listPacks()
    return
  }

  const projectRoot = process.cwd()
  const manifest = await readManifest(projectRoot)
  if (!manifest) {
    console.error(`\n  ${c.red('✗')} No OpenCastle installation found here.`)
    console.error(`  ${c.dim('Run')} ${c.cyan('opencastle init')} ${c.dim('first.')}\n`)
    process.exit(1)
  }

  const techIds = new Set(TECH_PLUGINS.map((p) => p.id))
  const teamIds = new Set(TEAM_PLUGINS.map((p) => p.id))

  const unknown = requested.filter((r) => !techIds.has(r as TechTool) && !teamIds.has(r as TeamTool))
  if (unknown.length > 0) {
    console.error(`\n  ${c.red('✗')} Unknown pack${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
    console.error(`  ${c.dim('See')} ${c.cyan('opencastle add --list')}\n`)
    process.exit(1)
  }

  const stack: StackConfig = manifest.stack ?? { ides: [], techTools: [], teamTools: [] }
  const already: string[] = []
  const added: string[] = []

  for (const id of requested) {
    if (techIds.has(id as TechTool)) {
      if (stack.techTools.includes(id as TechTool)) already.push(id)
      else {
        stack.techTools.push(id as TechTool)
        added.push(id)
      }
    } else {
      if (stack.teamTools.includes(id as TeamTool)) already.push(id)
      else {
        stack.teamTools.push(id as TeamTool)
        added.push(id)
      }
    }
  }

  console.log(`\n  🏰 ${c.bold('OpenCastle add')}\n`)
  for (const id of added) console.log(`    ${c.green('+')} ${id}`)
  for (const id of already) console.log(`    ${c.dim('=')} ${c.dim(`${id} (already added)`)}`)

  if (added.length === 0) {
    console.log(`\n  ${c.dim('Nothing to do.')}\n`)
    closePrompts()
    return
  }

  if (dryRun) {
    console.log(`\n  ${c.dim('[dry-run] Nothing was written.')}\n`)
    closePrompts()
    return
  }

  manifest.stack = stack
  manifest.updatedAt = new Date().toISOString()
  await writeManifest(projectRoot, manifest)

  // Recompile so the new pack's skills and MCP config reach every target.
  console.log(`\n  ${c.dim('Recompiling targets…')}`)
  const { default: sync } = await import('./sync.js')
  await sync({ pkgRoot, args: ['--yes'] })
}
