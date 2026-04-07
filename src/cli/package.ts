import { readFileSync, existsSync, mkdirSync, readdirSync, cpSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { c } from './prompt.js'
import type { CliContext } from './types.js'
import { PLATFORM_CONFIGS, getSkillsForPlatform } from './package-config.js'

const HELP = `
  opencastle package [options]

  Package OpenCastle orchestrator as a plugin for IDE marketplaces.

  Options:
    --platform, -p <name>   Target platform (claude-code, cursor, opencode, gemini)
    --all                   Generate packages for all platforms
    --output, -o <dir>      Output directory (default: dist/plugins)
    --dry-run               Preview what would be built without writing files
    --help, -h              Show this help
`

export interface PackageArgs {
  platform: string | null
  all: boolean
  output: string
  dryRun: boolean
  help: boolean
}

export function parseArgs(args: string[]): PackageArgs {
  const opts: PackageArgs = { platform: null, all: false, output: 'dist/plugins', dryRun: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--all') {
      opts.all = true
    } else if (arg === '--dry-run' || arg === '--dryRun') {
      opts.dryRun = true
    } else if ((arg === '--platform' || arg === '-p') && args[i + 1]) {
      opts.platform = args[++i]
      if (!opts.platform.trim()) { console.error('  ✗ --platform cannot be empty'); process.exit(1) }
    } else if ((arg === '--output' || arg === '-o') && args[i + 1]) {
      opts.output = args[++i]
      if (!opts.output.trim()) { console.error('  ✗ --output cannot be empty'); process.exit(1) }
    }
  }
  return opts
}

export function readVersion(pkgRoot: string): string {
  const pkgPath = resolve(pkgRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  return pkg.version
}

export function listSkillDirs(pkgRoot: string): string[] {
  const skillsPath = resolve(pkgRoot, 'src/orchestrator/skills')
  if (!existsSync(skillsPath)) return []
  return readdirSync(skillsPath, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
}

export function generateManifest(
  platform: string,
  version: string,
  skills: string[],
  agents: string[],
): object {
  const base = {
    name: 'opencastle',
    version,
    description: 'OpenCastle multi-agent orchestration framework',
    skills,
    agents,
  }
  if (platform === 'claude-code') {
    return { ...base, hooks: ['SessionStart'] }
  }
  if (platform === 'gemini') {
    return { ...base, type: 'extension' }
  }
  return base
}

export function generateEntryPoint(platform: string, version: string, skills: string[]): string {
  const skillList = skills.map(s => '- ' + s).join('\n')
  switch (platform) {
    case 'claude-code':
      return [
        '# OpenCastle v' + version,
        '',
        'Multi-agent orchestration framework for Claude Code.',
        '',
        '## Available Skills',
        '',
        skillList,
        '',
        '## Usage',
        '',
        'Skills are available in the `skills/` directory. Reference them in your agent instructions.',
        '',
      ].join('\n')
    case 'cursor':
      return [
        '# OpenCastle v' + version + ' -- Cursor Rules',
        '',
        'Multi-agent orchestration framework for Cursor.',
        '',
        '## Skills',
        '',
        skillList,
        '',
        '## Instructions',
        '',
        'Reference skill files using the `skills/` directory in your workspace.',
        '',
      ].join('\n')
    case 'opencode':
      return [
        '# OpenCastle v' + version,
        '',
        'Multi-agent orchestration framework for OpenCode.',
        '',
        '## Setup',
        '',
        'Copy this package to your project and reference skill files as needed.',
        '',
        '## Available Skills',
        '',
        skillList,
        '',
      ].join('\n')
    case 'gemini':
      return [
        '# OpenCastle v' + version,
        '',
        'Multi-agent orchestration framework for Gemini CLI.',
        '',
        '## Tool Mapping',
        '',
        'Each skill maps to a specialized tool capability.',
        '',
        '## Available Skills',
        '',
        skillList,
        '',
      ].join('\n')
    default:
      return '# OpenCastle v' + version + '\n'
  }
}

export function generateReadme(platform: string, version: string): string {
  const config = PLATFORM_CONFIGS[platform]
  const displayName = config?.displayName ?? platform
  return [
    '# OpenCastle Plugin for ' + displayName,
    '',
    'Version: ' + version,
    '',
    '## Installation',
    '',
    'Copy the contents of this directory to your ' + displayName + ' workspace or plugin directory.',
    '',
    '## Usage',
    '',
    'Reference the `' + (config?.entryPoint ?? 'README.md') + '` file in your ' + displayName + ' configuration.',
    '',
    '## Skills',
    '',
    'See the `skills/` directory for available skills.',
    '',
    '## Agents',
    '',
    'See the `agents/` directory for available agent definitions.',
    '',
    '## More Info',
    '',
    'Visit https://www.opencastle.dev/ for documentation.',
    '',
  ].join('\n')
}

export interface BuildResult {
  platform: string
  outputDir: string
  skillCount: number
  agentCount: number
}

export function buildPluginPackage(
  pkgRoot: string,
  platform: string,
  outputBase: string,
): BuildResult {
  const config = PLATFORM_CONFIGS[platform]
  if (!config) {
    throw new Error('Unknown platform: ' + platform + '. Valid: ' + Object.keys(PLATFORM_CONFIGS).join(', '))
  }
  const outputDir = resolve(outputBase, config.outputDir)
  mkdirSync(outputDir, { recursive: true })

  const version = readVersion(pkgRoot)
  const allSkills = listSkillDirs(pkgRoot)
  const filteredSkills = getSkillsForPlatform(platform, allSkills)

  if (config.includedDirs.includes('skills')) {
    const skillsOut = join(outputDir, 'skills')
    mkdirSync(skillsOut, { recursive: true })
    const skillsSrc = resolve(pkgRoot, 'src/orchestrator/skills')
    for (const skill of filteredSkills) {
      const src = join(skillsSrc, skill)
      if (existsSync(src)) {
        cpSync(src, join(skillsOut, skill), { recursive: true })
      }
    }
  }

  const agentsSrc = resolve(pkgRoot, 'src/orchestrator/agents')
  const agentFiles = existsSync(agentsSrc)
    ? readdirSync(agentsSrc).filter(f => f.endsWith('.agent.md'))
    : []
  if (config.includedDirs.includes('agents')) {
    const agentsOut = join(outputDir, 'agents')
    mkdirSync(agentsOut, { recursive: true })
    for (const f of agentFiles) {
      cpSync(join(agentsSrc, f), join(agentsOut, f))
    }
  }

  if (config.includedDirs.includes('instructions')) {
    const instrSrc = resolve(pkgRoot, 'src/orchestrator/instructions')
    if (existsSync(instrSrc)) {
      const instrOut = join(outputDir, 'instructions')
      mkdirSync(instrOut, { recursive: true })
      const files = readdirSync(instrSrc).filter(f => f.endsWith('.instructions.md'))
      for (const f of files) {
        cpSync(join(instrSrc, f), join(instrOut, f))
      }
    }
  }

  if (config.includedDirs.includes('prompts')) {
    const promptsSrc = resolve(pkgRoot, 'src/orchestrator/prompts')
    if (existsSync(promptsSrc)) {
      const promptsOut = join(outputDir, 'prompts')
      mkdirSync(promptsOut, { recursive: true })
      const files = readdirSync(promptsSrc).filter(f => f.endsWith('.prompt.md'))
      for (const f of files) {
        cpSync(join(promptsSrc, f), join(promptsOut, f))
      }
    }
  }

  if (config.includedDirs.includes('agent-workflows')) {
    const wfSrc = resolve(pkgRoot, 'src/orchestrator/agent-workflows')
    if (existsSync(wfSrc)) {
      const wfOut = join(outputDir, 'agent-workflows')
      mkdirSync(wfOut, { recursive: true })
      const files = readdirSync(wfSrc).filter(f => f.endsWith('.md'))
      for (const f of files) {
        cpSync(join(wfSrc, f), join(wfOut, f))
      }
    }
  }

  const agentNames = agentFiles.map(f => f.replace('.agent.md', ''))
  const manifest = generateManifest(platform, version, filteredSkills, agentNames)
  writeFileSync(join(outputDir, config.manifestFile), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const entryContent = generateEntryPoint(platform, version, filteredSkills)
  writeFileSync(join(outputDir, config.entryPoint), entryContent, 'utf8')

  const readmeContent = generateReadme(platform, version)
  writeFileSync(join(outputDir, 'README.md'), readmeContent, 'utf8')

  return { platform, outputDir, skillCount: filteredSkills.length, agentCount: agentFiles.length }
}

export default async function packageCmd({ args, pkgRoot }: CliContext): Promise<void> {
  const opts = parseArgs(args)
  if (opts.help) {
    console.log(HELP)
    return
  }

  const platforms = opts.all
    ? Object.keys(PLATFORM_CONFIGS)
    : opts.platform
    ? [opts.platform]
    : null
  if (!platforms) {
    console.error('  ' + c.red('✗') + ' Specify --platform <name> or --all')
    console.log(HELP)
    process.exit(1)
  }

  if (opts.dryRun) {
    console.log(`  [dry-run] Would build packages for: ${platforms.join(', ')}`)
    console.log(`  [dry-run] Output directory: ${resolve(process.cwd(), opts.output)}`)
    return
  }

  const outputBase = resolve(process.cwd(), opts.output)
  const results: BuildResult[] = []
  const errors: string[] = []

  for (const platform of platforms) {
    try {
      console.log('  ' + c.dim('→') + ' Building ' + platform + '...')
      const result = buildPluginPackage(pkgRoot, platform, outputBase)
      results.push(result)
      console.log(
        '  ' + c.green('✓') + ' ' + platform + ': ' +
        result.skillCount + ' skills, ' + result.agentCount + ' agents → ' + result.outputDir
      )
    } catch (err) {
      const msg = (err as Error).message
      errors.push(platform + ': ' + msg)
      console.error('  ' + c.red('✗') + ' ' + platform + ': ' + msg)
    }
  }

  console.log()
  if (errors.length > 0) {
    console.error('  ' + c.red('✗') + ' ' + errors.length + ' platform(s) failed')
    process.exit(1)
  }
  console.log('  ' + c.green('✔') + ' ' + results.length + ' package(s) built in ' + outputBase)
}
