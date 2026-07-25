/**
 * Tests for the init command — validates that all IDE adapters generate
 * correct files based on stack selections (tech tools, team tools, IDEs).
 *
 * Tests the dynamic parts:
 *   - Excluded agents (no CMS → no content-engineer, no DB → no data-engineer)
 *   - Excluded skills (only selected plugin skills are installed)
 *   - Plugin skills (SKILL.md from plugin dirs)
 *   - MCP config generation per IDE format
 *   - Agent tool injection from plugin agentToolMap
 *   - Skill matrix transform (database/cms rows filled)
 *   - Gitignore block generation
 *   - Single-file root documents (CLAUDE.md, AGENTS.md)
 *   - Cursor .mdc conversion
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import type { StackConfig, RepoInfo } from './types.js'
import { updateGitignore } from './gitignore.js'
import {
  getExcludedSkills,
  getExcludedAgents,
  getIncludedMcpServers,
  getRequiredMcpEnvVars,
  getAgentToolInjections,
  getCustomizationsTransform,
} from './stack-config.js'
import { ALL_PLUGIN_SKILL_NAMES } from '../orchestrator/plugins/index.js'
import { IDE_ADAPTERS } from './adapters/index.js'
import { copyDir, getOrchestratorRoot } from './copy.js'

// ── Helpers ────────────────────────────────────────────────────

/** The real package root — tests run against the actual source tree. */
const PKG_ROOT = resolve(import.meta.dirname, '../..')

/** Read a JSON file from disk. */
async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

/** Simulate the init.ts customizations scaffold step (copies customizations to .opencastle/). */
async function scaffoldCustomizations(pkgRoot: string, projectRoot: string, stack: StackConfig): Promise<void> {
  const custSrcDir = resolve(getOrchestratorRoot(pkgRoot), 'customizations')
  if (existsSync(custSrcDir)) {
    const custDestDir = join(projectRoot, '.opencastle')
    const custTransform = getCustomizationsTransform(stack)
    await copyDir(custSrcDir, custDestDir, { transform: custTransform })
  }
}

/** Recursively list all files in a directory (relative paths). */
async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(join(dir, entry.name), rel))
    } else {
      files.push(rel)
    }
  }
  return files.sort()
}

// ── Stack fixtures ─────────────────────────────────────────────

const STACK_EMPTY: StackConfig = {
  ides: ['vscode'],
  techTools: [],
  teamTools: [],
}

const STACK_SANITY_LINEAR: StackConfig = {
  ides: ['vscode'],
  techTools: ['sanity'],
  teamTools: ['linear'],
}

const STACK_SUPABASE_SLACK: StackConfig = {
  ides: ['vscode'],
  techTools: ['supabase'],
  teamTools: ['slack'],
}

const STACK_TRELLO_NOTION: StackConfig = {
  ides: ['vscode'],
  techTools: [],
  teamTools: ['trello', 'notion'],
}

const STACK_FULL: StackConfig = {
  ides: ['vscode', 'cursor', 'claude-code', 'opencode', 'windsurf', 'codex', 'antigravity'],
  techTools: ['sanity', 'supabase', 'vercel'],
  teamTools: ['linear', 'slack'],
}

const EMPTY_REPO_INFO: RepoInfo = {}

// ═══════════════════════════════════════════════════════════════
// § 1  Stack Config Logic (pure functions — no filesystem)
// ═══════════════════════════════════════════════════════════════

describe('stack-config: getExcludedAgents', () => {
  it('excludes content-engineer when no CMS tool is selected', () => {
    const excluded = getExcludedAgents(STACK_EMPTY)
    expect(excluded.has('content-engineer.agent.md')).toBe(true)
    expect(excluded.has('data-engineer.agent.md')).toBe(true)
  })

  it('includes content-engineer when a CMS tool is selected', () => {
    const excluded = getExcludedAgents(STACK_SANITY_LINEAR)
    expect(excluded.has('content-engineer.agent.md')).toBe(false)
    // No DB selected → data-engineer still excluded
    expect(excluded.has('data-engineer.agent.md')).toBe(true)
  })

  it('includes data-engineer when a DB tool is selected', () => {
    const excluded = getExcludedAgents(STACK_SUPABASE_SLACK)
    expect(excluded.has('data-engineer.agent.md')).toBe(false)
    // No CMS selected → content-engineer still excluded
    expect(excluded.has('content-engineer.agent.md')).toBe(true)
  })

  it('includes both when CMS and DB are selected', () => {
    const excluded = getExcludedAgents(STACK_FULL)
    expect(excluded.has('content-engineer.agent.md')).toBe(false)
    expect(excluded.has('data-engineer.agent.md')).toBe(false)
  })
})

describe('stack-config: getExcludedSkills', () => {
  it('excludes all plugin skills when nothing is selected', () => {
    const excluded = getExcludedSkills(STACK_EMPTY)
    // Every plugin-specific skill should be excluded
    for (const skill of ALL_PLUGIN_SKILL_NAMES) {
      expect(excluded.has(skill)).toBe(true)
    }
  })

  it('includes only selected plugin skills', () => {
    const excluded = getExcludedSkills(STACK_SANITY_LINEAR)
    expect(excluded.has('sanity-cms')).toBe(false)
    expect(excluded.has('linear-task-management')).toBe(false)
    // Unselected skills should still be excluded
    expect(excluded.has('supabase-database')).toBe(true)
    expect(excluded.has('slack-notifications')).toBe(true)
    expect(excluded.has('vercel-deployment')).toBe(true)
  })

  it('includes trello and notion skills when selected', () => {
    const excluded = getExcludedSkills(STACK_TRELLO_NOTION)
    expect(excluded.has('trello-task-management')).toBe(false)
    expect(excluded.has('notion-knowledge-management')).toBe(false)
    expect(excluded.has('linear-task-management')).toBe(true)
    expect(excluded.has('slack-notifications')).toBe(true)
  })
})

describe('stack-config: getIncludedMcpServers', () => {
  it('returns empty set when nothing selected', () => {
    const servers = getIncludedMcpServers(STACK_EMPTY)
    expect(servers.size).toBe(0)
  })

  it('includes servers for selected tech and team tools', () => {
    const servers = getIncludedMcpServers(STACK_SANITY_LINEAR)
    expect(servers.has('Sanity')).toBe(true)
    expect(servers.has('Linear')).toBe(true)
    expect(servers.has('Supabase')).toBe(false)
  })

  it('auto-includes Vercel when detected in deployment', () => {
    const repoInfo: RepoInfo = { deployment: ['vercel'] }
    const servers = getIncludedMcpServers(STACK_EMPTY, repoInfo)
    expect(servers.has('Vercel')).toBe(true)
  })

  it('auto-includes NX when monorepo detected and not in stack', () => {
    const repoInfo: RepoInfo = { monorepo: 'nx' }
    const servers = getIncludedMcpServers(STACK_EMPTY, repoInfo)
    expect(servers.has('Nx')).toBe(true)
  })
})

describe('stack-config: getRequiredMcpEnvVars', () => {
  it('returns empty when no tools need env vars', () => {
    // Sanity uses OAuth (no env vars), so only Linear needs one
    const vars = getRequiredMcpEnvVars({
      ides: ['vscode'],
      techTools: ['sanity'],
      teamTools: [],
    })
    expect(vars).toHaveLength(0)
  })

  it('returns LINEAR_API_KEY when linear is selected', () => {
    const vars = getRequiredMcpEnvVars(STACK_SANITY_LINEAR)
    expect(vars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envVar: 'LINEAR_API_KEY' }),
      ])
    )
  })

  it('returns SLACK_MCP_XOXB_TOKEN when slack is selected', () => {
    const vars = getRequiredMcpEnvVars(STACK_SUPABASE_SLACK)
    expect(vars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envVar: 'SLACK_MCP_XOXB_TOKEN' }),
      ])
    )
  })

  it('returns trello env vars when trello is selected', () => {
    const vars = getRequiredMcpEnvVars({
      ides: ['vscode'],
      techTools: [],
      teamTools: ['trello'],
    })
    expect(vars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envVar: 'TRELLO_API_KEY' }),
        expect.objectContaining({ envVar: 'TRELLO_TOKEN' }),
      ])
    )
  })
})

describe('stack-config: getAgentToolInjections', () => {
  it('returns empty map when no tools selected', () => {
    const injections = getAgentToolInjections(STACK_EMPTY)
    expect(injections.size).toBe(0)
  })

  it('injects sanity tools into content-engineer when sanity selected', () => {
    const injections = getAgentToolInjections(STACK_SANITY_LINEAR)
    const contentTools = injections.get('content-engineer')
    expect(contentTools).toBeDefined()
    expect(contentTools).toContain('sanity/get_schema')
    expect(contentTools).toContain('sanity/query_documents')
  })

  it('injects linear tools into team-lead when linear selected', () => {
    const injections = getAgentToolInjections(STACK_SANITY_LINEAR)
    const teamLeadTools = injections.get('team-lead')
    expect(teamLeadTools).toBeDefined()
    expect(teamLeadTools).toContain('linear/create_issue')
    expect(teamLeadTools).toContain('linear/list_issues')
  })

  it('injects supabase tools into data-engineer when supabase selected', () => {
    const injections = getAgentToolInjections(STACK_SUPABASE_SLACK)
    const dbTools = injections.get('data-engineer')
    expect(dbTools).toBeDefined()
    expect(dbTools).toContain('supabase/apply_migration')
    expect(dbTools).toContain('supabase/execute_sql')
  })

  it('aggregates tools from multiple plugins per agent', () => {
    const injections = getAgentToolInjections(STACK_FULL)
    const teamLeadTools = injections.get('team-lead')!
    // Linear + Slack tools on team-lead
    expect(teamLeadTools).toContain('linear/create_issue')
    expect(teamLeadTools).toContain('slack/*')
  })

  it('injects notion tools into relevant agents when notion selected', () => {
    const injections = getAgentToolInjections({
      ides: ['vscode'],
      techTools: [],
      teamTools: ['notion'],
    })

    const teamLeadTools = injections.get('team-lead')
    expect(teamLeadTools).toBeDefined()
    expect(teamLeadTools).toContain('Notion/search')
    expect(teamLeadTools).toContain('Notion/query_database')

    const architectTools = injections.get('architect')
    expect(architectTools).toBeDefined()
    expect(architectTools).toContain('Notion/create_page')
    expect(architectTools).toContain('Notion/update_page')
  })
})

describe('stack-config: getCustomizationsTransform', () => {
  const emptyMatrix = JSON.stringify({
    bindings: {
      database: { entries: [], description: 'Schema' },
      cms: { entries: [], description: 'CMS' },
    },
    agents: {},
  }, null, 2) + '\n'

  it('fills database slot in skill-matrix.json when DB tool is selected', () => {
    const transform = getCustomizationsTransform(STACK_SUPABASE_SLACK)
    const result = transform(emptyMatrix, 'skill-matrix.json')
    expect(result).toContain('Supabase')
    expect(result).toContain('supabase-database')
  })

  it('fills CMS slot in skill-matrix.json when CMS tool is selected', () => {
    const transform = getCustomizationsTransform(STACK_SANITY_LINEAR)
    const result = transform(emptyMatrix, 'skill-matrix.json')
    expect(result).toContain('Sanity')
    expect(result).toContain('sanity-cms')
  })

  it('leaves slots empty when no DB or CMS selected', () => {
    const transform = getCustomizationsTransform(STACK_EMPTY)
    const result = transform(emptyMatrix, 'skill-matrix.json')
    const data = JSON.parse(result as string)
    expect(data.bindings.database.entries).toEqual([])
    expect(data.bindings.cms.entries).toEqual([])
  })

  it('passes through non-skill-matrix files unchanged', () => {
    const transform = getCustomizationsTransform(STACK_FULL)
    const input = '# Some other file\nContent here'
    const result = transform(input, 'something-else.md')
    expect(result).toBe(input)
  })
})

// ═══════════════════════════════════════════════════════════════
// § 2  Gitignore Generation
// ═══════════════════════════════════════════════════════════════

describe('gitignore generation', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-init-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not ignore generated config — it must be committed for teammates and CI', async () => {
    await updateGitignore(tempDir)
    const content = await readFile(join(tempDir, '.gitignore'), 'utf8')

    // The compiled output is committed, like a lockfile.
    expect(content).not.toContain('.github/copilot-instructions.md')
    expect(content).not.toContain('CLAUDE.md')
    expect(content).not.toMatch(/^\.claude\/agents\/$/m)
    // Secrets and run artefacts stay local.
    expect(content).toContain('.env')
    expect(content).toContain('.opencastle/logs/')
    expect(content).toContain('.opencastle/*.db')
    expect(content).toContain('# >>> OpenCastle managed (do not edit) >>>')
    expect(content).toContain('# <<< OpenCastle managed <<<')
  })

  it('replaces existing block on re-init', async () => {
    await updateGitignore(tempDir)
    const result = await updateGitignore(tempDir)
    expect(result).toBe('unchanged')

    const content = await readFile(join(tempDir, '.gitignore'), 'utf8')
    const startCount = (content.match(/>>> OpenCastle managed/g) ?? []).length
    expect(startCount).toBe(1)
  })

  it('keeps the user\'s own gitignore rules when adding the block', async () => {
    await writeFile(join(tempDir, '.gitignore'), 'node_modules\ndist/\n')
    await updateGitignore(tempDir)
    const content = await readFile(join(tempDir, '.gitignore'), 'utf8')
    expect(content).toContain('node_modules')
    expect(content).toContain('dist/')
    expect(content).toContain('.opencastle/logs/')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 3  VS Code Adapter — Full Install Validation
// ═══════════════════════════════════════════════════════════════

describe('VS Code adapter install', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-vscode-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates all expected framework directories', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const githubDir = join(tempDir, '.github')
    expect(existsSync(join(githubDir, 'copilot-instructions.md'))).toBe(true)
    expect(existsSync(join(githubDir, 'agents'))).toBe(true)
    expect(existsSync(join(githubDir, 'instructions'))).toBe(true)
    expect(existsSync(join(githubDir, 'skills'))).toBe(true)
    expect(existsSync(join(githubDir, 'agent-workflows'))).toBe(true)
    expect(existsSync(join(githubDir, 'prompts'))).toBe(true)
    expect(existsSync(join(tempDir, '.vscode', 'mcp.json'))).toBe(true)
  })

  it('creates all observability log files in .opencastle/logs', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)
    await scaffoldCustomizations(PKG_ROOT, tempDir, STACK_EMPTY)

    const logsDir = join(tempDir, '.opencastle', 'logs')
    expect(existsSync(logsDir)).toBe(true)
    for (const file of ['events.ndjson']) {
      expect(existsSync(join(logsDir, file))).toBe(true)
    }
  })

  it('excludes content-engineer and data-engineer agents when no CMS/DB', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const agentsDir = join(tempDir, '.github', 'agents')
    const agents = await readdir(agentsDir)

    expect(agents).not.toContain('content-engineer.agent.md')
    expect(agents).not.toContain('data-engineer.agent.md')
    // Others should still be present
    expect(agents).toContain('developer.agent.md')
    expect(agents).toContain('team-lead.agent.md')
    expect(agents).toContain('architect.agent.md')
  })

  it('includes content-engineer when CMS tool is selected', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const agents = await readdir(join(tempDir, '.github', 'agents'))
    expect(agents).toContain('content-engineer.agent.md')
    expect(agents).not.toContain('data-engineer.agent.md')
  })

  it('includes data-engineer when DB tool is selected', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SUPABASE_SLACK, EMPTY_REPO_INFO)

    const agents = await readdir(join(tempDir, '.github', 'agents'))
    expect(agents).toContain('data-engineer.agent.md')
    expect(agents).not.toContain('content-engineer.agent.md')
  })

  it('excludes unselected plugin skills from skills directory', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const skillsDir = join(tempDir, '.github', 'skills')
    const skills = await readdir(skillsDir)

    // Selected plugin skills should be present
    expect(skills).toContain('sanity')
    expect(skills).toContain('linear')
    // Unselected plugin skills should NOT be present
    expect(skills).not.toContain('supabase')
    expect(skills).not.toContain('slack')
    expect(skills).not.toContain('vercel')

    // Core skills (non-plugin) should always be present
    expect(skills).toContain('accessibility-standards')
    expect(skills).toContain('self-improvement')
    expect(skills).toContain('testing-workflow')
  })

  it('excludes unselected core skills that map to plugins', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const skills = await readdir(join(tempDir, '.github', 'skills'))
    // Plugin-linked skill directories should be absent if tool not selected
    // (The core skills directory names don't match plugin IDs — they're separate)
    // But plugin SKILL.md dirs should not exist
    expect(skills).not.toContain('sanity')
    expect(skills).not.toContain('linear')
    expect(skills).not.toContain('supabase')
  })

  it('injects plugin tools into agent frontmatter', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    // Read content-engineer agent — should have sanity tools injected
    const contentEngineer = await readFile(
      join(tempDir, '.github', 'agents', 'content-engineer.agent.md'),
      'utf8'
    )
    expect(contentEngineer).toContain("'sanity/get_schema'")
    expect(contentEngineer).toContain("'sanity/query_documents'")
    expect(contentEngineer).toContain("'sanity/deploy_schema'")

    // Read team-lead agent — should have linear tools injected
    const teamLead = await readFile(
      join(tempDir, '.github', 'agents', 'team-lead.agent.md'),
      'utf8'
    )
    expect(teamLead).toContain("'linear/create_issue'")
    expect(teamLead).toContain("'linear/list_issues'")
    expect(teamLead).toContain("'linear/update_issue'")
  })

  it('does NOT inject tools when no plugins selected', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const teamLead = await readFile(
      join(tempDir, '.github', 'agents', 'team-lead.agent.md'),
      'utf8'
    )
    expect(teamLead).not.toContain('linear/')
    expect(teamLead).not.toContain('sanity/')
    expect(teamLead).not.toContain('supabase/')
  })

  it('generates VS Code MCP config with correct format (servers + inputs)', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, '.vscode', 'mcp.json')
    )

    // VS Code format uses "servers" key
    expect(mcpConfig).toHaveProperty('servers')
    const servers = mcpConfig.servers as Record<string, unknown>
    expect(servers).toHaveProperty('Sanity')
    expect(servers).toHaveProperty('Linear')

    // Sanity uses HTTP
    const sanityServer = servers.Sanity as Record<string, unknown>
    expect(sanityServer.type).toBe('http')
    expect(sanityServer.url).toBe('https://mcp.sanity.io')

    // Linear uses stdio
    const linearServer = servers.Linear as Record<string, unknown>
    expect(linearServer.type).toBe('stdio')
    expect(linearServer.command).toBe('npx')
    expect(linearServer.args).toContain('-y')
    expect(linearServer.args).toContain('@mseep/linear-mcp')
  })

  it('generates empty MCP config when no tools selected', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, '.vscode', 'mcp.json')
    )
    expect(mcpConfig).toHaveProperty('servers')
    const servers = mcpConfig.servers as Record<string, unknown>
    expect(Object.keys(servers)).toHaveLength(0)
  })

  it('fills skill-matrix.json with selected DB and CMS', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_FULL, EMPTY_REPO_INFO)
    await scaffoldCustomizations(PKG_ROOT, tempDir, STACK_FULL)

    const skillMatrix = await readFile(
      join(tempDir, '.opencastle', 'agents', 'skill-matrix.json'),
      'utf8'
    )
    const data = JSON.parse(skillMatrix)
    expect(data.bindings.database.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Supabase', skill: 'supabase-database' })])
    )
    expect(data.bindings.cms.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Sanity', skill: 'sanity-cms' })])
    )
  })

  it('leaves skill-matrix.json database/cms slots empty when none selected', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)
    await scaffoldCustomizations(PKG_ROOT, tempDir, STACK_EMPTY)

    const skillMatrix = await readFile(
      join(tempDir, '.opencastle', 'agents', 'skill-matrix.json'),
      'utf8'
    )
    const data = JSON.parse(skillMatrix)
    expect(data.bindings.database.entries).toEqual([])
    expect(data.bindings.cms.entries).toEqual([])
  })

  it('getManagedPaths returns expected structure', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()
    const paths = adapter.getManagedPaths()

    expect(paths.merged).toContain('.github/copilot-instructions.md')
    expect(paths.framework).not.toContain('.github/copilot-instructions.md')
    expect(paths.framework).toContain('.github/agents/')
    expect(paths.framework).toContain('.github/instructions/')
    expect(paths.framework).toContain('.github/skills/')
    expect(paths.framework).toContain('.github/agent-workflows/')
    expect(paths.framework).toContain('.github/prompts/')

    expect(paths.customizable).toContain('.opencastle/')
    expect(paths.customizable).toContain('.vscode/mcp.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 4  Cursor Adapter — .mdc Conversion & Format Validation
// ═══════════════════════════════════════════════════════════════

describe('Cursor adapter install', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-cursor-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates .cursorrules with intro text', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const content = await readFile(join(tempDir, '.cursorrules'), 'utf8')
    expect(content).toContain('# Project Instructions')
    expect(content).toContain('.cursor/rules/')
  })

  it('converts instruction files to .mdc with alwaysApply: true', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const rulesDir = join(tempDir, '.cursor', 'rules')
    const generalMdc = await readFile(join(rulesDir, 'general.mdc'), 'utf8')

    // Should have .mdc frontmatter
    expect(generalMdc).toMatch(/^---\n/)
    expect(generalMdc).toContain('alwaysApply: true')
    // Should still contain the original body content
    expect(generalMdc).toContain('Coding Standards')
  })

  it('converts agent files to .mdc in agents/ subdirectory', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const agentsDir = join(tempDir, '.cursor', 'rules', 'agents')
    const agents = await readdir(agentsDir)

    // .agent.md → .mdc
    expect(agents).toContain('developer.mdc')
    expect(agents).toContain('team-lead.mdc')
    expect(agents).not.toContain('content-engineer.mdc') // no CMS
    expect(agents).not.toContain('data-engineer.mdc') // no DB

    // Validate .mdc structure
    const devAgent = await readFile(join(agentsDir, 'developer.mdc'), 'utf8')
    expect(devAgent).toMatch(/^---\n/)
    expect(devAgent).toContain('description:')
  })

  it('includes content-engineer.mdc when CMS selected', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const agents = await readdir(join(tempDir, '.cursor', 'rules', 'agents'))
    expect(agents).toContain('content-engineer.mdc')
  })

  it('converts skills to .mdc in skills/ subdirectory', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const skillsDir = join(tempDir, '.cursor', 'rules', 'skills')
    const skills = await readdir(skillsDir)

    // Core skills should be present
    expect(skills).toContain('self-improvement.mdc')
    expect(skills).toContain('testing-workflow.mdc')

    // Selected plugin skills as .mdc
    expect(skills).toContain('sanity.mdc')
    expect(skills).toContain('linear.mdc')

    // Unselected plugin skills should not be present
    expect(skills).not.toContain('supabase.mdc')
    expect(skills).not.toContain('slack.mdc')
  })

  it('generates Cursor MCP config with mcpServers format', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, '.cursor', 'mcp.json')
    )

    // Cursor format uses "mcpServers" key (not "servers")
    expect(mcpConfig).toHaveProperty('mcpServers')
    expect(mcpConfig).not.toHaveProperty('servers')

    const servers = mcpConfig.mcpServers as Record<string, Record<string, unknown>>

    // HTTP servers get url only (no type field)
    expect(servers.Sanity).toBeDefined()
    expect(servers.Sanity.url).toBe('https://mcp.sanity.io')
    expect(servers.Sanity).not.toHaveProperty('type')

    // stdio servers get command + args (no type field)
    expect(servers.Linear).toBeDefined()
    expect(servers.Linear.command).toBe('npx')
    expect(servers.Linear.args).toContain('@mseep/linear-mcp')
    expect(servers.Linear).not.toHaveProperty('type')
  })

  it('getManagedPaths returns expected Cursor paths', async () => {
    const adapter = await IDE_ADAPTERS['cursor']()
    const paths = adapter.getManagedPaths()

    expect(paths.merged).toContain('.cursorrules')
    expect(paths.framework).not.toContain('.cursorrules')
    expect(paths.framework).toContain('.cursor/rules/agents/')
    expect(paths.framework).toContain('.cursor/rules/skills/')
    expect(paths.framework).toContain('.cursor/rules/general.mdc')
    expect(paths.framework).toContain('.cursor/rules/ai-optimization.mdc')

    expect(paths.customizable).toContain('.opencastle/')
    expect(paths.customizable).toContain('.cursor/mcp.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 5  Claude Code Adapter — Single-File Root Document
// ═══════════════════════════════════════════════════════════════

describe('Claude Code adapter install', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-claude-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates CLAUDE.md with embedded instructions', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    expect(existsSync(join(tempDir, 'CLAUDE.md'))).toBe(true)

    const content = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    // Should contain merged instruction content
    expect(content).toContain('# Project Instructions')
    expect(content).toContain('Coding Standards')
    expect(content).toContain('.claude/skills/')
    expect(content).toContain('.claude/agents/')
  })

  it('CLAUDE.md lists all non-excluded agents', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const content = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(content).toContain('## Agent Definitions')
    expect(content).toContain('**Developer**')
    expect(content).toContain('**Team Lead (OpenCastle)**')
    // Should NOT list excluded agents
    expect(content).not.toContain('**Content Engineer**')
    expect(content).not.toContain('**Data Engineer**')
  })

  it('CLAUDE.md includes content engineer when CMS selected', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const content = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(content).toContain('**Content Engineer**')
    expect(content).not.toContain('**Data Engineer**')
  })

  it('CLAUDE.md lists available skills (including selected plugins)', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const content = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(content).toContain('## Available Skills')
    expect(content).toContain('**self-improvement**')
    expect(content).toContain('**sanity**')
    expect(content).toContain('**linear**')
    // Unselected plugin skills should NOT appear in skill index
    expect(content).not.toMatch(/\*\*supabase\*\*/)
  })

  it('strips frontmatter from agent files in .claude/agents/', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const agentsDir = join(tempDir, '.claude', 'agents')
    const agents = await readdir(agentsDir)
    expect(agents).toContain('developer.agent.md')
    expect(agents).not.toContain('content-engineer.agent.md')
    expect(agents).not.toContain('data-engineer.agent.md')

    const devAgent = await readFile(join(agentsDir, 'developer.agent.md'), 'utf8')
    // Should NOT start with frontmatter
    expect(devAgent).not.toMatch(/^---\n/)
    // Should contain the body content (starts with comment or heading)
    expect(devAgent).toContain('Developer')
  })

  it('creates skills as <name>/SKILL.md subfolders with frontmatter preserved', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const skillsDir = join(tempDir, '.claude', 'skills')
    const entries = await readdir(skillsDir)

    // Skills are subdirectories (Anthropic's Claude Code Skills format)
    expect(entries).toContain('self-improvement')
    expect(entries).toContain('sanity')
    expect(entries).toContain('linear')
    expect(entries).not.toContain('supabase')

    // SKILL.md exists inside each skill subdirectory
    const skillContent = await readFile(
      join(skillsDir, 'self-improvement', 'SKILL.md'),
      'utf8'
    )
    // Frontmatter is preserved — Claude Code uses the description: field for skill discovery
    expect(skillContent).toMatch(/^---\n/)
    expect(skillContent).toMatch(/\ndescription:/)
  })

  it('generates Claude Code MCP config with mcpServers format', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, '.mcp.json')
    )
    expect(mcpConfig).toHaveProperty('mcpServers')
    expect(mcpConfig).not.toHaveProperty('servers')
  })

  it('creates prompts in .claude/commands/', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const commandsDir = join(tempDir, '.claude', 'commands')
    expect(existsSync(commandsDir)).toBe(true)
    const commands = await readdir(commandsDir)
    // Should have prompt files
    expect(commands.length).toBeGreaterThan(0)
    // All should be .md files
    expect(commands.every((f) => f.endsWith('.md'))).toBe(true)
  })

  it('creates workflows as commands with workflow- prefix', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const commandsDir = join(tempDir, '.claude', 'commands')
    const commands = await readdir(commandsDir)
    // Workflow files should have the "workflow-" prefix
    const workflows = commands.filter((f) => f.startsWith('workflow-'))
    expect(workflows.length).toBeGreaterThan(0)
  })

  it('getManagedPaths includes CLAUDE.md and .claude dirs', async () => {
    const adapter = await IDE_ADAPTERS['claude-code']()
    const paths = adapter.getManagedPaths()

    expect(paths.merged).toContain('CLAUDE.md')
    expect(paths.framework).not.toContain('CLAUDE.md')
    expect(paths.framework).toContain('.claude/agents/')
    expect(paths.framework).toContain('.claude/skills/')
    expect(paths.framework).toContain('.claude/commands/')

    expect(paths.customizable).toContain('.opencastle/')
    expect(paths.customizable).toContain('.mcp.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 6  OpenCode Adapter — Single-File Root Document
// ═══════════════════════════════════════════════════════════════

describe('OpenCode adapter install', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-opencode-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates AGENTS.md with embedded instructions', async () => {
    const adapter = await IDE_ADAPTERS['opencode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    expect(existsSync(join(tempDir, 'AGENTS.md'))).toBe(true)

    const content = await readFile(join(tempDir, 'AGENTS.md'), 'utf8')
    expect(content).toContain('# Project Instructions')
    expect(content).toContain('.opencode/skills/')
    expect(content).toContain('.opencode/agents/')
  })

  it('creates files in .opencode/ directory structure', async () => {
    const adapter = await IDE_ADAPTERS['opencode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    expect(existsSync(join(tempDir, '.opencode', 'agents'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencode', 'skills'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencode', 'prompts'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencode', 'workflows'))).toBe(true)
  })

  it('generates OpenCode MCP config with mcp format', async () => {
    const adapter = await IDE_ADAPTERS['opencode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, 'opencode.json')
    )

    // OpenCode format uses "mcp" key
    expect(mcpConfig).toHaveProperty('mcp')
    expect(mcpConfig).not.toHaveProperty('servers')
    expect(mcpConfig).not.toHaveProperty('mcpServers')

    const mcp = mcpConfig.mcp as Record<string, Record<string, unknown>>

    // HTTP servers → type: 'remote'
    expect(mcp.Sanity).toBeDefined()
    expect(mcp.Sanity.type).toBe('remote')
    expect(mcp.Sanity.url).toBe('https://mcp.sanity.io')

    // stdio servers → type: 'local', command as array
    expect(mcp.Linear).toBeDefined()
    expect(mcp.Linear.type).toBe('local')
    expect(mcp.Linear.command).toEqual(['npx', '-y', '@mseep/linear-mcp'])
  })

  it('workflows do NOT have prefix in opencode adapter', async () => {
    const adapter = await IDE_ADAPTERS['opencode']()
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    const wfDir = join(tempDir, '.opencode', 'workflows')
    if (existsSync(wfDir)) {
      const workflows = await readdir(wfDir)
      // OpenCode config has workflowPrefix: '' — no prefix
      const prefixed = workflows.filter((f) => f.startsWith('workflow-'))
      expect(prefixed).toHaveLength(0)
    }
  })

  it('getManagedPaths includes AGENTS.md and .opencode dirs', async () => {
    const adapter = await IDE_ADAPTERS['opencode']()
    const paths = adapter.getManagedPaths()

    expect(paths.merged).toContain('AGENTS.md')
    expect(paths.framework).not.toContain('AGENTS.md')
    expect(paths.framework).toContain('.opencode/agents/')
    expect(paths.framework).toContain('.opencode/skills/')
    expect(paths.framework).toContain('.opencode/prompts/')
    expect(paths.framework).toContain('.opencode/workflows/')

    expect(paths.customizable).toContain('.opencastle/')
    expect(paths.customizable).toContain('opencode.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 6b  Windsurf Adapter — Rule Conversion & Trigger Validation
// ═══════════════════════════════════════════════════════════════

describe('Windsurf adapter install', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'oc-windsurf-')) })
  afterEach(async () => { await rm(tmpDir, { recursive: true }) })

  it('creates .windsurfrules with intro text', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const content = await readFile(join(tmpDir, '.windsurfrules'), 'utf8')
    expect(content).toContain('Project Instructions')
    expect(content).toContain('.windsurf/rules/')
  })

  it('creates .windsurf/rules/ with .md instruction files (not .mdc)', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const rulesDir = join(tmpDir, '.windsurf', 'rules')
    expect(existsSync(rulesDir)).toBe(true)
    const mdFiles = (await readdir(rulesDir)).filter(f => f.endsWith('.md'))
    expect(mdFiles.length).toBeGreaterThan(0)
    // Should NOT have .mdc files
    const mdcFiles = (await readdir(rulesDir)).filter(f => f.endsWith('.mdc'))
    expect(mdcFiles.length).toBe(0)
  })

  it('uses trigger frontmatter instead of alwaysApply', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const rulesDir = join(tmpDir, '.windsurf', 'rules')
    const mdFiles = (await readdir(rulesDir)).filter(f => f.endsWith('.md'))
    const content = await readFile(join(rulesDir, mdFiles[0]), 'utf8')
    expect(content).toContain('trigger:')
    expect(content).not.toContain('alwaysApply:')
  })

  it('instruction rules use trigger: always_on', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const rulesDir = join(tmpDir, '.windsurf', 'rules')
    const mdFiles = (await readdir(rulesDir)).filter(f => f.endsWith('.md'))
    // All instruction-level rules should be always_on
    for (const file of mdFiles) {
      const content = await readFile(join(rulesDir, file), 'utf8')
      expect(content).toContain('trigger: always_on')
    }
  })

  it('creates agent rules in .windsurf/rules/agents/', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_FULL)
    const agentsDir = join(tmpDir, '.windsurf', 'rules', 'agents')
    expect(existsSync(agentsDir)).toBe(true)
    const files = await readdir(agentsDir)
    expect(files.length).toBeGreaterThan(0)
  })

  it('creates skill rules in .windsurf/rules/skills/', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const skillsDir = join(tmpDir, '.windsurf', 'rules', 'skills')
    expect(existsSync(skillsDir)).toBe(true)
    const files = (await readdir(skillsDir)).filter(f => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
  })

  it('generates Windsurf MCP config with mcpServers format', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const mcpPath = join(tmpDir, '.windsurf', 'mcp.json')
    expect(existsSync(mcpPath)).toBe(true)
    const mcp = await readJson(mcpPath)
    expect(mcp).toHaveProperty('mcpServers')
  })

  it('getManagedPaths returns expected Windsurf paths', async () => {
    const adapter = await IDE_ADAPTERS['windsurf']()
    const paths = adapter.getManagedPaths()
    expect(paths.merged).toContain('.windsurfrules')
    expect(paths.framework).not.toContain('.windsurfrules')
    expect(paths.framework.some(p => p.includes('.windsurf/rules/'))).toBe(true)
    expect(paths.customizable).toContain('.windsurf/mcp.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 6c  Codex Adapter — Single-File Root Document
// ═══════════════════════════════════════════════════════════════

describe('Codex adapter install', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'oc-codex-')) })
  afterEach(async () => { await rm(tmpDir, { recursive: true }) })

  it('creates AGENTS.md root file', async () => {
    const adapter = await IDE_ADAPTERS['codex']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const content = await readFile(join(tmpDir, 'AGENTS.md'), 'utf8')
    expect(content).toContain('Project Instructions')
    expect(content).toContain('.codex/')
  })

  it('creates files in .codex/ directory structure', async () => {
    const adapter = await IDE_ADAPTERS['codex']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    expect(existsSync(join(tmpDir, '.codex', 'agents'))).toBe(true)
    expect(existsSync(join(tmpDir, '.codex', 'skills'))).toBe(true)
  })

  it('generates Codex MCP config with mcpServers format', async () => {
    const adapter = await IDE_ADAPTERS['codex']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const mcpPath = join(tmpDir, '.codex', 'mcp.json')
    expect(existsSync(mcpPath)).toBe(true)
    const mcp = await readJson(mcpPath)
    expect(mcp).toHaveProperty('mcpServers')
  })

  it('getManagedPaths includes AGENTS.md and .codex dirs', async () => {
    const adapter = await IDE_ADAPTERS['codex']()
    const paths = adapter.getManagedPaths()
    expect(paths.merged).toContain('AGENTS.md')
    expect(paths.framework).not.toContain('AGENTS.md')
    expect(paths.framework.some(p => p.includes('.codex/'))).toBe(true)
    expect(paths.customizable).toContain('.codex/mcp.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 6d  Antigravity Adapter — Single-File Root Document
// ═══════════════════════════════════════════════════════════════

describe('Antigravity adapter install', () => {
  let tmpDir: string

  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'oc-antigravity-')) })
  afterEach(async () => { await rm(tmpDir, { recursive: true }) })

  it('creates GEMINI.md root file', async () => {
    const adapter = await IDE_ADAPTERS['antigravity']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const content = await readFile(join(tmpDir, 'GEMINI.md'), 'utf8')
    expect(content).toContain('Project Instructions')
    expect(content).toContain('.agents/')
  })

  it('creates files in .agents/ directory structure', async () => {
    const adapter = await IDE_ADAPTERS['antigravity']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    expect(existsSync(join(tmpDir, '.agents', 'agents'))).toBe(true)
    expect(existsSync(join(tmpDir, '.agents', 'skills'))).toBe(true)
  })

  it('generates Antigravity MCP config with mcpServers format', async () => {
    const adapter = await IDE_ADAPTERS['antigravity']()
    await adapter.install(PKG_ROOT, tmpDir, STACK_SANITY_LINEAR)
    const mcpPath = join(tmpDir, '.agents', 'mcp_config.json')
    expect(existsSync(mcpPath)).toBe(true)
    const mcp = await readJson(mcpPath)
    expect(mcp).toHaveProperty('mcpServers')
  })

  it('getManagedPaths includes GEMINI.md and .agents dirs', async () => {
    const adapter = await IDE_ADAPTERS['antigravity']()
    const paths = adapter.getManagedPaths()
    expect(paths.merged).toContain('GEMINI.md')
    expect(paths.framework).not.toContain('GEMINI.md')
    expect(paths.framework.some(p => p.includes('.agents/'))).toBe(true)
    expect(paths.customizable).toContain('.agents/mcp_config.json')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 7  Cross-Adapter MCP Format Consistency
// ═══════════════════════════════════════════════════════════════

describe('MCP config format per IDE', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-mcp-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const stack = STACK_SANITY_LINEAR

  it('all IDEs include the same MCP servers (same tools = same servers)', async () => {
    const serversByIde: Record<string, string[]> = {}

    for (const ideId of ['vscode', 'cursor', 'claude-code', 'opencode'] as const) {
      const dir = await mkdtemp(join(tmpdir(), `opencastle-mcp-${ideId}-`))
      try {
        const adapter = await IDE_ADAPTERS[ideId]()
        await adapter.install(PKG_ROOT, dir, stack, EMPTY_REPO_INFO)

        const paths: Record<string, string> = {
          vscode: join(dir, '.vscode', 'mcp.json'),
          cursor: join(dir, '.cursor', 'mcp.json'),
          'claude-code': join(dir, '.mcp.json'),
          opencode: join(dir, 'opencode.json'),
        }

        const config = await readJson<Record<string, unknown>>(paths[ideId])
        const containerKey =
          ideId === 'opencode' ? 'mcp' :
          ideId === 'vscode' ? 'servers' :
          'mcpServers'

        const servers = config[containerKey] as Record<string, unknown>
        serversByIde[ideId] = Object.keys(servers).sort()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    // All IDEs should have the same server names
    const vsCodeServers = serversByIde['vscode']
    expect(serversByIde['cursor']).toEqual(vsCodeServers)
    expect(serversByIde['claude-code']).toEqual(vsCodeServers)
    expect(serversByIde['opencode']).toEqual(vsCodeServers)
  })
})

// ═══════════════════════════════════════════════════════════════
// § 8  Cross-Adapter Agent/Skill Parity
// ═══════════════════════════════════════════════════════════════

describe('agent and skill parity across adapters', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-parity-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('all IDEs install the same number of agents for a given stack', async () => {
    const agentCountByIde: Record<string, number> = {}

    for (const ideId of ['vscode', 'cursor', 'claude-code', 'opencode', 'windsurf', 'codex', 'antigravity'] as const) {
      const dir = await mkdtemp(join(tmpdir(), `opencastle-parity-${ideId}-`))
      try {
        const adapter = await IDE_ADAPTERS[ideId]()
        await adapter.install(PKG_ROOT, dir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)

        const agentPaths: Record<string, string> = {
          vscode: join(dir, '.github', 'agents'),
          cursor: join(dir, '.cursor', 'rules', 'agents'),
          'claude-code': join(dir, '.claude', 'agents'),
          opencode: join(dir, '.opencode', 'agents'),
          windsurf: join(dir, '.windsurf', 'rules', 'agents'),
          codex: join(dir, '.codex', 'agents'),
          antigravity: join(dir, '.agents', 'agents'),
        }

        const agents = await readdir(agentPaths[ideId])
        agentCountByIde[ideId] = agents.length
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    // All IDEs should have the same agent count
    const vscodeCount = agentCountByIde['vscode']
    expect(agentCountByIde['cursor']).toBe(vscodeCount)
    expect(agentCountByIde['claude-code']).toBe(vscodeCount)
    expect(agentCountByIde['opencode']).toBe(vscodeCount)
    expect(agentCountByIde['windsurf']).toBe(vscodeCount)
    expect(agentCountByIde['codex']).toBe(vscodeCount)
    expect(agentCountByIde['antigravity']).toBe(vscodeCount)
  })
})

// ═══════════════════════════════════════════════════════════════
// § 9  Idempotency — Re-install Does Not Duplicate
// ═══════════════════════════════════════════════════════════════

describe('install idempotency', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-idempotent-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('second install skips already-existing files (scaffold-once semantics)', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()

    // First install
    const firstResult = await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)
    expect(firstResult.created.length).toBeGreaterThan(0)

    // Second install — same stack
    const secondResult = await adapter.install(PKG_ROOT, tempDir, STACK_SANITY_LINEAR, EMPTY_REPO_INFO)
    // Created files should now be skipped
    expect(secondResult.created.length).toBe(0)
    expect(secondResult.skipped.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// § 10  Full Stack — Complex Configuration
// ═══════════════════════════════════════════════════════════════

describe('full stack configuration', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-fullstack-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('installs with sanity + supabase + vercel + linear + slack', async () => {
    const stack: StackConfig = {
      ides: ['vscode'],
      techTools: ['sanity', 'supabase', 'vercel'],
      teamTools: ['linear', 'slack'],
    }

    const adapter = await IDE_ADAPTERS['vscode']()
    const result = await adapter.install(PKG_ROOT, tempDir, stack, EMPTY_REPO_INFO)
    await scaffoldCustomizations(PKG_ROOT, tempDir, stack)

    expect(result.created.length).toBeGreaterThan(0)

    // Both conditional agents should be included
    const agents = await readdir(join(tempDir, '.github', 'agents'))
    expect(agents).toContain('content-engineer.agent.md')
    expect(agents).toContain('data-engineer.agent.md')

    // All 5 plugin skills should be installed
    const skills = await readdir(join(tempDir, '.github', 'skills'))
    expect(skills).toContain('sanity')
    expect(skills).toContain('supabase')
    expect(skills).toContain('vercel')
    expect(skills).toContain('linear')
    expect(skills).toContain('slack')

    // MCP config should have all 5 servers
    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, '.vscode', 'mcp.json')
    )
    const servers = mcpConfig.servers as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(
      ['Linear', 'Sanity', 'Slack', 'Supabase', 'Vercel'].sort()
    )

    // Agent tool injection — content-engineer should have sanity tools
    const ceContent = await readFile(
      join(tempDir, '.github', 'agents', 'content-engineer.agent.md'),
      'utf8'
    )
    expect(ceContent).toContain("'sanity/get_schema'")

    // Agent tool injection — data-engineer should have supabase tools
    const deContent = await readFile(
      join(tempDir, '.github', 'agents', 'data-engineer.agent.md'),
      'utf8'
    )
    expect(deContent).toContain("'supabase/apply_migration'")

    // Skill matrix should be filled
    const skillMatrix = await readFile(
      join(tempDir, '.opencastle', 'agents', 'skill-matrix.json'),
      'utf8'
    )
    const matrixData = JSON.parse(skillMatrix)
    expect(matrixData.bindings.database.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Supabase', skill: 'supabase-database' })])
    )
    expect(matrixData.bindings.cms.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Sanity', skill: 'sanity-cms' })])
    )
  })

  it('auto-detected vercel in repoInfo adds Vercel MCP server without explicit selection', async () => {
    const stack: StackConfig = {
      ides: ['vscode'],
      techTools: ['sanity'],
      teamTools: [],
    }
    const repoInfo: RepoInfo = { deployment: ['vercel'] }

    const adapter = await IDE_ADAPTERS['vscode']()
    await adapter.install(PKG_ROOT, tempDir, stack, repoInfo)

    const mcpConfig = await readJson<Record<string, unknown>>(
      join(tempDir, '.vscode', 'mcp.json')
    )
    const servers = mcpConfig.servers as Record<string, unknown>
    expect(servers).toHaveProperty('Vercel')
    expect(servers).toHaveProperty('Sanity')
  })
})

// ═══════════════════════════════════════════════════════════════
// § 11  Orphaned Installation Handling
// ═══════════════════════════════════════════════════════════════

describe('init: orphaned installation handling', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-orphan-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('skips all files when .github/ exists but no .opencastle.json (fresh install path)', async () => {
    // Simulate orphaned installation — files exist but no manifest
    const adapter = await IDE_ADAPTERS['vscode']()

    // First install — creates files
    const firstResult = await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)
    expect(firstResult.created.length).toBeGreaterThan(0)

    // Second install (without reinit cleanup) — all files skipped
    const secondResult = await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)
    expect(secondResult.created.length).toBe(0)
    expect(secondResult.skipped.length).toBeGreaterThan(0)
  })

  it('creates files after framework dirs are cleaned up (reinit path)', async () => {
    const adapter = await IDE_ADAPTERS['vscode']()

    // First install
    await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)

    // Simulate reinit cleanup — delete framework dirs
    const managed = adapter.getManagedPaths()
    for (const p of managed.framework) {
      const fullPath = join(tempDir, p)
      if (p.endsWith('/')) {
        if (existsSync(fullPath)) await rm(fullPath, { recursive: true })
      } else if (existsSync(fullPath)) {
        await unlink(fullPath)
      }
    }

    // Second install after cleanup — creates framework files
    const secondResult = await adapter.install(PKG_ROOT, tempDir, STACK_EMPTY, EMPTY_REPO_INFO)
    expect(secondResult.created.length).toBeGreaterThan(0)
  })
})
