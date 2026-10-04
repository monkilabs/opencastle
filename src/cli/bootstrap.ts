import { readFile, writeFile, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { RepoInfo, StackConfig } from './types.js'
import { readProjectFacts, displayName, type ProjectFacts } from './project-facts.js'
import { PLUGINS } from '../orchestrator/plugins/index.js'

/**
 * Fill `.opencastle/` with what the repository says, on a first install.
 *
 * The files used to be copied as templates and filled at a few markers: a
 * project name, a stack table with `<!-- TODO: verify -->` in every version
 * cell, and a dozen empty tables. Until an agent ran
 * `/oc:bootstrap-customizations`, every skill that sent an agent to them for
 * the project's routes, models or commands sent it to an empty table. Each file
 * is now written whole from the project's own files (`project-facts.ts`): what
 * the code says is there, and what it cannot say is listed at the end, once,
 * instead of left as empty rows.
 */

export interface BootstrapResult {
  populated: string[]
  removed: string[]
  renamed: string[]
}

// ── Markdown ───────────────────────────────────────────────────

/** Every written file starts with this: who wrote it and when, and that it is now the team's. */
const HEADER =
  `<!-- Written by \`npx opencastle init\` from the repository on ${new Date().toISOString().slice(0, 10)}. It is yours: correct it and\n` +
  '     add what the code cannot say. No OpenCastle command rewrites it. -->'

const code = (s: string): string => '`' + s + '`'

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** `a`, `b`, … — at most `max`, and how many there are when that is not all. */
function inline(items: string[], max = 12): string {
  const shown = items.slice(0, max).map(code).join(', ')
  return items.length > max ? `${shown}, … (${items.length} in all)` : shown
}

/** What could not be read from the code, for a person or an agent to add. */
function stillToDescribe(items: string[]): string {
  return [
    '## Still to describe',
    '',
    '<!-- Add these by hand, or run /oc:bootstrap-customizations to have an agent read the code and fill them in. -->',
    '',
    ...items.map((i) => `- ${i}`),
  ].join('\n')
}

function file(...sections: Array<string | null | undefined | false>): string {
  return sections.filter(Boolean).join('\n\n') + '\n'
}

/** The skill an integration ships, for the line that says which skill reads a file. */
function skillOf(id: string): string | null {
  return PLUGINS[id]?.skillName ?? null
}

const READ_BY = (skills: Array<string | null>): string | null => {
  const named = skills.filter((s): s is string => Boolean(s))
  return named.length ? `Read by the ${named.map(code).join(' and ')} skill${named.length > 1 ? 's' : ''}.` : null
}

/**
 * How this package manager runs a script. npm runs `test` and `start` directly
 * and everything else through `run` — `npm dev` is "Unknown command"; pnpm,
 * yarn and bun run any script by name.
 */
function runScript(facts: ProjectFacts, script: string): string {
  return facts.packageManager !== 'npm' || script === 'test' || script === 'start'
    ? `${facts.packageManager} ${script}`
    : `npm run ${script}`
}

function devLine(facts: ProjectFacts): string | null {
  if (!facts.scripts.dev && !facts.scripts.start) return null
  const cmd = runScript(facts, facts.scripts.dev ? 'dev' : 'start')
  return `Dev server: ${code(cmd)}${facts.devPort ? ` → http://localhost:${facts.devPort}` : ''}`
}

// ── project.instructions.md ────────────────────────────────────

const SCRIPT_ORDER = ['dev', 'build', 'start', 'test', 'lint', 'typecheck', 'type-check', 'format']

function keyCommands(facts: ProjectFacts): string | null {
  const names = Object.keys(facts.scripts).filter((s) => !/^(pre|post)/.test(s))
  if (names.length === 0) return null
  names.sort((a, b) => {
    const ia = SCRIPT_ORDER.indexOf(a)
    const ib = SCRIPT_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  const run = (s: string) => runScript(facts, s)
  const width = Math.max(...names.slice(0, 14).map((s) => run(s).length))
  const lines = names.slice(0, 14).map((s) => `${run(s).padEnd(width)}  # ${facts.scripts[s].slice(0, 70)}`)
  const ci = facts.ciCommands.length
    ? ['', `CI (${inline(facts.ciWorkflows, 3)}) runs: ${inline(facts.ciCommands, 8)} — a change passes these before it merges.`]
    : []
  return ['## Key Commands', '', devLine(facts) ?? '', '', '```bash', ...lines, '```', ...ci].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')
}

/** Which page roots belong to which framework integration. */
const PAGE_ROOT: Record<string, RegExp> = {
  nextjs: /(^|\/)(src\/)?(app|pages)\/$/, astro: /(^|\/)src\/pages\/$/, sveltekit: /(^|\/)src\/routes\/$/, remix: /(^|\/)app\/routes\/$/,
}

const DOMAIN: Record<string, string> = {
  framework: 'Framework', database: 'Database', cms: 'CMS', deployment: 'Deployment', 'codebase-tool': 'Build tooling',
  testing: 'Testing', 'e2e-testing': 'Browser testing', design: 'Design', email: 'Email', payments: 'Payments',
  observability: 'Observability', notifications: 'Notifications', 'task-management': 'Tasks', 'knowledge-management': 'Docs',
}

function domainRows(facts: ProjectFacts, stack: StackConfig): string[][] {
  const configs = facts.configPaths
  // Shallowest first: the root `turbo.json` before each app's.
  const named = (prefix: string) =>
    configs.filter((f) => f.split('/').pop()!.startsWith(prefix)).sort((a, b) => a.split('/').length - b.split('/').length)
  const rows: string[][] = []
  for (const id of stack.techTools) {
    const plugin = PLUGINS[id]
    if (!plugin?.skillName) continue
    const label = id === 'nextjs' ? 'next' : id
    let paths: string[] = []
    switch (plugin.subCategory) {
      case 'framework':
        paths = [
          ...facts.pages.map((p) => p.root).filter((r) => PAGE_ROOT[id]?.test(r)),
          ...named(`${label}.config`),
          ...(id === 'expo' ? [...named('app.json'), ...named('app.config')] : []),
        ]
        break
      case 'database':
        paths = [facts.models?.source ?? '', facts.migrations?.dir ?? '', ...(facts.importers[label] ?? []).slice(0, 1)]
        break
      case 'testing':
      case 'e2e-testing':
        paths = named(`${label}.config`)
        break
      case 'deployment':
      case 'codebase-tool':
        paths = id === 'turborepo' ? named('turbo.json') : id === 'nx' ? named('nx.json') : configs.filter((f) => f.includes(label))
        break
      default:
        paths = facts.importers[label] ?? named(`${label}.config`)
    }
    const unique = [...new Set(paths.filter(Boolean))]
    const where = unique.length
      ? inline(unique, 3)
      : plugin.subCategory === 'e2e-testing' && facts.devPort ? `http://localhost:${facts.devPort}` : '—'
    rows.push([DOMAIN[plugin.subCategory] ?? plugin.subCategory, code(plugin.skillName), where])
  }
  const ui = facts.dirs.find((d) => /^(src\/)?components\/$/.test(d.path))
  if (ui) rows.push(['UI', code('frontend-design'), code(ui.path)])
  return rows
}

function renderProjectInstructions(facts: ProjectFacts, info: RepoInfo, stack: StackConfig): string {
  const about = [
    facts.name ? `**${facts.name}**` : null,
    facts.description ? `— ${facts.description}` : null,
  ].filter(Boolean).join(' ')
  const language = { typescript: 'TypeScript', javascript: 'JavaScript' }[facts.language ?? ''] ?? facts.language
  const basics = [language, facts.nodeVersion ? `Node ${facts.nodeVersion}` : null, `package manager ${code(facts.packageManager)}`, facts.workspaces.length ? `${info.monorepo ?? 'workspaces'} monorepo` : null]
    .filter(Boolean).join(' · ')

  const stackRows = facts.stack.map((s) => [s.layer, s.name, s.version ?? '—'])
  for (const d of info.deployment ?? []) stackRows.push(['Deployment', displayName(d), '—'])
  for (const c of info.cicd ?? []) stackRows.push(['CI', displayName(c), '—'])

  const routes = facts.pages.map((p) => `${p.routes.length} page${p.routes.length === 1 ? '' : 's'} in ${code(p.root)}: ${inline(p.routes, 20)}`)
  const apiParts = [
    facts.api.length ? `${facts.api.length} API endpoint${facts.api.length === 1 ? '' : 's'}` : null,
    facts.rpcRouters.length ? `${facts.rpcRouters.length} tRPC router file${facts.rpcRouters.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  const api = apiParts.length ? `${apiParts.join(' and ')}, listed in ${code('.opencastle/stack/api-config.md')}.` : null

  const missing = [
    'Architecture — how the parts fit together, and what talks to what',
    'Production URLs and environments',
    ...(facts.dirs.some((d) => !d.purpose) || facts.workspaces.some((w) => !w.purpose) ? ['What the folders without a purpose above hold'] : []),
  ]

  return file(
    '# Project Context',
    HEADER,
    [about, basics].filter(Boolean).join('\n\n'),
    stackRows.length ? ['## Tech Stack', '', table(['Layer', 'Technology', 'Version'], stackRows)].join('\n') : null,
    facts.workspaces.length
      ? ['## Workspaces', '', table(['Path', 'Package', 'Purpose'], facts.workspaces.map((w) => [code(w.path), code(w.name), w.purpose]))].join('\n')
      : null,
    facts.dirs.length ? ['## Project Structure', '', table(['Path', 'Purpose'], facts.dirs.map((d) => [code(d.path), d.purpose]))].join('\n') : null,
    keyCommands(facts),
    routes.length || api ? ['## Routes', ...routes, ...(api ? [api] : [])].join('\n\n') : null,
    facts.envVars ? ['## Environment', '', `Names from ${code(facts.envVars.source)} — values never belong here: ${inline(facts.envVars.names, 30)}`].join('\n') : null,
    facts.docs.length ? ['## Key Documentation', '', ...facts.docs.map((d) => `- ${code(d)}`)].join('\n') : null,
    (() => {
      const rows = domainRows(facts, stack)
      return rows.length ? ['## Domain Quick Reference', '', table(['Domain', 'Skill', 'Key paths'], rows)].join('\n') : null
    })(),
    stillToDescribe(missing),
  )
}

// ── stack/*.md ─────────────────────────────────────────────────

/** The frameworks that serve an API, in the order one is named for it. */
const SERVES_API = ['Next.js', 'Astro', 'SvelteKit', 'Remix', 'Nuxt', 'Express', 'Fastify', 'Hono']

function renderApiConfig(facts: ProjectFacts, info: RepoInfo): string {
  const frameworks = facts.stack.filter((s) => s.layer === 'Framework')
  const fw = SERVES_API.map((n) => frameworks.find((s) => s.name === n)).find(Boolean) ?? frameworks[0]
  const services = (info.services ?? []).filter((s) => facts.importers[s]?.length)
  return file(
    '# API Configuration',
    HEADER,
    [fw ? `Framework: ${fw.name}${fw.version ? ` ${fw.version}` : ''}.` : null, READ_BY(['api-patterns'])].filter(Boolean).join(' '),
    ['## Endpoints', '', facts.api.length
      ? table(['Endpoint', 'Methods', 'File'], facts.api.map((a) => [code(a.route), a.methods.join(', ') || '—', code(a.file)]))
      : facts.rpcRouters.length ? 'No route files: the API is tRPC, below.' : 'None found in route files.'].join('\n'),
    facts.rpcRouters.length ? ['## tRPC routers', '', ...facts.rpcRouters.map((f) => `- ${code(f)}`)].join('\n') : null,
    facts.serverActions.length ? ['## Server Actions', '', ...facts.serverActions.map((f) => `- ${code(f)}`)].join('\n') : null,
    facts.middleware ? ['## Middleware', '', `${code(facts.middleware)} runs before matching requests.`].join('\n') : null,
    services.length
      ? ['## External APIs', '', table(['Service', 'Used in'], services.map((s) => [displayName(s), inline(facts.importers[s], 3)]))].join('\n')
      : null,
    stillToDescribe(['Who may call each endpoint, and how it is authorized', 'Rate limits, caching and error format']),
  )
}

function renderDatabaseConfig(facts: ProjectFacts, provider: string): string {
  const version = facts.stack.find((s) => s.layer === 'Database' && s.name === displayName(provider))?.version
  const client = facts.importers[provider]?.[0]
  const env = facts.envVars?.names.filter((n) => /DATABASE|DB_|POSTGRES|MYSQL|MONGO|SUPABASE|CONVEX|TURSO|REDIS/.test(n)) ?? []
  return file(
    `# ${displayName(provider)} Configuration`,
    HEADER,
    READ_BY([skillOf(provider)]),
    [
      version ? `**Version:** ${version}` : null,
      facts.models ? `**Schema:** ${code(facts.models.source)}` : null,
      client ? `**Client:** ${code(client)}` : null,
    ].filter(Boolean).join(' · ') || null,
    facts.models?.names.length ? ['## Models', '', inline(facts.models.names, 60)].join('\n') : null,
    facts.migrations
      ? ['## Migrations', '', `${facts.migrations.count} in ${code(facts.migrations.dir)}; the latest: ${inline(facts.migrations.latest)}.`].join('\n')
      : null,
    env.length ? ['## Environment', '', inline(env)].join('\n') : null,
    stillToDescribe([
      'What each model holds, and how they relate',
      provider === 'supabase' ? 'Row-level security: which policies guard which tables' : 'Who may read and write what, and where that is enforced',
      'How a schema change is made and rolled out',
    ]),
  )
}

function renderCmsConfig(facts: ProjectFacts, provider: string): string {
  const configs = facts.configPaths.filter((f) => f.split('/').pop()!.startsWith(`${provider}.config`))
  const used = facts.importers[provider] ?? []
  return file(
    `# ${displayName(provider)} Configuration`,
    HEADER,
    READ_BY([skillOf(provider)]),
    configs.length ? `**Config:** ${inline(configs)}` : null,
    used.length ? ['## Used in', '', inline(used)].join('\n') : null,
    stillToDescribe(['Project and dataset IDs (never tokens)', 'Document types and their key fields', 'How content is queried, with an example']),
  )
}

function renderTestingConfig(facts: ProjectFacts, info: RepoInfo, browserChecks: boolean): string {
  const dirs = [...new Set(facts.testFiles.map((f) => f.split('/').slice(0, -1).join('/') || '.'))].slice(0, 6)
  const testScripts = Object.keys(facts.scripts).filter((s) => /^(test|e2e)/.test(s)).map((s) => `${facts.packageManager} run ${s}`)
  const configs = facts.testConfigs
  const frameworks = facts.testFrameworks.length ? facts.testFrameworks : (info.testing ?? []).map(displayName)
  const bp = facts.breakpoints
  return file(
    '# Testing Configuration',
    HEADER,
    READ_BY(['testing-workflow', browserChecks ? 'browser-testing' : null]),
    [
      frameworks.length ? `**Frameworks:** ${frameworks.join(', ')}${configs.length ? ` (${inline(configs)})` : ''}` : '**Frameworks:** none in package.json.',
      facts.testFiles.length ? `**Test files:** ${facts.testFiles.length}, in ${inline(dirs, 6)}` : '**Test files:** none found.',
      testScripts.length ? `**Run:** ${inline(testScripts)}` : null,
      facts.coverage.length ? `**Coverage required:** ${facts.coverage.join(', ')} (from the test config)` : null,
    ].filter(Boolean).join('\n\n'),
    browserChecks
      ? [
          '## Browser checks',
          '',
          devLine(facts) ?? 'Dev server: not found in package.json.',
          bp ? `\nBreakpoints (${bp.source}): ${bp.values.map(([n, v]) => `${n} ${v}`).join(' · ')}` : '',
        ].join('\n')
      : null,
    stillToDescribe([
      'Selector conventions (`data-testid` or roles) and test data',
      ...(facts.testFiles.length ? [] : ['Where new tests go, and with which framework']),
    ]),
  )
}

function renderDeploymentConfig(facts: ProjectFacts, info: RepoInfo): string {
  const platforms = (info.deployment ?? []).map(displayName)
  const configs = facts.configPaths.filter((f) =>
    /(^|\/)(vercel\.json|netlify\.toml|Dockerfile|(docker-)?compose\.ya?ml|fly\.toml|render\.yaml|wrangler\.(toml|jsonc?))$/.test(f),
  )
  return file(
    '# Deployment Configuration',
    HEADER,
    READ_BY([...(info.deployment ?? []).map((d) => skillOf(d)), 'deployment-infrastructure']),
    [
      `**Platform:** ${platforms.join(', ')}`,
      configs.length ? `**Config:** ${inline(configs)}` : null,
      facts.scripts.build ? `**Build:** ${code(`${facts.packageManager} run build`)}` : null,
      facts.ciWorkflows.length ? `**CI:** ${inline(facts.ciWorkflows)}` : null,
    ].filter(Boolean).join('\n\n'),
    facts.envVars ? ['## Environment', '', `Names from ${code(facts.envVars.source)}: ${inline(facts.envVars.names, 30)}`].join('\n') : null,
    stillToDescribe(['Environments and their URLs', 'Scheduled jobs, security headers and caching', 'How a release is rolled back']),
  )
}

/** The research scopes in the agent registry, with this project's directories. */
async function fillAgentRegistry(opencastleDir: string, facts: ProjectFacts, result: BootstrapResult): Promise<void> {
  const path = join(opencastleDir, 'agents', 'agent-registry.md')
  if (!existsSync(path)) return
  const text = await readFile(path, 'utf8')
  const has = (p: string) => facts.dirs.find((d) => d.path === p || d.path === `src/${p}`)?.path
  const backend = [facts.migrations?.dir, ...['prisma/', 'supabase/', 'drizzle/', 'db/', 'convex/', 'server/', 'lib/'].map(has)].filter(Boolean) as string[]
  const frontend = [...facts.pages.map((p) => p.root), ...['components/', 'ui/', 'styles/'].map(has)].filter(Boolean) as string[]
  for (const w of facts.workspaces) {
    if (/^packages\/(db|database|api)\/$/.test(w.path)) backend.push(w.path)
    if (/^packages\/(ui|components)\/$/.test(w.path)) frontend.push(w.path)
  }
  const content = ['content/', 'studio/', 'sanity/', 'cms/'].map(has).filter(Boolean) as string[]
  // A directory inside another one listed is already in scope.
  const scope = (paths: string[]) => {
    const unique = [...new Set(paths)]
    return unique.filter((p) => !unique.some((q) => q !== p && p.startsWith(q))).join(', ')
  }
  const lines: string[] = []
  if (backend.length) lines.push('Researcher A: "Research database/backend aspects of [feature]"', `  Scope: ${scope(backend)}`, '')
  if (frontend.length) lines.push('Researcher B: "Research frontend/UI aspects of [feature]"', `  Scope: ${scope(frontend)}`, '')
  if (content.length) lines.push('Researcher C: "Research content aspects of [feature]"', `  Scope: ${scope(content)}`, '')
  if (lines.length === 0) return
  const next = text.replace(/```\nResearcher A:[\s\S]*?```/, '```\n' + lines.join('\n').trimEnd() + '\n```')
    .replace(/<!-- Customize these paths[\s\S]*?-->\n\n/, '')
  if (next === text) return
  await writeFile(path, next, 'utf8')
  result.populated.push('agents/agent-registry.md')
}

// ── Writing ────────────────────────────────────────────────────

async function writeOrRemove(
  opencastleDir: string,
  rel: string,
  content: string | null,
  result: BootstrapResult,
  as?: string,
): Promise<void> {
  const from = join(opencastleDir, rel)
  if (!existsSync(from)) return
  if (content === null) {
    await unlink(from)
    result.removed.push(rel)
    return
  }
  if (as && as !== rel) {
    await writeFile(join(opencastleDir, as), content, 'utf8')
    await unlink(from)
    result.renamed.push(`${rel} → ${as}`)
    return
  }
  await writeFile(from, content, 'utf8')
  result.populated.push(rel)
}

/** Test frameworks a project runs itself; an integration like Chrome DevTools is not one. */
const TEST_FRAMEWORKS = new Set(['jest', 'vitest', 'playwright', 'cypress', 'mocha'])
const BROWSER_CHECKS = new Set(['chrome-devtools', 'playwright', 'cypress'])

export const TRACKER_TOOLS = new Set<string>(['linear', 'jira', 'trello'])

async function handleTrackerConfig(
  opencastleDir: string,
  info: RepoInfo,
  stack: StackConfig,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'project', 'tracker-config.md')
  if (!existsSync(filePath)) return

  const tracker =
    stack.teamTools.find(t => TRACKER_TOOLS.has(t)) ??
    info.pm?.find(p => TRACKER_TOOLS.has(p))

  if (!tracker) {
    await unlink(filePath)
    result.removed.push('project/tracker-config.md')
    return
  }

  let content = await readFile(filePath, 'utf8')
  const displayed = tracker.charAt(0).toUpperCase() + tracker.slice(1)

  content = content.replace('# Task Tracker Configuration', `# ${displayed} Configuration`)

  const renameComment =
    '<!-- Populated by `npx opencastle init`.\n     Rename this file to match your tracker: linear-config.md, jira-config.md, etc. -->'
  content = content.replace(renameComment + '\n', '')

  const newName = `${tracker}-config.md`
  await writeFile(join(opencastleDir, 'project', newName), content, 'utf8')
  await unlink(filePath)
  result.renamed.push(`project/tracker-config.md → project/${newName}`)
}

// ── Main export ────────────────────────────────────────────────

/**
 * `repoInfo` is the detection merged with the selected integrations; the facts
 * are read from the files, so a selected integration the project does not use
 * — Chrome DevTools — is never listed as one of its test frameworks.
 */
export async function bootstrapCustomizations(
  projectRoot: string,
  repoInfo: RepoInfo,
  stack: StackConfig,
): Promise<BootstrapResult> {
  const opencastleDir = join(projectRoot, '.opencastle')
  const result: BootstrapResult = { populated: [], removed: [], renamed: [] }

  const testing = (repoInfo.testing ?? []).filter((t) => TEST_FRAMEWORKS.has(t))
  const facts = await readProjectFacts(projectRoot, { ...repoInfo, testing })

  if (existsSync(join(opencastleDir, 'project.instructions.md'))) {
    await writeFile(join(opencastleDir, 'project.instructions.md'), renderProjectInstructions(facts, repoInfo, stack), 'utf8')
    result.populated.push('project.instructions.md')
  }

  const browserChecks = [...stack.techTools].some((t) => BROWSER_CHECKS.has(t))
  await writeOrRemove(opencastleDir, 'stack/testing-config.md',
    testing.length || facts.testFiles.length || browserChecks ? renderTestingConfig(facts, { ...repoInfo, testing }, browserChecks) : null, result)
  await writeOrRemove(opencastleDir, 'stack/deployment-config.md',
    repoInfo.deployment?.length ? renderDeploymentConfig(facts, repoInfo) : null, result)
  await writeOrRemove(opencastleDir, 'stack/api-config.md',
    repoInfo.frameworks?.length ? renderApiConfig(facts, repoInfo) : null, result)

  // One provider gets a file named after it; several share the generic one.
  const databases = repoInfo.databases ?? []
  await writeOrRemove(opencastleDir, 'stack/database-config.md',
    databases.length ? renderDatabaseConfig(facts, databases[0]) : null, result,
    databases.length === 1 ? `stack/${databases[0]}-config.md` : undefined)
  const cms = repoInfo.cms ?? []
  await writeOrRemove(opencastleDir, 'stack/cms-config.md',
    cms.length ? renderCmsConfig(facts, cms[0]) : null, result,
    cms.length === 1 ? `stack/${cms[0]}-config.md` : undefined)

  if (!repoInfo.notifications?.length) await writeOrRemove(opencastleDir, 'stack/notifications-config.md', null, result)
  await writeOrRemove(opencastleDir, 'stack/data-pipeline-config.md', null, result)
  await handleTrackerConfig(opencastleDir, repoInfo, stack, result)
  await removeUnusedProviderTemplates(opencastleDir, repoInfo, result)
  await fillAgentRegistry(opencastleDir, facts, result)

  // A folder whose every template was left out is not left behind empty: with
  // no tracker, `project/` held nothing else.
  for (const dir of ['project', 'stack']) await rmdir(join(opencastleDir, dir)).catch(() => {})

  return result
}

/**
 * The provider templates shipped beside the generic ones — `supabase-config.md`,
 * `sanity-config.md` — for a project that uses neither. The generic templates
 * were removed when nothing was detected; these two stayed, so a project with
 * no database and no CMS was given notes for both.
 */
async function removeUnusedProviderTemplates(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const inUse = new Set<string>([...(info.databases ?? []), ...(info.cms ?? [])])
  for (const provider of ['supabase', 'sanity']) {
    const rel = `stack/${provider}-config.md`
    const abs = join(opencastleDir, rel)
    if (!existsSync(abs)) continue
    if (inUse.has(provider)) continue
    await unlink(abs)
    result.removed.push(rel)
  }
}
