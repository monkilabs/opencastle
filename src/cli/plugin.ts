import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  AGENT_PLUGINS_VERSION,
  EXTENSION_NAMESPACE,
  claudeManifestFor,
  claudeMcpFor,
  isAgentPlugin,
  pluginNameFrom,
  readAgentPlugin,
  type PluginReport,
} from './agent-plugin.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * `opencastle plugin`: check, complete and list Agent Plugins.
 *
 * The standard leaves two things to each client: Claude Code reads its own
 * manifest (`.claude-plugin/plugin.json`) and its own MCP file (`.mcp.json`),
 * and every client indexes a marketplace in its own file. Keeping those by hand
 * is three copies of one fact, which is the drift this tool exists to stop —
 * so they are compiled from the portable files and checked in CI like any
 * other generated output.
 */

const HELP = `
  opencastle plugin <check|build|index> [dir] [options]

  Agent Plugins 1.0 is the open package format for skills and MCP servers
  (agent-plugins.org): plugin.json, skills/<name>/SKILL.md and mcp.json.
  GitHub Copilot, VS Code, Cursor, Codex and Kiro install one as it is.

  check [dir]   Check a plugin the way a conformant client loads it: the
                manifest, every skill against the Agent Skills spec, every
                MCP server, and that Claude Code's files match the portable ones.
  build [dir]   Write Claude Code's .claude-plugin/plugin.json and .mcp.json
                from plugin.json and mcp.json. Claude Code reads only those.
  index [dir]   Write the marketplace files for every plugin under plugins/:
                .claude-plugin/marketplace.json (Claude Code, Copilot CLI),
                .cursor-plugin/marketplace.json (Cursor) and
                .agents/plugins/marketplace.json (Codex).

  Options:
    --check         build and index: change nothing; exit 1 if a file is out of date
    --name <name>   index: the marketplace name (default: from package.json or the directory)
    --owner <name>  index: who maintains it (default: from package.json)
    --json          check: machine-readable output
    --help, -h      Show this help
`

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── build ─────────────────────────────────────────────────────

/**
 * What Claude Code's two files should hold, as path → text, or `null` for a
 * file that should not exist.
 *
 * `.claude-plugin/plugin.json` is co-owned: the portable fields are compiled
 * in, and anything only Claude Code reads — `userConfig`, `hooks`, `agents`,
 * inline `mcpServers` — is the author's and kept. `.mcp.json` is compiled
 * whole from `mcp.json` when the plugin has portable servers; a server only
 * Claude Code should start belongs inline in the manifest.
 */
export function claudeFiles(root: string, report: PluginReport): Record<string, string | null> {
  if (!report.manifest) return {}
  const manifestPath = join(root, '.claude-plugin', 'plugin.json')
  const existing = readJsonFile(manifestPath) ?? {}
  const generated = claudeManifestFor(report.manifest)
  const portable = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !portable.includes(k)))
  const files: Record<string, string | null> = { '.claude-plugin/plugin.json': json({ ...generated, ...kept }) }
  // With no portable servers there is nothing to compile, and a `.mcp.json`
  // already there is one the author wrote for Claude Code alone.
  if (Object.keys(report.servers).length > 0) files['.mcp.json'] = json(claudeMcpFor(report.servers))
  return files
}

/** Write (or with `check`, compare) a set of generated files. Returns the ones that differ. */
function apply(root: string, files: Record<string, string | null>, check: boolean): string[] {
  const changed: string[] = []
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if (current === text) continue
    changed.push(rel)
    if (check) continue
    if (text === null) rmSync(abs, { force: true })
    else {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    }
  }
  return changed
}

// ── index ─────────────────────────────────────────────────────

interface Listed {
  dir: string
  name: string
  description?: string
  claude: boolean
}

function marketplaceIdentity(root: string, nameFlag?: string, ownerFlag?: string): { name: string; owner: string; description: string } {
  const pkg = readJsonFile(join(root, 'package.json')) ?? {}
  const pkgName = typeof pkg.name === 'string' ? pkg.name : undefined
  const author = pkg.author
  const authorName = typeof author === 'string' ? author.replace(/\s*[<(].*$/, '') : author && typeof author === 'object' ? (author as { name?: string }).name : undefined
  const name = nameFlag ?? pluginNameFrom(pkgName ?? basename(resolve(root)))
  return {
    name,
    owner: ownerFlag ?? authorName ?? name,
    description: typeof pkg.description === 'string' ? pkg.description : `Agent Plugins from ${name}`,
  }
}

/** The three marketplace files for the plugins under `plugins/`. */
export function marketplaceFiles(
  plugins: Listed[],
  identity: { name: string; owner: string; description: string },
): Record<string, string> {
  const entries = plugins.map((p) => ({
    name: p.name,
    source: `./plugins/${p.dir}`,
    ...(p.description && { description: p.description }),
  }))
  // One shape both read: Cursor's schema is a strict subset of Claude Code's.
  const shared = json({
    name: identity.name,
    owner: { name: identity.owner },
    metadata: { description: identity.description },
    plugins: entries,
  })
  const codex = json({
    name: identity.name,
    interface: { displayName: identity.name },
    plugins: plugins.map((p) => ({
      name: p.name,
      source: { source: 'local', path: `./plugins/${p.dir}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    })),
  })
  return {
    '.claude-plugin/marketplace.json': shared,
    '.cursor-plugin/marketplace.json': shared,
    '.agents/plugins/marketplace.json': codex,
  }
}

function listPlugins(root: string): { plugins: Listed[]; problems: string[] } {
  const dir = join(root, 'plugins')
  const plugins: Listed[] = []
  const problems: string[] = []
  if (!existsSync(dir)) return { plugins, problems: [`${relative(process.cwd(), dir) || 'plugins'}/ does not exist — a marketplace lists plugins/<name>/`] }
  for (const entry of readdirSync(dir).sort()) {
    const at = join(dir, entry)
    if (!existsSync(join(at, 'plugin.json'))) continue
    if (!isAgentPlugin(at)) {
      problems.push(`plugins/${entry}: plugin.json does not declare an Agent Plugins version — run opencastle plugin check plugins/${entry}`)
      continue
    }
    const report = readAgentPlugin(at)
    if (!report.manifest) {
      problems.push(`plugins/${entry}: ${report.errors[0]}`)
      continue
    }
    plugins.push({
      dir: entry,
      name: report.manifest.name,
      description: report.manifest.description,
      claude: existsSync(join(at, '.claude-plugin', 'plugin.json')),
    })
  }
  const names = new Map<string, string>()
  for (const p of plugins) {
    const other = names.get(p.name)
    if (other) problems.push(`plugins/${p.dir} and plugins/${other} are both named "${p.name}"; a marketplace lists a name once`)
    names.set(p.name, p.dir)
  }
  return { plugins, problems }
}

// ── command ───────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  if (at === -1) return undefined
  const v = args[at + 1]
  if (!v || v.startsWith('--')) {
    console.error(`  ${c.red('✗')} ${flag} needs a value`)
    process.exit(1)
  }
  return v
}

function printReport(dir: string, report: PluginReport, claudeStale: string[]): void {
  const m = report.manifest
  console.log(`\n  🏰 ${c.bold('Agent Plugin')} ${m?.name ?? dir}${m?.version ? c.dim(` ${m.version}`) : ''}${report.version ? c.dim(` · Agent Plugins ${report.version}`) : ''}\n`)
  if (m) {
    console.log(`  Skills: ${report.skills.length > 0 ? report.skills.join(', ') : c.dim('none')}`)
    console.log(`  MCP servers: ${Object.keys(report.servers).length > 0 ? Object.keys(report.servers).join(', ') : c.dim('none')}`)
    if (existsSync(join(report.root, EXTENSION_NAMESPACE))) {
      console.log(`  ${EXTENSION_NAMESPACE}/: ${c.dim('OpenCastle content — check it with opencastle baseline check')}`)
    }
  }
  for (const e of report.errors) console.log(`  ${c.red('✗')} ${e}`)
  for (const s of claudeStale) console.log(`  ${c.red('✗')} ${s} does not match plugin.json and mcp.json ${c.dim('— run opencastle plugin build')}`)
  for (const w of report.warnings) console.log(`  ${c.yellow('!')} ${c.dim(w)}`)
  if (report.errors.length === 0 && claudeStale.length === 0) {
    console.log(`\n  ${c.green('✓')} Loads in GitHub Copilot, VS Code, Cursor, Codex and Kiro as it is` +
      (existsSync(join(report.root, '.claude-plugin', 'plugin.json')) ? ', and in Claude Code.\n' : `.\n  ${c.dim('Run opencastle plugin build to add the files Claude Code reads.')}\n`))
  } else {
    console.log(`\n  ${c.red(`${report.errors.length + claudeStale.length} problem(s) to fix.`)}\n`)
  }
}

/** Claude Code's files that exist and no longer match the portable ones. */
export function staleClaudeFiles(root: string, report: PluginReport): string[] {
  if (!existsSync(join(root, '.claude-plugin', 'plugin.json')) && !existsSync(join(root, '.mcp.json'))) return []
  return apply(root, claudeFiles(root, report), true)
}

export default async function plugin({ args }: CliContext): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || args.includes('--help') || args.includes('-h') || !['check', 'build', 'index'].includes(sub)) {
    console.log(HELP)
    if (sub && !['check', 'build', 'index', '--help', '-h'].includes(sub)) process.exit(1)
    return
  }
  const valued = new Set(['--name', '--owner'])
  const positional = rest.filter((a, i) => !a.startsWith('--') && !valued.has(rest[i - 1]))
  const dir = positional[0] ?? '.'
  const root = resolve(dir)
  const check = rest.includes('--check')

  if (sub === 'check') {
    const report = readAgentPlugin(root)
    const stale = report.manifest ? staleClaudeFiles(root, report) : []
    if (rest.includes('--json')) {
      console.log(json({ ...report, root: dir, claudeOutOfDate: stale, spec: AGENT_PLUGINS_VERSION }))
    } else {
      printReport(dir, report, stale)
    }
    if (report.errors.length > 0 || stale.length > 0) process.exit(1)
    return
  }

  if (sub === 'build') {
    const report = readAgentPlugin(root)
    if (!report.manifest) {
      for (const e of report.errors) console.error(`  ${c.red('✗')} ${e}`)
      process.exit(1)
    }
    const changed = apply(root, claudeFiles(root, report), check)
    if (check) {
      if (changed.length > 0) {
        for (const f of changed) console.error(`  ${c.red('✗')} ${f} does not match plugin.json and mcp.json — run opencastle plugin build`)
        process.exit(1)
      }
      console.log(`  ${c.green('✓')} Claude Code's files match plugin.json and mcp.json`)
      return
    }
    console.log(changed.length > 0 ? `  ${c.green('✓')} Wrote ${changed.join(', ')}` : `  ${c.green('✓')} Claude Code's files were already up to date`)
    return
  }

  // index
  const { plugins, problems } = listPlugins(root)
  for (const p of problems) console.error(`  ${c.red('✗')} ${p}`)
  if (problems.length > 0) process.exit(1)
  if (plugins.length === 0) {
    console.error(`  ${c.red('✗')} no Agent Plugin under ${dir}/plugins/ — each is a directory with a plugin.json`)
    process.exit(1)
  }
  const identity = marketplaceIdentity(root, flagValue(rest, '--name'), flagValue(rest, '--owner'))
  const changed = apply(root, marketplaceFiles(plugins, identity), check)
  const noClaude = plugins.filter((p) => !p.claude)
  if (check) {
    if (changed.length > 0) {
      for (const f of changed) console.error(`  ${c.red('✗')} ${f} does not list the plugins under plugins/ — run opencastle plugin index`)
      process.exit(1)
    }
    console.log(`  ${c.green('✓')} The marketplace files list all ${plugins.length} plugin(s)`)
    return
  }
  console.log(
    changed.length > 0
      ? `  ${c.green('✓')} Listed ${plugins.length} plugin(s) in ${changed.join(', ')}`
      : `  ${c.green('✓')} The marketplace files already list all ${plugins.length} plugin(s)`,
  )
  if (noClaude.length > 0) {
    console.log(`  ${c.yellow('!')} ${noClaude.map((p) => `plugins/${p.dir}`).join(', ')} ${c.dim('— Claude Code needs .claude-plugin/plugin.json; run opencastle plugin build in each')}`)
  }
  console.log(`  ${c.dim(`Add it: claude plugin marketplace add <owner>/<repo>, copilot plugin marketplace add <owner>/<repo>, codex plugin marketplace add <owner>/<repo>; in Cursor, Dashboard → Plugins → Team Marketplaces → Import.`)}`)
}
