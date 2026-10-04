import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { readManifest } from './manifest.js'
import { resolveStack, isEnvVarSatisfied } from './stack-config.js'
import { resolveSources, materialize, hasErrors, formatIssues, requiredEnvVars, refuseOlderCli } from './layers.js'
import { buildLock, type Lock, priorTeam } from './lock.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { PLUGINS } from '../orchestrator/plugins/index.js'
import { c } from './prompt.js'
import { IDE_LABELS, type CliContext, type IdeChoice } from './types.js'
import { COMMAND_NAMESPACE } from './command-namespace.js'
import { isWorkflowTemplate } from './adapters/workflows.js'

/**
 * `opencastle explain`: what a new teammate's assistant is given here, and
 * what they have to do for all of it to work.
 *
 * Onboarding onto a repository's AI setup used to mean reading generated
 * files in whichever format your assistant uses and guessing which of them
 * mattered. This answers it from the same resolution `sync` compiles: what is
 * always loaded and what that costs, which skills exist and when they load,
 * where the team's own content comes from, which MCP servers every assistant
 * can start — and which of those still need a variable set or a sign-in.
 */

const HELP = `
  opencastle explain [options]

  Show what every assistant in this repository is given, where each piece comes
  from (OpenCastle, a baseline, or this project), and what you still need to
  set up — environment variables and sign-ins for the MCP servers.

  Options:
    --all          List OpenCastle's own skills and agents too, not only the team's
    --json         Machine-readable output
    --help, -h     Show this help
`

interface ExplainReport {
  targets: Array<{ id: string; label: string; files: string[] }>
  lock: Lock
  setup: Array<{ server: string; need: string; ok: boolean; how: string }>
  notes: string[]
}

function by(from: string): string {
  if (from === 'opencastle') return 'OpenCastle'
  if (from.startsWith('plugin:')) return `${from.slice(7)} integration`
  return from === 'project' ? 'this project' : from
}

async function build(pkgRoot: string, projectRoot: string): Promise<ExplainReport> {
  const manifest = await readManifest(projectRoot)
  if (!manifest) throw new Error('OpenCastle is not set up here — run opencastle init')
  refuseOlderCli(pkgRoot, manifest.version)
  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter((i): i is string => Boolean(i) && i in IDE_ADAPTERS)
  const stack = resolveStack({ ...manifest, ides })
  const resolved = resolveSources({ pkgRoot, projectRoot, stack, repoInfo: manifest.repoInfo })
  if (hasErrors(resolved)) {
    throw new Error(`the team's sources do not resolve:\n${formatIssues(resolved.issues.filter((i) => i.level === 'error')).join('\n')}`)
  }
  const source = materialize(resolved, pkgRoot, ...priorTeam(projectRoot))
  let lock: Lock
  try {
    lock = buildLock(source, { ides, stack, repoInfo: manifest.repoInfo })
  } finally {
    source.dispose()
  }

  const targets: ExplainReport['targets'] = []
  for (const ide of ides) {
    const adapter = await IDE_ADAPTERS[ide]()
    const paths = adapter.getManagedPaths()
    targets.push({
      id: ide,
      label: IDE_LABELS[ide as IdeChoice] ?? ide,
      files: [...(paths.merged ?? []), ...paths.framework, ...paths.customizable.filter((p) => !p.endsWith('/'))],
    })
  }

  const envFile = existsSync(resolve(projectRoot, '.env')) ? readFileSync(resolve(projectRoot, '.env'), 'utf8') : ''
  const setup: ExplainReport['setup'] = []
  for (const req of requiredEnvVars(resolved, stack, manifest.repoInfo)) {
    setup.push({
      server: req.server,
      need: req.envVar,
      ok: isEnvVarSatisfied(req.envVar, envFile),
      how: req.hint,
    })
  }
  for (const [key, s] of Object.entries(lock.mcp)) {
    if (s.auth === 'oauth') {
      setup.push({ server: key, need: 'sign-in', ok: true, how: 'your assistant opens a browser to sign in the first time it starts the server' })
    }
  }
  // Codex loads a project's `.codex/config.toml` only once the user has
  // trusted the project, so every server written there waits on that.
  if (ides.includes('codex') && Object.keys(lock.mcp).length > 0) {
    setup.push({
      server: 'Codex CLI',
      need: 'trust',
      ok: codexTrusts(projectRoot),
      how: 'Codex reads .codex/config.toml, and so every MCP server here, only in a project you trust — run codex in this directory and trust it when it asks',
    })
  }
  const notes = resolved.issues.filter((i) => i.level === 'warning').map((i) => `${i.where}: ${i.message}`)
  return { targets, lock, setup, notes }
}

/**
 * Whether Codex has been told to trust this project: `trust_level = "trusted"`
 * under `[projects."<path>"]` in its own config, `$CODEX_HOME/config.toml`.
 */
export function codexTrusts(projectRoot: string): boolean {
  const file = join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex'), 'config.toml')
  let projects: Record<string, { trust_level?: unknown }>
  try {
    projects = ((parseToml(readFileSync(file, 'utf8')) as { projects?: Record<string, { trust_level?: unknown }> }).projects ?? {})
  } catch {
    return false
  }
  const spellings = new Set([projectRoot])
  try {
    spellings.add(realpathSync(projectRoot))
  } catch {
    // The path as given is the only spelling there is.
  }
  return [...spellings].some((p) => projects[p]?.trust_level === 'trusted')
}

function render(report: ExplainReport, all: boolean): void {
  const { lock } = report
  const out = (s = ''): void => console.log(s)
  out(`\n  🏰 ${c.bold('What the AI assistants in this repository are given')}\n`)

  const layers = lock.layers.map((l) => (l.kind === 'core' ? `OpenCastle ${l.version}` : l.kind === 'project' ? 'this project' : `${l.id}${l.version ? ` ${l.version}` : ''}`))
  out(`  ${c.bold('Layers')}  ${layers.join(c.dim(' → '))}  ${c.dim('(later layers add to and override earlier ones)')}`)
  out(`  ${c.bold('Targets')} ${report.targets.map((t) => t.label).join(', ')}`)
  out('')

  const entries = Object.entries(lock.content)
  const ofKind = (kind: string) => entries.filter(([ref]) => ref.startsWith(`${kind}/`))
  const required = new Set(lock.policy?.require ?? [])
  const tag = (ref: string, from: string, overrides?: string): string => {
    const bits = [by(from)]
    if (overrides) bits.push(`replaces ${by(overrides)}'s`)
    if (required.has(ref)) bits.push('required')
    return c.dim(`(${bits.join(', ')})`)
  }

  out(`  ${c.bold('Always loaded')} ${c.dim(`— ~${lock.context.tokens} tokens before every task: instructions ~${lock.context.instructions}, the skill and agent index ~${lock.context.index}`)}`)
  for (const [ref, item] of ofKind('instructions')) {
    out(`    ${c.dim('•')} ${ref.slice(13)} ${c.dim(`~${item.tokens ?? 0} tokens`)} ${tag(ref, item.from, item.overrides)}`)
  }
  if (lock.policy?.contextBudget) out(`    ${c.dim(`budget: ${lock.policy.contextBudget} tokens`)}`)
  out('')

  // Where a prompt is a command someone types, and under which name.
  const hasClaude = report.targets.some((t) => t.id === 'claude-code')
  const typedIn = [
    ...(hasClaude ? ['Claude Code'] : []),
    ...(report.targets.some((t) => t.id === 'vscode') ? ['Copilot'] : []),
  ]
  for (const kind of ['skills', 'agents', 'prompts', 'workflows'] as const) {
    // The shared delivery phase is compiled into every template, not run on its own.
    const items = ofKind(kind).filter(([ref]) => kind !== 'workflows' || isWorkflowTemplate(`${ref.slice(kind.length + 1)}.md`))
    if (items.length === 0) continue
    const team = items.filter(([, i]) => i.from !== 'opencastle' && !i.from.startsWith('plugin:'))
    const integrations = items.filter(([, i]) => i.from.startsWith('plugin:'))
    const core = items.filter(([, i]) => i.from === 'opencastle')
    const title = {
      skills: 'Skills — loaded when a task matches the description',
      agents: 'Agents — personas to delegate to',
      prompts: typedIn.length > 0 ? `Commands — /${COMMAND_NAMESPACE}:<name> in ${typedIn.join(' and ')}` : 'Prompts',
      workflows: hasClaude ? `Workflows — /${COMMAND_NAMESPACE}:workflow-<name> in Claude Code` : 'Workflows',
    }[kind]
    out(`  ${c.bold(title)} ${c.dim(`(${items.length})`)}`)
    for (const [ref, item] of [...team, ...integrations, ...(all ? core : [])]) {
      const name = ref.slice(kind.length + 1)
      out(`    ${c.dim('•')} ${c.bold(name)} ${tag(ref, item.from, item.overrides)}${item.description ? `\n      ${c.dim(item.description)}` : ''}`)
    }
    if (!all && core.length > 0) {
      out(`    ${c.dim('•')} ${c.dim(`and ${core.length} from OpenCastle: ${core.map(([r]) => r.slice(kind.length + 1)).join(', ')}`)}`)
    }
    out('')
  }
  if (lock.excluded) {
    out(`  ${c.bold('Left out')}`)
    for (const [ref, who] of Object.entries(lock.excluded)) out(`    ${c.dim('•')} ${ref} ${c.dim(`(excluded by ${by(who)})`)}`)
    out('')
  }

  const servers = Object.entries(lock.mcp)
  out(`  ${c.bold('MCP servers')} ${c.dim(`— tools every assistant can start (${servers.length})`)}`)
  for (const [key, s] of servers) {
    const what = s.transport === 'http' ? `remote: ${s.launch}` : `runs: ${s.launch}`
    const plugin = s.from.startsWith('plugin:') ? PLUGINS[s.from.slice(7)] : undefined
    out(`    ${c.dim('•')} ${c.bold(key)} ${c.dim(`(${by(s.from)})`)}\n      ${c.dim(what)}${plugin?.officialDocs ? `\n      ${c.dim(`docs: ${plugin.officialDocs}`)}` : ''}`)
  }
  if (lock.blocked) {
    for (const [key, why] of Object.entries(lock.blocked)) out(`    ${c.yellow('–')} ${key} ${c.dim(`not written: ${why}`)}`)
  }
  out('')

  if (lock.policy) {
    out(`  ${c.bold("The team's policy")}`)
    const p = lock.policy
    // Per layer: a server must be on every list, so a union would overstate it.
    if (p.allow) {
      out(`    ${c.dim('•')} MCP servers must be on every one of these allowlists:`)
      for (const [who, list] of Object.entries(p.allow)) out(`        ${c.dim(`${by(who)}:`)} ${list.join(', ')}`)
    }
    if (p.remoteHosts) {
      out(`    ${c.dim('•')} Remote servers may only reach hosts every one of these allows:`)
      for (const [who, list] of Object.entries(p.remoteHosts)) out(`        ${c.dim(`${by(who)}:`)} ${list.join(', ')}`)
    }
    if (p.requirePinned) out(`    ${c.dim('•')} Every local server must be pinned to an exact version (${p.requirePinned})`)
    if (p.require) out(`    ${c.dim('•')} Required everywhere: ${p.require.join(', ')}`)
    if (p.opencastle) out(`    ${c.dim('•')} OpenCastle version: ${Object.values(p.opencastle).join(' and ')}`)
    out('')
  }

  out(`  ${c.bold('Your setup')}`)
  if (report.setup.length === 0) out(`    ${c.green('✓')} Nothing to set up — every server works without a variable or a sign-in.`)
  for (const s of report.setup) {
    if (s.need === 'sign-in') out(`    ${c.cyan('→')} ${s.server}: ${s.how}`)
    else if (s.need === 'trust') out(`    ${s.ok ? c.green('✓') : c.red('✗')} ${s.ok ? 'Codex trusts this project' : 'Codex does not trust this project yet'} ${c.dim(`— ${s.how}`)}`)
    else out(`    ${s.ok ? c.green('✓') : c.red('✗')} ${s.need} ${c.dim(`— ${s.how}${s.ok ? '' : '; set it in .env or your shell'}`)}`)
  }
  out('')
  for (const t of report.targets) out(`  ${c.dim(`${t.label}: ${t.files.join(', ')}`)}`)
  if (report.notes.length > 0) {
    out('')
    for (const n of report.notes) out(`  ${c.yellow('!')} ${c.dim(n)}`)
  }
  out('')
}

export default async function explain({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }
  let report: ExplainReport
  try {
    report = await build(pkgRoot, process.cwd())
  } catch (err) {
    console.error(`\n  ${c.red('✗')} Cannot explain: ${(err as Error).message}\n`)
    process.exit(1)
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  render(report, args.includes('--all'))
}
