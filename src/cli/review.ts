import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readManifest } from './manifest.js'
import { resolveStack } from './stack-config.js'
import { resolveSources, materialize, hasErrors, formatIssues, refuseOlderCli } from './layers.js'
import { buildLock, parseLock, serializeLock, LOCK_REL, type Lock, type LockServer, priorTeam } from './lock.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * `opencastle review`: what a change to the team's AI config *means*.
 *
 * One edit to a baseline regenerates dozens of files in seven formats. The diff
 * a reviewer is shown is that regeneration, and nobody reads a hundred lines of
 * generated Markdown to find the one line that matters — the new MCP server
 * every developer's agent can now start with their credentials, or the rule
 * that quietly stopped applying. This reads the lock at the base and at the
 * head and says, in sentences, what every assistant gains, loses and now does
 * differently, with what deserves a careful look marked as such.
 */

const HELP = `
  npx opencastle review [options]

  Explain what a change to the AI assistant config does: which skills, agents,
  instructions and MCP servers every assistant gains, loses or gets changed,
  which baselines moved, what the team's policy now allows, and how much more
  context every assistant loads. Reads .opencastle/lock.json at the base and
  compares it with what the current sources compile to.

  Options:
    --base <ref>   What to compare against (default: HEAD; on a GitHub Actions
                   pull request, origin/<base branch>)
    --markdown     Print Markdown, e.g. for a pull request comment
    --json         Machine-readable output
    --help, -h     Show this help

  On GitHub Actions the Markdown is also added to the job summary.
`

export type Attention = 'review' | 'info'

export interface ReviewLine {
  /** Grouping for rendering. */
  section: 'layers' | 'targets' | 'content' | 'mcp' | 'policy' | 'context'
  text: string
  /** `review` marks what a reviewer should look at closely. */
  level: Attention
}

export interface ReviewReport {
  base: string
  firstLock: boolean
  lines: ReviewLine[]
  /** Set when the committed lock is not what the sources compile to. */
  staleLock?: boolean
}

const KIND_LABEL: Record<string, [string, string]> = {
  skills: ['skill', 'skills'],
  agents: ['agent', 'agents'],
  instructions: ['always-loaded instruction', 'always-loaded instructions'],
  prompts: ['prompt', 'prompts'],
  workflows: ['workflow', 'workflows'],
}

function splitRef(ref: string): [string, string] {
  const at = ref.indexOf('/')
  return [ref.slice(0, at), ref.slice(at + 1)]
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** `npx -y pkg@1.2.3` and `npx -y pkg@1.3.0` are the same server, upgraded. */
function sameServerNewVersion(a: LockServer, b: LockServer): [string, string] | null {
  if (a.transport !== 'stdio' || b.transport !== 'stdio') return null
  const re = /((?:@[^\s/@]+\/)?[^\s@]+)@(\d[^\s]*)/
  const ma = re.exec(a.launch)
  const mb = re.exec(b.launch)
  if (!ma || !mb || ma[1] !== mb[1]) return null
  if (a.launch.replace(ma[0], '') !== b.launch.replace(mb[0], '')) return null
  return [ma[2], mb[2]]
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/\$\{[^}]*\}/g, 'x')).host
  } catch {
    return url
  }
}

function describeServer(s: LockServer): string {
  const where = s.transport === 'http' ? `remote, ${hostOf(s.launch)}` : `runs \`${s.launch}\``
  const env = s.env?.length ? `; reads ${s.env.join(', ')}` : ''
  return `${where}${env}`
}

function origin(from: string): string {
  if (from.startsWith('plugin:')) return `the ${from.slice(7)} integration`
  if (from === 'opencastle') return 'OpenCastle'
  return from === 'project' ? 'this project' : from
}

/**
 * A project's first lock, summarised. Listing every item as "new" produced a
 * hundred lines on the upgrade that introduced the lock, with OpenCastle's own
 * instructions flagged for review — noise that trains people to skip the
 * summary. What is worth reading is what is not OpenCastle's.
 */
function firstLockSummary(head: Lock): ReviewLine[] {
  const lines: ReviewLine[] = []
  const add = (section: ReviewLine['section'], text: string, level: Attention = 'info'): void => {
    lines.push({ section, text, level })
  }
  for (const l of head.layers) {
    if (l.kind === 'baseline') add('layers', `Extends ${l.id}${l.version ? ` ${l.version}` : ''}`, 'review')
  }
  const own = Object.entries(head.content).filter(([, i]) => i.from !== 'opencastle' && !i.from.startsWith('plugin:'))
  for (const [ref, item] of own) {
    const [kind, name] = splitRef(ref)
    add('content', `${KIND_LABEL[kind]?.[0] ?? kind} **${name}** from ${origin(item.from)}`, kind === 'instructions' ? 'review' : 'info')
  }
  const core = Object.keys(head.content).length - own.length
  add('content', own.length > 0 ? `and ${core} item(s) from OpenCastle and its integrations` : `${core} item(s) from OpenCastle and its integrations`)
  for (const [key, s] of Object.entries(head.mcp)) {
    add('mcp', `MCP server **${key}** from ${origin(s.from)} — ${describeServer(s)}`, s.from.startsWith('plugin:') ? 'info' : 'review')
  }
  add('context', `Every assistant loads ~${head.context.tokens} tokens before the task`)
  return lines
}

/** Compare two locks. `base` null means the project had none — its first lock. */
export function diffLocks(base: Lock | null, head: Lock): ReviewLine[] {
  if (!base) return firstLockSummary(head)
  const lines: ReviewLine[] = []
  const add = (section: ReviewLine['section'], text: string, level: Attention = 'info'): void => {
    lines.push({ section, text, level })
  }
  const b: Lock = base ?? {
    lockfileVersion: head.lockfileVersion,
    opencastle: head.opencastle,
    targets: [],
    integrations: [],
    layers: [],
    content: {},
    mcp: {},
    context: { tokens: 0, instructions: 0, index: 0 },
  }

  // ── Layers ──────────────────────────────────────────────────
  if (base && b.opencastle !== head.opencastle) add('layers', `OpenCastle ${b.opencastle} → ${head.opencastle}`)
  const bl = new Map(b.layers.map((l) => [l.id, l]))
  const hl = new Map(head.layers.map((l) => [l.id, l]))
  for (const [id, l] of hl) {
    if (l.kind === 'core') continue
    const was = bl.get(id)
    if (!was) {
      if (l.kind === 'baseline') add('layers', `Now extends ${id}${l.version ? ` ${l.version}` : ''}`, 'review')
      continue
    }
    if (was.version !== l.version) add('layers', `${id} ${was.version ?? '?'} → ${l.version ?? '?'}`)
    else if (was.integrity && l.integrity && was.integrity !== l.integrity) {
      add('layers', `${id} changed without a version change — its contents are not what ${l.version ?? 'this version'} was`, 'review')
    }
  }
  for (const [id, l] of bl) {
    if (l.kind === 'baseline' && !hl.has(id)) add('layers', `No longer extends ${id}`, 'review')
  }

  // ── Targets and integrations ────────────────────────────────
  const gainedT = head.targets.filter((t) => !b.targets.includes(t))
  const lostT = b.targets.filter((t) => !head.targets.includes(t))
  if (base && gainedT.length) add('targets', `Now also compiled for ${list(gainedT)}`)
  if (lostT.length) add('targets', `No longer compiled for ${list(lostT)}`)
  const gainedI = head.integrations.filter((t) => !b.integrations.includes(t))
  const lostI = b.integrations.filter((t) => !head.integrations.includes(t))
  if (gainedI.length) add('targets', `Integrations added: ${list(gainedI)}`)
  if (lostI.length) add('targets', `Integrations removed: ${list(lostI)}`)

  // ── Content ─────────────────────────────────────────────────
  const excludedNow = head.excluded ?? {}
  const required = new Set(b.policy?.require ?? [])
  for (const [ref, item] of Object.entries(head.content)) {
    const was = b.content[ref]
    const [kind, name] = splitRef(ref)
    const label = KIND_LABEL[kind]?.[0] ?? kind
    if (!was) {
      const desc = item.description ? ` — ${item.description}` : ''
      const tokens = item.tokens ? ` (~${item.tokens} tokens, loaded on every request)` : ''
      add('content', `New ${label} **${name}** from ${origin(item.from)}${tokens}${desc}`, kind === 'instructions' ? 'review' : 'info')
      continue
    }
    if (was.from !== item.from) {
      add(
        'content',
        `${label} **${name}** now comes from ${origin(item.from)} (was ${origin(was.from)})`,
        required.has(ref) ? 'review' : 'info',
      )
    } else if (was.sha !== item.sha) {
      const delta = item.tokens !== undefined && was.tokens !== undefined && item.tokens !== was.tokens
        ? ` (~${was.tokens} → ~${item.tokens} tokens)`
        : ''
      add('content', `${label} **${name}** changed${delta} — ${origin(item.from)}`, kind === 'instructions' ? 'review' : 'info')
    }
  }
  for (const [ref, was] of Object.entries(b.content)) {
    if (head.content[ref]) continue
    const [kind, name] = splitRef(ref)
    const label = KIND_LABEL[kind]?.[0] ?? kind
    const by = excludedNow[ref]
    add(
      'content',
      `${label} **${name}** removed${by ? ` — excluded by ${origin(by)}` : ''} (was from ${origin(was.from)})`,
      required.has(ref) ? 'review' : 'info',
    )
  }

  // ── MCP ─────────────────────────────────────────────────────
  for (const [key, s] of Object.entries(head.mcp)) {
    const was = b.mcp[key]
    if (!was) {
      // Every new server is code an agent runs with a developer's credentials.
      add('mcp', `New MCP server **${key}** from ${origin(s.from)} — ${describeServer(s)}`, 'review')
      continue
    }
    if (was.launch === s.launch && was.transport === s.transport) {
      const bEnv = (was.env ?? []).join(',')
      const hEnv = (s.env ?? []).join(',')
      if (bEnv !== hEnv) add('mcp', `MCP server **${key}** now reads ${s.env?.length ? s.env.join(', ') : 'no variables'}`, 'review')
      else if (was.sha !== s.sha) {
        add('mcp', `MCP server **${key}** has different settings — its environment or headers changed (${origin(s.from)})`, 'review')
      }
      continue
    }
    const bump = sameServerNewVersion(was, s)
    if (bump) add('mcp', `MCP server **${key}**: ${bump[0]} → ${bump[1]}`)
    else add('mcp', `MCP server **${key}** now ${describeServer(s)} (was: ${describeServer(was)})`, 'review')
  }
  for (const [key, was] of Object.entries(b.mcp)) {
    if (head.mcp[key]) continue
    const blocked = head.blocked?.[key]
    add('mcp', `MCP server **${key}** removed${blocked ? ` — ${blocked}` : ''} (was from ${origin(was.from)})`)
  }

  // ── Policy ──────────────────────────────────────────────────
  // Per layer, because that is how it applies: a server must be on every
  // layer's list. A union of the lists read as "still allowed" after the one
  // list that actually restricted something was dropped.
  const bp = b.policy ?? {}
  const hp = head.policy ?? {}
  const perLayer = (
    before: Record<string, string[]> | undefined,
    after: Record<string, string[]> | undefined,
    what: { noun: string; gone: string; now: string },
  ): void => {
    for (const [by, was] of Object.entries(before ?? {})) {
      const now = after?.[by]
      if (!now) {
        add('policy', `${origin(by)} no longer restricts ${what.gone}`, 'review')
        continue
      }
      const grew = now.filter((x) => !was.includes(x))
      const shrank = was.filter((x) => !now.includes(x))
      if (grew.length) add('policy', `${origin(by)}'s ${what.noun} now also allows ${list(grew)}`, 'review')
      if (shrank.length) add('policy', `${origin(by)}'s ${what.noun} no longer allows ${list(shrank)}`)
    }
    for (const [by, now] of Object.entries(after ?? {})) {
      if (!before?.[by]) add('policy', `${origin(by)} now ${what.now}: ${list(now)}`)
    }
  }
  perLayer(bp.allow, hp.allow, { noun: 'MCP allowlist', gone: 'which MCP servers may run', now: 'allows only these MCP servers' })
  perLayer(bp.remoteHosts, hp.remoteHosts, {
    noun: 'remote host list',
    gone: 'which hosts remote MCP servers may reach',
    now: 'lets remote MCP servers reach only',
  })
  if (bp.requirePinned && !hp.requirePinned) add('policy', 'MCP servers no longer have to be pinned to an exact version', 'review')
  if (!bp.requirePinned && hp.requirePinned) add('policy', `MCP servers must now be pinned (${origin(hp.requirePinned)})`)
  const reqB = new Set(bp.require ?? [])
  const reqH = new Set(hp.require ?? [])
  const unrequired = [...reqB].filter((r) => !reqH.has(r))
  const newlyRequired = [...reqH].filter((r) => !reqB.has(r))
  if (unrequired.length) add('policy', `No longer required: ${list(unrequired)}`, 'review')
  if (newlyRequired.length) add('policy', `Now required: ${list(newlyRequired)}`)
  if (bp.contextBudget !== hp.contextBudget) {
    add('policy', `Context budget ${bp.contextBudget ?? 'none'} → ${hp.contextBudget ?? 'none'} tokens`, hp.contextBudget === undefined ? 'review' : 'info')
  }

  // ── Context ─────────────────────────────────────────────────
  if (base && b.context.tokens !== head.context.tokens) {
    const pct = b.context.tokens > 0 ? Math.round(((head.context.tokens - b.context.tokens) / b.context.tokens) * 100) : 0
    const over = hp.contextBudget && head.context.tokens > hp.contextBudget ? `, over the ${hp.contextBudget}-token budget` : ''
    add(
      'context',
      `Every assistant loads ~${head.context.tokens} tokens before the task (was ~${b.context.tokens}, ${pct >= 0 ? '+' : ''}${pct}%${over})`,
      pct > 10 || over ? 'review' : 'info',
    )
  }
  return lines
}

const SECTION_TITLE: Record<ReviewLine['section'], string> = {
  layers: 'Layers',
  targets: 'Targets and integrations',
  content: 'What every assistant reads',
  mcp: 'MCP servers',
  policy: 'Policy',
  context: 'Context',
}

export function reviewMarkdown(report: ReviewReport): string {
  const out: string[] = ['### OpenCastle — what this change does to the AI assistants', '']
  if (report.staleLock) {
    out.push(`> ⚠️ \`${LOCK_REL}\` is not what the sources compile to. Run \`npx opencastle sync\` and commit it.`, '')
  }
  if (report.lines.length === 0) {
    out.push(`No change to what any assistant is given (compared with \`${report.base}\`).`)
    return out.join('\n') + '\n'
  }
  const flagged = report.lines.filter((l) => l.level === 'review').length
  out.push(
    report.firstLock
      ? `First lock for this project (nothing at \`${report.base}\` to compare with).`
      : `Compared with \`${report.base}\`. ${flagged > 0 ? `**${flagged} change(s) marked ⚠️ deserve a careful look.**` : 'Nothing here needs special attention.'}`,
    '',
  )
  for (const section of Object.keys(SECTION_TITLE) as ReviewLine['section'][]) {
    const ls = report.lines.filter((l) => l.section === section)
    if (ls.length === 0) continue
    out.push(`**${SECTION_TITLE[section]}**`, '')
    for (const l of ls) out.push(`- ${l.level === 'review' ? '⚠️ ' : ''}${l.text}`)
    out.push('')
  }
  return out.join('\n')
}

function renderTerminal(report: ReviewReport): void {
  console.log(`\n  🏰 ${c.bold('OpenCastle review')} ${c.dim(`— compared with ${report.base}`)}\n`)
  if (report.staleLock) {
    console.log(`  ${c.yellow('!')} ${LOCK_REL} is not what the sources compile to — run ${c.cyan('npx opencastle sync')}\n`)
  }
  if (report.lines.length === 0) {
    console.log(`  ${c.green('✓')} No change to what any assistant is given.\n`)
    return
  }
  for (const section of Object.keys(SECTION_TITLE) as ReviewLine['section'][]) {
    const ls = report.lines.filter((l) => l.section === section)
    if (ls.length === 0) continue
    console.log(`  ${c.bold(SECTION_TITLE[section])}`)
    for (const l of ls) {
      const text = l.text.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => c.bold(t)).replace(/`([^`]+)`/g, (_m, t: string) => c.cyan(t))
      console.log(`    ${l.level === 'review' ? c.yellow('⚠') : c.dim('•')} ${text}`)
    }
    console.log('')
  }
  const flagged = report.lines.filter((l) => l.level === 'review').length
  if (flagged > 0) console.log(`  ${c.yellow(`${flagged} change(s) deserve a careful look.`)}\n`)
}

/** The lock as committed at `ref`, or null when the project had none there. */
export function lockAtRef(projectRoot: string, ref: string): Lock | null {
  let prefix: string
  try {
    // Git's own "fatal: not a git repository" went to the terminal above the
    // sentence below, which says the same thing in terms of this command.
    prefix = execFileSync('git', ['rev-parse', '--show-prefix'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error('this is not a git repository, so there is no base to compare with')
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: projectRoot, stdio: 'ignore' })
  } catch {
    throw new Error(
      `"${ref}" is not a commit here — in CI, fetch the base branch (actions/checkout with fetch-depth: 0)`,
    )
  }
  try {
    const text = execFileSync('git', ['show', `${ref}:${prefix}${LOCK_REL}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseLock(text)
  } catch {
    return null
  }
}

/** What the sources compile to now, as a lock; or the committed one if they do not resolve. */
async function headLock(pkgRoot: string, projectRoot: string): Promise<{ lock: Lock; stale: boolean }> {
  const manifest = await readManifest(projectRoot)
  if (!manifest) throw new Error('OpenCastle is not set up here — run npx opencastle init')
  refuseOlderCli(pkgRoot, manifest.version)
  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter(Boolean)
  const stack = resolveStack({ ...manifest, ides })
  const resolved = resolveSources({ pkgRoot, projectRoot, stack, repoInfo: manifest.repoInfo })
  if (hasErrors(resolved)) {
    throw new Error(`the team's sources do not resolve:\n${formatIssues(resolved.issues.filter((i) => i.level === 'error')).join('\n')}`)
  }
  const source = materialize(resolved, pkgRoot, ...priorTeam(projectRoot))
  try {
    const lock = buildLock(source, { ides, stack, repoInfo: manifest.repoInfo })
    const committed = resolve(projectRoot, LOCK_REL)
    const stale = !existsSync(committed) || readFileSync(committed, 'utf8').replace(/\r\n/g, '\n') !== serializeLock(lock)
    return { lock, stale }
  } finally {
    source.dispose()
  }
}

export function defaultBase(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`
  return 'HEAD'
}

export default async function review({ pkgRoot, args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }
  const projectRoot = process.cwd()
  const at = args.indexOf('--base')
  if (at !== -1 && (!args[at + 1] || args[at + 1].startsWith('-'))) {
    console.error(`  ${c.red('✗')} --base needs a git ref, e.g. --base origin/main`)
    process.exit(1)
  }
  const base = at !== -1 ? args[at + 1] : defaultBase()

  let report: ReviewReport
  try {
    const before = lockAtRef(projectRoot, base)
    const { lock, stale } = await headLock(pkgRoot, projectRoot)
    report = { base, firstLock: before === null, lines: diffLocks(before, lock), staleLock: stale }
  } catch (err) {
    console.error(`\n  ${c.red('✗')} Cannot review: ${(err as Error).message}\n`)
    process.exit(1)
  }

  const markdown = reviewMarkdown(report)
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else if (args.includes('--markdown')) console.log(markdown)
  else renderTerminal(report)

  // Beside the drift table `sync --check` writes, so a reviewer sees what the
  // change does next to whether it was compiled.
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (process.env.GITHUB_ACTIONS === 'true' && summary) {
    try {
      appendFileSync(summary, markdown + '\n')
    } catch {
      // The summary is a courtesy; the output above stands.
    }
  }
}
