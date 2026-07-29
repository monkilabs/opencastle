#!/usr/bin/env node
/* global console, process */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgRoot = resolve(__dirname, '..')

const [, , command, ...args] = process.argv

// node:sqlite is still flagged experimental and prints a warning on import. It is
// an implementation detail of the convoy store, so it should not appear in the
// output of a status or sync run. Other warnings pass through untouched.
// Node installs its own warning printer at startup, so replace it rather than
// adding a second listener.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
  console.error(`${warning.name}: ${warning.message}`)
})

const HELP = `
  🏰 opencastle — compile your AI assistant config for every assistant

  Usage:
    npx opencastle <command> [options]

  Commands:
    (none)      Show project status and what to do next
    init        Set up this project (detects your stack and existing config)
    sync        Recompile the generated config for every target
    add         Add an integration, e.g. "add supabase"
    doctor      Diagnose setup problems
    remove      Remove OpenCastle from this project

  Experimental:
    convoy      Run multi-step work through the convoy engine

  Options:
    --dry-run        Preview changes without writing files
    --yes            Skip confirmation prompts
    --json           Machine-readable output where supported
    --help, -h       Show help for a command
    --version, -v    Show version number

  Run "opencastle <command> --help" for command-specific options.
`

/**
 * Commands shown in help. Everything a human is expected to run lives here.
 */
const VISIBLE = {
  init: () => import('../dist/cli/init.js'),
  sync: () => import('../dist/cli/sync.js'),
  add: () => import('../dist/cli/add.js'),
  doctor: () => import('../dist/cli/doctor.js'),
  remove: () => import('../dist/cli/remove.js'),
  convoy: () => import('../dist/cli/convoy-cmd.js'),
}

/**
 * Reachable but deliberately absent from help.
 *
 * `log` and `lesson` are called by agents from generated instructions, not by
 * people — listing them taught users a vocabulary they never needed. `update`
 * is the pre-rename name of `sync`, kept so existing scripts keep working.
 */
const HIDDEN = {
  log: () => import('../dist/cli/log.js'),
  lesson: () => import('../dist/cli/lesson.js'),
  update: () => import('../dist/cli/sync.js'),
}

/**
 * Commands that were removed, mapped to what replaces them. Kept as a lookup so
 * anyone with the old command in a script gets a pointer instead of "unknown".
 */
const REPLACED = {
  eject: 'opencastle remove --keep-files',
  destroy: 'opencastle remove --all',
  run: 'opencastle convoy run',
  plan: 'opencastle convoy "<task>"',
  start: 'opencastle convoy "<task>"',
  validate: 'opencastle convoy run  (validation is automatic)',
  dashboard: 'opencastle convoy dashboard',
  insights: null,
  artifacts: null,
  agents: null,
  baselines: null,
  skills: null,
  package: null,
  dispute: null,
}

const commands = { ...VISIBLE, ...HIDDEN }

// No command is itself a command: report state and the next step. A leading flag
// belongs to it too — `opencastle --json` is documented in the help text, in
// status's own help, and on the website, and used to answer "Unknown command".
if (!command || command.startsWith('-')) {
  const bare = ['--json', '--help', '-h']
  if (!command || bare.includes(command)) {
    if (command === '--help' || command === '-h') {
      console.log(HELP)
      process.exit(0)
    }
    // Same try/catch as every other command. This path sat outside it, so the
    // one command users run most — the bare `opencastle` — answered an
    // unreadable manifest with a raw Node stack trace, while `doctor` on the
    // same project printed a one-line "✗ EACCES: …".
    try {
      const mod = await import('../dist/cli/status.js')
      await mod.default({ pkgRoot, args: command ? [command, ...args] : [] })
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`)
      if (args.includes('--debug')) console.error(err)
      process.exit(1)
    }
    process.exit(0)
  }
}

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(HELP)
  process.exit(0)
}

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(await readFile(resolve(pkgRoot, 'package.json'), 'utf8'))
  console.log(pkg.version)
  process.exit(0)
}

// Handle --version anywhere in args (e.g. "opencastle init --version")
if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(await readFile(resolve(pkgRoot, 'package.json'), 'utf8'))
  console.log(pkg.version)
  process.exit(0)
}

if (!commands[command]) {
  if (command in REPLACED) {
    const replacement = REPLACED[command]
    console.error(`\n  "${command}" has been removed.`)
    if (replacement) {
      console.error(`  Use instead: ${replacement}\n`)
    } else {
      console.error(`  Run "opencastle --help" to see the current commands.\n`)
    }
    process.exit(1)
  }
  console.error(`\n  Unknown command: ${command}`)
  console.error(`  Run "opencastle --help" for usage.\n`)
  process.exit(1)
}

try {
  const mod = await commands[command]()
  await mod.default({ pkgRoot, args })
} catch (err) {
  // Node puts the path on the error object but not always in the message —
  // `EISDIR` in particular reads "illegal operation on a directory, read" with
  // nothing to act on. Every guarded reader in the codebase prefixes the
  // filename for that reason; this is the catch-all for the ones that throw.
  const where = err.path && !String(err.message).includes(err.path) ? ` (${err.path})` : ''
  console.error(`\n  ✗ ${err.message}${where}\n`)
  if (args.includes('--debug')) console.error(err)
  process.exit(1)
}
