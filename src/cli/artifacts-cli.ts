import { pruneArtifacts } from './convoy/artifacts.js'
import type { CliContext } from './types.js'

const HELP = `
  opencastle artifacts <subcommand> [options]

  Manage filesystem artifact storage.

  Subcommands:
    prune              Prune old convoy artifact directories

  Options:
    --keep <N>         Number of recent artifacts to keep (default: 10)
    --dry-run          Preview what would be pruned without deleting
    --help, -h         Show this help
`

export default function artifactsCli({ args }: CliContext): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }

  const dryRun = args.includes('--dry-run') || args.includes('--dryRun')
  const subcommand = args.find(a => !a.startsWith('--'))

  if (subcommand === 'prune') {
    const keepIdx = args.indexOf('--keep')
    const keepCount = keepIdx >= 0 && args[keepIdx + 1] ? parseInt(args[keepIdx + 1], 10) : 10

    if (dryRun) {
      console.log(`  [dry-run] Would prune convoy artifacts, keeping ${keepCount} most recent`)
      return
    }

    const result = pruneArtifacts(keepCount)
    console.log(`Pruned ${result.removed} convoy artifact directories, freed ${(result.freed_bytes / 1024).toFixed(1)} KB`)
  } else {
    console.log(HELP)
  }
}
