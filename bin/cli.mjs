#!/usr/bin/env node
/* global console, process */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgRoot = resolve(__dirname, '..')

const [, , command, ...args] = process.argv

const HELP = `
  🏰 opencastle — Multi-agent orchestration framework

  Usage:
    npx opencastle <command> [options]

  Project Commands:
    init        Set up OpenCastle in your project
    update      Update framework files (preserves customizations)
    eject       Remove dependency, keep all files standalone
    destroy     Remove ALL OpenCastle files (reverse of init)
    doctor      Validate your OpenCastle setup
    package     Package your OpenCastle project for IDE marketplaces
    skills      Manage and analyze agent skills and failures

  Convoy Commands:
    start       Run the full generate PRD → validate PRD → auto-fix PRD
                → assess complexity → generate convoy spec → validate spec
                → auto-fix spec
    plan        Generate a convoy spec (or PRD) from a task description
    validate    Validate a convoy YAML spec file
    run         Process a task queue from a spec file autonomously

  Observability:
    dashboard   View agent observability dashboard in your browser
    agents      Manage persistent agent identities
    baselines   Manage visual regression baselines
    log         Append a structured event to the observability log
    lesson      Append a structured lesson to LESSONS-LEARNED.md
    artifacts   Manage filesystem artifact storage (prune old convoy artifacts)
    insights    Analyze convoy execution history and generate recommendations

  Options:
    --dry-run        Preview what a command would change without writing files
    --help, -h       Show this help message
    --version, -v    Show version number
`

if (!command || command === '--help' || command === '-h') {
  console.log(HELP)
  process.exit(0)
}

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(
    await readFile(resolve(pkgRoot, 'package.json'), 'utf8')
  )
  console.log(pkg.version)
  process.exit(0)
}

// Handle --version anywhere in args (e.g., "opencastle init --version")
if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(
    await readFile(resolve(pkgRoot, 'package.json'), 'utf8')
  )
  console.log(pkg.version)
  process.exit(0)
}

const commands = {
  init: () => import('../dist/cli/init.js'),
  update: () => import('../dist/cli/update.js'),
  eject: () => import('../dist/cli/eject.js'),
  destroy: () => import('../dist/cli/destroy.js'),
  run: () => import('../dist/cli/run.js'),
  plan: () => import('../dist/cli/plan.js'),
  start: () => import('../dist/cli/pipeline.js'),
  dashboard: () => import('../dist/cli/dashboard.js'),
  doctor: () => import('../dist/cli/doctor.js'),
  log: () => import('../dist/cli/log.js'),
  lesson: () => import('../dist/cli/lesson.js'),
  agents: () => import('../dist/cli/agents.js'),
  baselines: () => import('../dist/cli/baselines.js'),
  validate: () => import('../dist/cli/validate.js'),
  artifacts: () => import('../dist/cli/artifacts-cli.js'),
  insights: () => import('../dist/cli/insights.js'),
  skills: () => import('../dist/cli/skills.js'),
  package: () => import('../dist/cli/package.js'),
}

if (!commands[command]) {
  console.error(
    `  Unknown command: ${command}\n  Run "opencastle --help" for usage.`
  )
  process.exit(1)
}

try {
  const mod = await commands[command]()
  await mod.default({ pkgRoot, args })
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`)
  if (args.includes('--debug')) console.error(err)
  process.exit(1)
}
