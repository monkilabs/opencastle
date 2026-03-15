import type { CliContext } from './types.js'
import { c } from './prompt.js'

const HELP = `
  opencastle skills [subcommand]

  Skill refinement and failure tracking.

  Subcommands:
    refine              Scan for failure patterns and generate refinement proposals
    failures            Show failure stats per skill

  Options:
    --dry-run           Preview what proposals would be generated without saving
    --help, -h          Show this help
`

function parseSkillsArgs(args: string[]): { subcommand: string | null; help: boolean; dryRun: boolean } {
  const opts = { subcommand: null as string | null, help: false, dryRun: false }
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--dry-run' || arg === '--dryRun') {
      opts.dryRun = true
    } else if (!arg.startsWith('--')) {
      opts.subcommand ??= arg
    }
  }
  return opts
}

export default async function skills({ args }: CliContext): Promise<void> {
  const opts = parseSkillsArgs(args)

  if (opts.help || !opts.subcommand) {
    console.log(HELP)
    return
  }

  const {
    getFailureStats,
    getSkillFailures,
    detectFailurePatterns,
    generateRefinementProposal,
    saveProposal,
  } = await import('./convoy/skill-refinement.js')

  switch (opts.subcommand) {
    case 'refine': {
      const stats = getFailureStats()
      const uniqueSkills = stats.map(s => s.skill_name)

      if (uniqueSkills.length === 0) {
        console.log('  No skill failures recorded yet.')
        return
      }

      const generated: Array<{ skill: string; path: string }> = []
      for (const skillName of uniqueSkills) {
        const failures = getSkillFailures(skillName)
        const { threshold_met } = detectFailurePatterns(failures)
        if (!threshold_met) continue
        const proposal = generateRefinementProposal(skillName, failures)
        const proposalPath = opts.dryRun
          ? `.opencastle/proposals/${skillName}-refinement.md`
          : saveProposal(proposal, undefined, failures)
        generated.push({ skill: skillName, path: proposalPath })
      }

      if (generated.length === 0) {
        console.log('  No skills currently meet the refinement threshold.')
      } else if (opts.dryRun) {
        console.log(`  [dry-run] Would generate ${generated.length} refinement proposal${generated.length === 1 ? '' : 's'}:`)
        for (const g of generated) {
          console.log(`    ${c.dim('◆')} ${g.skill}: ${g.path}`)
        }
      } else {
        console.log(`  ${c.green('✔')} ${generated.length} skill${generated.length === 1 ? '' : 's'} have refinement proposals. Review in .opencastle/proposals/`)
        for (const g of generated) {
          console.log(`    ${c.dim('◆')} ${g.skill}: ${g.path}`)
        }
      }
      break
    }

    case 'failures': {
      const stats = getFailureStats()
      if (stats.length === 0) {
        console.log('  No skill failures recorded yet.')
        return
      }

      const colW = [30, 10, 30, 26]
      const header = [
        'Skill'.padEnd(colW[0]),
        'Failures'.padEnd(colW[1]),
        'Agents'.padEnd(colW[2]),
        'Latest',
      ].join('  ')
      console.log(`\n  ${c.bold(header)}`)
      console.log('  ' + '-'.repeat(header.length))

      for (const s of stats) {
        const row = [
          s.skill_name.slice(0, colW[0] - 1).padEnd(colW[0]),
          String(s.count).padEnd(colW[1]),
          s.agents.join(', ').slice(0, colW[2] - 1).padEnd(colW[2]),
          s.latest.slice(0, 10),
        ].join('  ')
        console.log(`  ${row}`)
      }
      console.log('')
      break
    }

    default:
      console.error(`  ${c.red('✗')} Unknown subcommand: ${opts.subcommand}`)
      console.log(HELP)
      process.exit(1)
  }
}
