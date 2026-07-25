import update from './update.js'
import type { CliContext } from './types.js'

/**
 * Compile the framework sources into every configured target.
 *
 * This is the former `update` command under the name that describes what it
 * actually does — the operation is a compile-and-sync, not a version bump. The
 * `update` name remains as a hidden alias so existing scripts and generated
 * instructions keep working.
 */

const SYNC_HELP = `
  opencastle sync [options]

  Compile the framework sources into every configured assistant target,
  preserving your customizations in .opencastle/.

  Options:
    --dry-run         Preview what would change
    --force           Sync even when versions match
    --reconfigure     Re-run IDE and stack selection
    --help, -h        Show this help
`

export default async function sync(ctx: CliContext): Promise<void> {
  if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
    console.log(SYNC_HELP)
    return
  }

  await update(ctx)
}
