import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expectedTeamEntries } from './mcp.js'
import { resolveStack } from './stack-config.js'
import {
  resolveSources,
  materialize,
  mcpPlan,
  hasErrors,
  usesTeamSources,
  filesUnder,
  type ResolvedSources,
  type TeamMcpPlan,
} from './layers.js'
import { contentReport, priorTeam, tokensOf } from './lock.js'
import { parseVersion, compareVersions } from './version-range.js'
import type { TeamAuditContext } from './mcp-audit.js'
import type { IdeChoice, Manifest } from './types.js'

/**
 * `doctor`'s questions about the team's own sources: do they resolve, how much
 * does every assistant load before it reads the task, and do the instructions
 * still describe this repository.
 */

export interface HealthResult {
  ok: boolean
  label: string
  detail?: string
  warning?: boolean
  fix?: string
}

export interface TeamState {
  resolved: ResolvedSources
  plan: TeamMcpPlan
}

/** Resolve the project's sources the way `sync` does. */
export function teamStateFor(pkgRoot: string, projectRoot: string, manifest: Manifest): TeamState {
  const stack = resolveStack(manifest)
  const resolved = resolveSources({ pkgRoot, projectRoot, stack, repoInfo: manifest.repoInfo })
  return { resolved, plan: mcpPlan(resolved, ...priorTeam(projectRoot)) }
}

/** What the MCP audit needs to hold one target's config to the team's decisions. */
export function teamAuditContext(state: TeamState, ide: IdeChoice): TeamAuditContext {
  return {
    expected: expectedTeamEntries(state.plan, ide),
    definedIn: Object.fromEntries([...state.resolved.servers.values()].map((s) => [s.key, s.where])),
    retired: state.plan.retired,
    blocked: state.resolved.blocked,
    policy: state.resolved.policy,
  }
}

const SOURCES = 'Team sources'

export function checkTeamSources(state: TeamState): HealthResult {
  const { resolved } = state
  const errors = resolved.issues.filter((i) => i.level === 'error')
  const warnings = resolved.issues.filter((i) => i.level === 'warning')
  if (errors.length > 0) {
    const first = errors[0]
    return {
      ok: false,
      label: SOURCES,
      detail: errors.map((e) => `${e.where}: ${e.message}`).join('; '),
      fix: first.fix ? `${first.fix}${errors.length > 1 ? ` (and ${errors.length - 1} more above)` : ''}` : 'fix the problems above; sync refuses to compile until then',
    }
  }
  const baselines = resolved.layers.filter((l) => l.kind === 'baseline')
  const own = [...resolved.items.values()].filter((i) => i.layer !== 'opencastle')
  const counts = (['skills', 'agents', 'instructions', 'prompts', 'workflows'] as const)
    .map((k) => [k, own.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, '') : k}`)
  const detail = usesTeamSources(resolved)
    ? [
        baselines.length > 0 ? `extends ${baselines.map((b) => `${b.id}${b.version ? `@${b.version}` : ''}`).join(', ')}` : '',
        counts.length > 0 ? `team content: ${counts.join(', ')}` : '',
        resolved.servers.size > 0 ? `${resolved.servers.size} team MCP server(s)` : '',
        resolved.policy.allowLists.length > 0 ? 'MCP allowlist in force' : '',
      ]
        .filter(Boolean)
        .join('; ')
    : `OpenCastle's own content only — add .opencastle/config.json to extend a baseline or add your own`
  if (warnings.length > 0) {
    return {
      ok: true,
      warning: true,
      label: SOURCES,
      detail: `${detail}; ${warnings.map((w) => `${w.where}: ${w.message}`).join('; ')}`,
      fix: warnings.map((w) => w.fix).filter(Boolean).join('; ') || undefined,
    }
  }
  return { ok: true, label: SOURCES, detail }
}

const CONTEXT = 'Always-loaded context'

function k(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

/**
 * What every assistant reads before the task: the instructions, and the index
 * of skills and agents that tells it what else exists. Context is finite and
 * attention over it is not uniform, so a team that keeps adding "always" rules
 * pays for each one on every request. Reported always; a warning only past the
 * budget a layer set, with the biggest contributors named — the usual fix is to
 * move detail out of an instruction into a skill that loads on demand.
 */
export function checkContextBudget(pkgRoot: string, state: TeamState): HealthResult {
  if (hasErrors(state.resolved)) return { ok: true, label: CONTEXT, detail: 'not measured — the team sources have errors (above)' }
  const source = materialize(state.resolved, pkgRoot)
  try {
    const report = contentReport(source)
    const total = tokensOf(report.instructionChars + report.indexChars)
    const detail = `~${k(total)} tokens (instructions ~${k(tokensOf(report.instructionChars))}, skill and agent index ~${k(tokensOf(report.indexChars))})`
    const budget = state.resolved.policy.contextBudget
    if (!budget || total <= budget.tokens) {
      return { ok: true, label: CONTEXT, detail: budget ? `${detail}; budget ${k(budget.tokens)} (${budget.by})` : detail }
    }
    const top = [...report.cost]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 3)
      .map((c) => `${c.ref} ~${k(tokensOf(c.chars))}${c.from === 'opencastle' ? '' : ` (${c.from})`}`)
    return {
      ok: true,
      warning: true,
      label: CONTEXT,
      detail: `${detail} — over the ${k(budget.tokens)} budget ${budget.by} set; largest: ${top.join(', ')}`,
      fix: 'move detail out of always-loaded instructions into a skill, which loads only when a task needs it; or exclude what this repository does not use',
    }
  } finally {
    source.dispose()
  }
}

const REFERENCES = 'Team instructions match this repository'

/** Scripts named in instructions, as `npm run <name>` and friends. */
const SCRIPT_RUN = /\b(?:npm|pnpm|yarn|bun)\s+run\s+([A-Za-z0-9:_.][A-Za-z0-9:_.-]*)/g
/** A repository path written in backticks. */
const PATH_SPAN = /`([A-Za-z0-9_.@-][A-Za-z0-9_.@/-]*\/[A-Za-z0-9_.@/-]*[A-Za-z0-9_-])`/g

/**
 * Instructions rot quietly. A renamed script or a moved directory leaves an
 * instruction telling every agent to run a command that fails or read a path
 * that is gone — and an agent follows it. Checked only in the team's own
 * layers: OpenCastle's content is generic, and a baseline's paths belong to no
 * repository in particular, though the scripts a baseline names must exist in
 * every repository that extends it.
 */
export function checkReferences(state: TeamState, projectRoot: string): HealthResult {
  let scripts: Record<string, string> | null = null
  try {
    scripts = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
  } catch {
    scripts = null
  }
  const dead: string[] = []
  for (const item of state.resolved.items.values()) {
    if (item.layer === 'opencastle') continue
    const files = statSync(item.path).isDirectory()
      ? filesUnder(item.path).filter((f) => f.endsWith('.md')).map((f) => join(item.path, f))
      : [item.path]
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const ref = `${item.kind}/${item.name}`
      if (scripts) {
        for (const m of text.matchAll(SCRIPT_RUN)) {
          if (!(m[1] in scripts)) dead.push(`${ref} runs "${m[0]}", which package.json does not define`)
        }
      }
      if (item.layer !== 'project') continue
      for (const m of text.matchAll(PATH_SPAN)) {
        const path = m[1].replace(/:\d+(?::\d+)?$/, '').replace(/\/$/, '')
        if (path.includes('://') || path.startsWith('@')) continue
        const first = path.split('/')[0]
        // Only when the path starts in a directory this repository has: a
        // generic example like `src/foo` in a repo with no `src/` is prose, not
        // a reference.
        const top = resolve(projectRoot, first)
        if (!existsSync(top) || !statSync(top).isDirectory()) continue
        if (!existsSync(resolve(projectRoot, path))) dead.push(`${ref} names \`${path}\`, which does not exist`)
      }
    }
  }
  const unique = [...new Set(dead)]
  if (unique.length === 0) return { ok: true, label: REFERENCES, detail: 'every script and path the team content names exists' }
  return {
    ok: true,
    warning: true,
    label: REFERENCES,
    detail: unique.slice(0, 5).join('; ') + (unique.length > 5 ? `; and ${unique.length - 5} more` : ''),
    fix: 'update the instruction (in .opencastle/, or in the baseline that ships it), or restore what it names',
  }
}

const VERSION = 'OpenCastle version'

/**
 * A teammate on an older OpenCastle than the one that compiled the project
 * would, on `sync`, replace newer output with older — and the next person
 * would put it back. Named here; `sync` refuses it.
 */
export function checkVersionSkew(cliVersion: string, manifest: Manifest): HealthResult {
  const mine = parseVersion(cliVersion)
  const theirs = parseVersion(manifest.version)
  if (!mine || !theirs) return { ok: true, label: VERSION, detail: `running ${cliVersion}` }
  const cmp = compareVersions(mine, theirs)
  if (cmp < 0) {
    // A failure, not a warning: `sync` refuses to run, and `sync --check`
    // compares nothing, until the project's version is the one running.
    return {
      ok: false,
      label: VERSION,
      detail: `running ${cliVersion}, older than the ${manifest.version} that last compiled this project`,
      fix: `use the project's version — add opencastle@${manifest.version} to devDependencies and run npx opencastle, so everyone runs the same one`,
    }
  }
  return {
    ok: true,
    label: VERSION,
    detail: cmp === 0 ? `${cliVersion}, the version that compiled this project` : `running ${cliVersion}; the project was compiled by ${manifest.version} — sync upgrades it`,
  }
}
