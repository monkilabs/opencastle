import { resolve } from 'node:path'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readManifest } from './manifest.js'
import { removeDirIfExists } from './copy.js'
import { removeGitignoreBlock } from './gitignore.js'
import { confirm, select, closePrompts, c } from './prompt.js'
import { stripManagedBlockFromFile } from './managed-block.js'
import { resolveManagedPaths } from './managed-paths.js'
import { stripManagedMcpServers, getMcpConfigRelPath } from './mcp.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import type { CliContext, IdeChoice } from './types.js'

/**
 * Removal, with the destructive choice made explicit rather than encoded in the
 * command name.
 *
 * Previously this was two commands whose names gave no hint which one deleted
 * your files: "eject" dropped the manifest and kept everything, "destroy"
 * deleted every generated path. Users had to know the vocabulary before they
 * could safely run either. Now one command asks, and always previews first.
 */

const REMOVE_HELP = `
  opencastle remove [options]

  Remove OpenCastle from this project. Asks whether to keep the generated
  files (so they become standalone) or delete everything.

  Options:
    --keep-files    Keep generated files; only drop the manifest
    --all           Delete every generated file
    --dry-run       Preview without changing anything
    --yes           Skip the confirmation prompt
    --help, -h      Show this help
`

type Mode = 'keep-files' | 'all'

export default async function remove({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(REMOVE_HELP)
    return
  }

  const projectRoot = process.cwd()
  const dryRun = args.includes('--dry-run')
  const assumeYes = args.includes('--yes')

  const manifest = await readManifest(projectRoot)
  if (!manifest) {
    console.error(`\n  ${c.red('✗')} No OpenCastle installation found here.`)
    console.error(`  ${c.dim('Run')} ${c.cyan('opencastle')} ${c.dim('to see project status.')}\n`)
    process.exit(1)
  }

  let mode: Mode | undefined
  if (args.includes('--all')) mode = 'all'
  else if (args.includes('--keep-files')) mode = 'keep-files'

  if (!mode) {
    const answer = await select('What should happen to the generated files?', [
      {
        label: 'Keep them (make them standalone)',
        hint: 'removes the manifest only — you can then uninstall the package',
        value: 'keep-files',
      },
      {
        label: 'Delete everything OpenCastle created',
        hint: 'cannot be undone',
        value: 'all',
      },
    ])
    mode = answer as Mode
  }

  // Not `manifest.managedPaths` directly: a manifest written before root files
  // became co-owned files them under `framework`, and this loop unlinks that.
  const managed = await resolveManagedPaths(manifest)
  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter(
    (id): id is IdeChoice => Boolean(id) && id in IDE_ADAPTERS,
  )
  const mcpPaths = new Set(ides.map((ide) => getMcpConfigRelPath(ide)))
  const frameworkPaths = managed.framework.filter((p) => !mcpPaths.has(p))
  const customizablePaths = managed.customizable.filter((p) => !mcpPaths.has(p))
  const mergedPaths = managed.merged
  const legacyManifestPath = resolve(projectRoot, '.opencastle.json')
  const hasLegacy = existsSync(legacyManifestPath)

  console.log(`\n  🏰 ${c.bold('OpenCastle remove')}\n`)

  if (mode === 'keep-files') {
    console.log('  Will remove:')
    console.log(`    ${c.dim('.opencastle/manifest.json')}`)
    console.log('\n  Every generated file stays exactly where it is.')
    console.log(`  Afterwards: ${c.bold('npm uninstall opencastle')}\n`)
  } else {
    console.log(`  ${c.bold('Deleted')}\n`)
    for (const p of [...frameworkPaths, ...customizablePaths]) {
      console.log(`    ${c.red('-')} ${c.dim(p)}`)
    }
    // Named plainly: this is the one path in the list that holds writing of the
    // user's own, and the command spends the rest of its effort preserving
    // exactly that kind of content elsewhere.
    console.log(`    ${c.red('-')} ${c.dim('.opencastle/')} ${c.yellow('including any conventions and lessons you edited')}`)
    if (hasLegacy) console.log(`    ${c.red('-')} ${c.dim('.opencastle.json')}`)

    // These are co-owned. Saying "permanently delete" over them, as this preview
    // used to, described the old behaviour rather than the current one.
    const coOwned = [
      ...mergedPaths.map((p) => [p, 'the OpenCastle block; your own writing stays'] as const),
      ...[...mcpPaths]
        .filter((p) => existsSync(resolve(projectRoot, p)))
        .map((p) => [p, 'our MCP servers; the rest of the file stays'] as const),
    ].filter(([p]) => existsSync(resolve(projectRoot, p)))

    if (coOwned.length > 0) {
      console.log(`\n  ${c.bold('Edited, not deleted')}\n`)
      for (const [p, what] of coOwned) {
        console.log(`    ${c.yellow('~')} ${c.dim(p)} ${c.dim(`— removes ${what}`)}`)
      }
    }
    console.log(`    ${c.yellow('~')} ${c.dim('.gitignore')} ${c.dim('— removes the OpenCastle block')}\n`)
  }

  if (dryRun) {
    console.log(`  ${c.dim('[dry-run] Nothing was changed.')}\n`)
    closePrompts()
    return
  }

  if (!assumeYes) {
    const proceed = await confirm(
      mode === 'all' ? 'Go ahead?' : 'Continue?',
      mode !== 'all',
    )
    if (!proceed) {
      console.log('  Aborted.\n')
      closePrompts()
      return
    }
  }

  if (mode === 'keep-files') {
    await unlink(resolve(projectRoot, '.opencastle', 'manifest.json')).catch(() => {})
    console.log(`\n  ${c.green('✓')} Files are now standalone.`)
    console.log(`  You can uninstall: ${c.bold('npm uninstall opencastle')}\n`)
    closePrompts()
    return
  }

  let removed = 0
  for (const p of [...frameworkPaths, ...customizablePaths]) {
    if (p.endsWith('/')) {
      await removeDirIfExists(resolve(projectRoot, p))
      removed++
    } else {
      const file = resolve(projectRoot, p)
      if (existsSync(file)) {
        await unlink(file)
        removed++
      }
    }
  }

  // Co-owned files hold the user's own writing above our block. Take back the
  // block; delete the file only if nothing of theirs remains.
  let stripped = 0
  for (const p of mergedPaths) {
    const outcome = await stripManagedBlockFromFile(resolve(projectRoot, p))
    if (outcome === 'deleted') removed++
    else if (outcome === 'stripped') stripped++
  }

  // MCP config is co-owned the same way: we merge our servers into a file that
  // may be the assistant's entire project config. Take back the servers, not
  // the file.
  for (const ide of ides) {
    const outcome = await stripManagedMcpServers(projectRoot, ide)
    if (outcome === 'deleted') removed++
    else if (outcome === 'stripped') stripped++
  }

  await removeDirIfExists(resolve(projectRoot, '.opencastle'))
  removed++

  if (hasLegacy) {
    await unlink(legacyManifestPath)
    removed++
  }

  const gitignoreResult = await removeGitignoreBlock(projectRoot)

  console.log(
    `\n  ${c.green('✓')} Removed ${removed} path(s)` +
      `${stripped > 0 ? `, kept your content in ${stripped} file(s)` : ''}` +
      `${gitignoreResult === 'removed' ? ' + .gitignore block' : ''}.`,
  )
  console.log(`  You can uninstall: ${c.bold('npm uninstall opencastle')}\n`)

  closePrompts()
}
