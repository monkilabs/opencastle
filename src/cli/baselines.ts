import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { CliContext } from './types.js'
import { scanForSecrets } from './convoy/gates.js'

const HELP = `
  opencastle baselines <subcommand> [options]

  Manage visual regression baselines.

  Subcommands:
    update --slug <name> --from <file>   Update a baseline from a PNG file
    list                                  List all baselines

  Options:
    --slug <name>    Baseline name (used as filename)
    --from <file>    Source PNG file path
    --dir <path>     Baselines directory (default: .opencastle/baselines)
    --dry-run        Preview what would be updated without writing
    --help, -h       Show this help
`

interface BaselinesOptions {
  subcommand: string | null
  slug: string | null
  from: string | null
  dir: string
  dryRun: boolean
  help: boolean
}

function parseBaselinesArgs(args: string[]): BaselinesOptions {
  const opts: BaselinesOptions = {
    subcommand: null,
    slug: null,
    from: null,
    dir: '.opencastle/baselines',
    dryRun: false,
    help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--slug':
        if (i + 1 >= args.length) {
          console.error('  \u2717 --slug requires a name')
          process.exit(1)
        }
        opts.slug = args[++i]
        break
      case '--from':
        if (i + 1 >= args.length) {
          console.error('  \u2717 --from requires a file path')
          process.exit(1)
        }
        opts.from = args[++i]
        break
      case '--dir':
        if (i + 1 >= args.length) {
          console.error('  \u2717 --dir requires a path')
          process.exit(1)
        }
        opts.dir = args[++i]
        break
      case '--dry-run':
      case '--dryRun':
        opts.dryRun = true
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`  \u2717 Unknown option: ${arg}`)
          console.log(HELP)
          process.exit(1)
        }
        if (!opts.subcommand) {
          opts.subcommand = arg
        }
    }
  }
  return opts
}

export default async function baselines({ args }: CliContext): Promise<void> {
  const opts = parseBaselinesArgs(args)

  if (opts.help || !opts.subcommand) {
    console.log(HELP)
    return
  }

  switch (opts.subcommand) {
    case 'update': {
      if (!opts.slug) {
        console.error('  \u2717 update requires --slug <name>')
        process.exit(1)
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(opts.slug)) {
        console.error('  \u2717 Slug must contain only alphanumeric characters, hyphens, and underscores')
        process.exit(1)
      }
      if (!opts.from) {
        console.error('  \u2717 update requires --from <file>')
        process.exit(1)
      }
      if (!existsSync(opts.from)) {
        console.error(`  \u2717 Source file not found: ${opts.from}`)
        process.exit(1)
      }
      const data = readFileSync(opts.from)
      const scan = scanForSecrets(data.toString('base64'), opts.from)
      if (!scan.clean) {
        console.error('  \u2717 Source file contains potential secrets \u2014 baseline not updated')
        process.exit(1)
      }
      if (opts.dryRun) {
        const dest = join(opts.dir, `${opts.slug}.png`)
        console.log(`  [dry-run] Would update baseline: ${dest}`)
        break
      }
      mkdirSync(opts.dir, { recursive: true })
      const dest = join(opts.dir, `${opts.slug}.png`)
      writeFileSync(dest, data)
      console.log(`  \u2713 Baseline updated: ${dest}`)
      break
    }

    case 'list': {
      if (!existsSync(opts.dir)) {
        console.log(`  No baselines directory found at ${opts.dir}`)
        return
      }
      const files = readdirSync(opts.dir).filter((f) => f.endsWith('.png'))
      if (files.length === 0) {
        console.log('  No baselines found.')
        return
      }
      console.log(`\n  Baselines in ${opts.dir}:\n`)
      for (const file of files) {
        const stats = statSync(join(opts.dir, file))
        console.log(`  ${basename(file, '.png').padEnd(30)} ${(stats.size / 1024).toFixed(1)} KB`)
      }
      console.log()
      break
    }

    default:
      console.error(`  \u2717 Unknown subcommand: ${opts.subcommand}`)
      console.log(HELP)
      process.exit(1)
  }
}
