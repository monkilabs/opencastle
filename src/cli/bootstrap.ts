import { readFile, writeFile, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { RepoInfo, StackConfig } from './types.js'

export interface BootstrapResult {
  populated: string[]
  removed: string[]
  renamed: string[]
}

// ── Internal types ─────────────────────────────────────────────

interface PackageJson {
  name?: string
  description?: string
  scripts?: Record<string, string>
}

interface WorkspacePkg {
  path: string
  name: string
  description?: string
}

// ── Utilities ──────────────────────────────────────────────────

async function tryReadJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Replace the first empty table row within a named markdown section.
 * Scopes the search from `sectionMarker` to the next `## ` heading.
 */
function fillTableSection(
  content: string,
  sectionMarker: string,
  emptyRow: string,
  rows: string[],
): string {
  if (rows.length === 0) return content
  const sIdx = content.indexOf(sectionMarker)
  if (sIdx === -1) return content
  const nextSectionIdx = content.indexOf('\n## ', sIdx + sectionMarker.length)
  const end = nextSectionIdx === -1 ? content.length : nextSectionIdx
  const slice = content.slice(sIdx, end)
  const needle = '\n' + emptyRow
  const needleIdx = slice.indexOf(needle)
  if (needleIdx === -1) return content
  const abs = sIdx + needleIdx + 1 // position of first char of emptyRow (skip \n)
  return content.slice(0, abs) + rows.join('\n') + content.slice(abs + emptyRow.length)
}

function replaceMarker(content: string, marker: string, replacement: string): string {
  if (!content.includes(marker)) return content
  return content.replace(marker, replacement)
}

function filterConfigFiles(configFiles: string[] | undefined, patterns: string[]): string[] {
  if (!configFiles?.length) return []
  return configFiles.filter(f => patterns.some(p => f === p || f.endsWith('/' + p) || f.includes(p)))
}

// ── Workspace scanning ─────────────────────────────────────────

async function scanWorkspace(projectRoot: string): Promise<WorkspacePkg[]> {
  const packages: WorkspacePkg[] = []
  for (const dir of ['apps', 'packages', 'libs']) {
    const dirPath = join(projectRoot, dir)
    if (!existsSync(dirPath)) continue
    let entries: Array<{ name: string; isDirectory(): boolean }> = []
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const pkg = await tryReadJson<PackageJson>(join(dirPath, e.name, 'package.json'))
      packages.push({
        path: `${dir}/${e.name}`,
        name: pkg?.name ?? `${dir}/${e.name}`,
        description: pkg?.description,
      })
    }
  }
  return packages
}

// ── Builders ───────────────────────────────────────────────────

function buildStackRows(info: RepoInfo): string[] {
  const rows: string[] = []
  const addList = (layer: string, values: string[] | undefined) => {
    if (!values?.length) return
    for (const v of values) rows.push(`| ${layer} | ${v} | <!-- TODO: verify --> | |`)
  }
  if (info.language) rows.push(`| Language | ${info.language} | | |`)
  if (info.packageManager) rows.push(`| Package Manager | ${info.packageManager} | | |`)
  addList('Framework', info.frameworks)
  addList('Database', info.databases)
  addList('CMS', info.cms)
  addList('Deployment', info.deployment)
  addList('Testing', info.testing)
  addList('CI/CD', info.cicd)
  addList('Styling', info.styling)
  addList('Auth', info.auth)
  return rows
}

function buildKeyCommandsBlock(pm: string, scripts: Record<string, string>): string {
  const commands = (['dev', 'build', 'test', 'lint', 'start'] as const)
    .filter(k => scripts[k])
    .map(k => `${pm} run ${k}`)
  if (commands.length === 0) return ''
  return `**Package manager:** \`${pm}\`\n\n\`\`\`bash\n${commands.join('\n')}\n\`\`\``
}

// ── Populators ─────────────────────────────────────────────────

async function populateProjectInstructions(
  opencastleDir: string,
  projectRoot: string,
  info: RepoInfo,
  pkg: PackageJson,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'project.instructions.md')
  if (!existsSync(filePath)) return
  let content = await readFile(filePath, 'utf8')
  const orig = content

  // Overview: project name + description
  if (pkg.name || pkg.description) {
    const parts: string[] = []
    if (pkg.name) parts.push(`**Project:** ${pkg.name}`)
    if (pkg.description) parts.push(`**Description:** ${pkg.description}`)
    content = replaceMarker(
      content,
      '<!-- Project name, description, and current status -->',
      parts.join('\n\n'),
    )
  }

  // Tech stack table
  content = fillTableSection(content, '## Tech Stack', '| | | | |', buildStackRows(info))

  // Key commands
  if (pkg.scripts) {
    const pm = info.packageManager ?? 'npm'
    const cmdBlock = buildKeyCommandsBlock(pm, pkg.scripts)
    if (cmdBlock) {
      content = replaceMarker(
        content,
        '<!-- Package manager and common development commands -->',
        '<!-- Package manager and common development commands -->\n\n' + cmdBlock,
      )
    }
  }

  // Monorepo workspace packages
  if (info.monorepo) {
    const workspaces = await scanWorkspace(projectRoot)
    if (workspaces.length > 0) {
      const pkgRows = workspaces.map(w => {
        const cell =
          w.name !== w.path ? `\`${w.path}\` (\`${w.name}\`)` : `\`${w.path}\``
        return `| ${cell} | ${w.description ?? '<!-- TODO: verify -->'} |`
      })
      content = fillTableSection(content, '## Project Structure', '| | |', pkgRows)
    }
  }

  if (content !== orig) {
    await writeFile(filePath, content, 'utf8')
    result.populated.push('project.instructions.md')
  }
}

async function populateTestingConfig(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'testing-config.md')
  if (!existsSync(filePath)) return

  if (!info.testing?.length) {
    await unlink(filePath)
    result.removed.push('stack/testing-config.md')
    return
  }

  let content = await readFile(filePath, 'utf8')
  const orig = content

  const introLine = 'Project-specific testing details referenced by the `browser-testing` skill.'
  if (content.includes(introLine)) {
    // Strip any previously-added content to make this idempotent
    const existingAdditionRegex = /\n\n\*\*Test frameworks:\*\*[^\n]*(\n\n\*\*Config files:\*\*[^\n]*)?/;
    content = content.replace(existingAdditionRegex, '');

    const cfg = filterConfigFiles(info.configFiles, [
      'vitest.config.ts',
      'vitest.config.js',
      'jest.config.ts',
      'jest.config.js',
      'playwright.config.ts',
      'playwright.config.js',
    ])
    let addition = `\n\n**Test frameworks:** ${info.testing.join(', ')}`
    if (cfg.length > 0) {
      addition += `\n\n**Config files:** ${cfg.map(f => `\`${f}\``).join(', ')}`
    }
    content = content.replace(introLine, introLine + addition)
  }

  if (content !== orig) {
    await writeFile(filePath, content, 'utf8')
    result.populated.push('stack/testing-config.md')
  }
}

async function populateDeploymentConfig(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'deployment-config.md')
  if (!existsSync(filePath)) return

  if (!info.deployment?.length) {
    await unlink(filePath)
    result.removed.push('stack/deployment-config.md')
    return
  }

  let content = await readFile(filePath, 'utf8')
  const orig = content

  const archMarker =
    '<!-- Describe the deployment platform, CI/CD pipeline, and trigger mechanism. -->'
  if (content.includes(archMarker)) {
    const cfg = filterConfigFiles(info.configFiles, [
      'vercel.json',
      'netlify.toml',
      'Dockerfile',
      'docker-compose.yml',
      'docker-compose.yaml',
      'fly.toml',
      'render.yaml',
    ])
    let addition = `**Platform:** ${info.deployment.join(', ')}`
    if (cfg.length > 0) {
      addition += `\n\n**Config files:** ${cfg.map(f => `\`${f}\``).join(', ')}`
    }
    content = content.replace(archMarker, addition + '\n\n' + archMarker)
  }

  if (content !== orig) {
    await writeFile(filePath, content, 'utf8')
    result.populated.push('stack/deployment-config.md')
  }
}

async function handleDatabaseConfig(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'database-config.md')
  if (!existsSync(filePath)) return

  if (!info.databases?.length) {
    await unlink(filePath)
    result.removed.push('stack/database-config.md')
    return
  }

  let content = await readFile(filePath, 'utf8')
  const provider = info.databases[0]

  const integrationMarker =
    '<!-- Auth library path, migration directory, session pattern, role system overview. -->'
  if (content.includes(integrationMarker)) {
    const cfg = filterConfigFiles(info.configFiles, [
      'supabase/config.toml',
      'prisma/schema.prisma',
      'drizzle.config.ts',
      'drizzle.config.js',
    ])
    let addition = `**Provider:** ${provider}`
    if (cfg.length > 0) {
      addition += `\n\n**Config files:** ${cfg.map(f => `\`${f}\``).join(', ')}`
    }
    addition += '\n\n<!-- TODO: verify -->'
    content = content.replace(integrationMarker, addition + '\n\n' + integrationMarker)
  }

  if (info.databases.length === 1) {
    const newName = `${provider}-config.md`
    const newPath = join(opencastleDir, 'stack', newName)
    await writeFile(newPath, content, 'utf8')
    await unlink(filePath)
    result.renamed.push(`stack/database-config.md \u2192 stack/${newName}`)
  } else {
    await writeFile(filePath, content, 'utf8')
    result.populated.push('stack/database-config.md')
  }
}

async function handleCmsConfig(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'cms-config.md')
  if (!existsSync(filePath)) return

  if (!info.cms?.length) {
    await unlink(filePath)
    result.removed.push('stack/cms-config.md')
    return
  }

  let content = await readFile(filePath, 'utf8')
  const provider = info.cms[0]

  const configMarker = '<!-- CMS project IDs, dataset, API version, studio location, etc. -->'
  if (content.includes(configMarker)) {
    const cfg = filterConfigFiles(info.configFiles, [
      'sanity.config.ts',
      'sanity.config.js',
      '.contentful.json',
      'payload.config.ts',
    ])
    let addition = `**Provider:** ${provider}`
    if (cfg.length > 0) {
      addition += `\n\n**Config files:** ${cfg.map(f => `\`${f}\``).join(', ')}`
    }
    addition += '\n\n<!-- TODO: verify -->'
    content = content.replace(configMarker, addition + '\n\n' + configMarker)
  }

  if (info.cms.length === 1) {
    const newName = `${provider}-config.md`
    const newPath = join(opencastleDir, 'stack', newName)
    await writeFile(newPath, content, 'utf8')
    await unlink(filePath)
    result.renamed.push(`stack/cms-config.md \u2192 stack/${newName}`)
  } else {
    await writeFile(filePath, content, 'utf8')
    result.populated.push('stack/cms-config.md')
  }
}

async function removeNotificationsIfUnused(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'notifications-config.md')
  if (!existsSync(filePath) || info.notifications?.length) return
  await unlink(filePath)
  result.removed.push('stack/notifications-config.md')
}

async function handleApiConfig(
  opencastleDir: string,
  info: RepoInfo,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'api-config.md')
  if (!existsSync(filePath)) return

  if (!info.frameworks?.length) {
    await unlink(filePath)
    result.removed.push('stack/api-config.md')
    return
  }

  let content = await readFile(filePath, 'utf8')
  const orig = content

  const initMarker =
    '<!-- Populated by `opencastle init` based on detected API routes and Server Actions. -->'
  if (content.includes(initMarker)) {
    const frameworkList = info.frameworks.join(', ')
    content = content.replace(
      initMarker,
      `<!-- Populated by \`opencastle init\`. Framework: ${frameworkList} -->`,
    )
  }

  if (content !== orig) {
    await writeFile(filePath, content, 'utf8')
    result.populated.push('stack/api-config.md')
  }
}

async function removeDataPipelineConfig(
  opencastleDir: string,
  result: BootstrapResult,
): Promise<void> {
  const filePath = join(opencastleDir, 'stack', 'data-pipeline-config.md')
  if (!existsSync(filePath)) return
  await unlink(filePath)
  result.removed.push('stack/data-pipeline-config.md')
}

const TRACKER_TOOLS = new Set<string>(['linear', 'jira', 'trello'])

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
  const displayName = tracker.charAt(0).toUpperCase() + tracker.slice(1)

  content = content.replace('# Task Tracker Configuration', `# ${displayName} Configuration`)

  const renameComment =
    '<!-- Populated by `opencastle init`.\n     Rename this file to match your tracker: linear-config.md, jira-config.md, etc. -->'
  content = content.replace(renameComment + '\n', '')

  const newName = `${tracker}-config.md`
  const newPath = join(opencastleDir, 'project', newName)
  await writeFile(newPath, content, 'utf8')
  await unlink(filePath)
  result.renamed.push(`project/tracker-config.md \u2192 project/${newName}`)
}

// ── Main export ────────────────────────────────────────────────

export async function bootstrapCustomizations(
  projectRoot: string,
  repoInfo: RepoInfo,
  stack: StackConfig,
): Promise<BootstrapResult> {
  const opencastleDir = join(projectRoot, '.opencastle')
  const result: BootstrapResult = { populated: [], removed: [], renamed: [] }

  const pkg = (await tryReadJson<PackageJson>(join(projectRoot, 'package.json'))) ?? {}

  await populateProjectInstructions(opencastleDir, projectRoot, repoInfo, pkg, result)
  await populateTestingConfig(opencastleDir, repoInfo, result)
  await populateDeploymentConfig(opencastleDir, repoInfo, result)
  await handleDatabaseConfig(opencastleDir, repoInfo, result)
  await handleCmsConfig(opencastleDir, repoInfo, result)
  await removeNotificationsIfUnused(opencastleDir, repoInfo, result)
  await handleApiConfig(opencastleDir, repoInfo, result)
  await removeDataPipelineConfig(opencastleDir, result)
  await handleTrackerConfig(opencastleDir, repoInfo, stack, result)

  return result
}
