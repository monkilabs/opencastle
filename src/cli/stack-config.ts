import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { TechTool, TeamTool, StackConfig, CopyDirOptions, RepoInfo } from './types.js';
import {
  PLUGINS,
  TECH_PLUGINS,
  TEAM_PLUGINS,
  CMS_PLUGINS,
  DB_PLUGINS,
  ALL_PLUGIN_SKILL_NAMES,
  getSelectedSkillNames,
} from '../orchestrator/plugins/index.js';
import type { PluginConfig } from '../orchestrator/plugins/types.js';

// ── Tool registries (derived from plugins) ────────────────────

interface ToolInfo {
  tech: string;
  skill: string | null;
  mcpServer?: string;
}

/** All tech-tool metadata — derived from plugin configs. */
const TECH_TOOL_INFO: Record<TechTool, ToolInfo> = Object.fromEntries(
  TECH_PLUGINS.map((p) => [p.id, { tech: p.name, skill: p.skillName, mcpServer: p.mcpServerKey }])
) as Record<TechTool, ToolInfo>;

/** All team-tool metadata — derived from plugin configs. */
const TEAM_TOOL_INFO: Record<TeamTool, ToolInfo> = Object.fromEntries(
  TEAM_PLUGINS.map((p) => [p.id, { tech: p.name, skill: p.skillName, mcpServer: p.mcpServerKey }])
) as Record<TeamTool, ToolInfo>;

/** CMS-related tech tools. */
const CMS_TOOLS: readonly TechTool[] = CMS_PLUGINS.map((p) => p.id) as TechTool[];
/** Database-related tech tools. */
const DB_TOOLS: readonly TechTool[] = DB_PLUGINS.map((p) => p.id) as TechTool[];

/** MCP servers auto-included when detected in the repo. */
const DETECTED_MCP_MAP: Record<string, string> = {
  vercel: 'Vercel',
};

// ── MCP environment variable requirements ─────────────────────

export interface McpEnvRequirement {
  /** MCP server key (must match mcp.json) */
  server: string;
  /** Environment variable name */
  envVar: string;
  /** Short description of where to get the key */
  hint: string;
}

/**
 * Registry of MCP servers that require API keys via environment variables.
 * Derived from plugin configs — only plugins with envVars are included.
 */
const MCP_ENV_REQUIREMENTS: McpEnvRequirement[] = Object.values(PLUGINS)
  .filter((p) => p.envVars.length > 0 && p.mcpServerKey)
  .flatMap((p) =>
    p.envVars.map((ev) => ({
      server: p.mcpServerKey!,
      envVar: ev.name,
      hint: ev.hint,
    }))
  );

// ── Exported helpers ──────────────────────────────────────────

/**
 * Skills to EXCLUDE — all tool-specific skills that are NOT selected.
 */
export function getExcludedSkills(stack: StackConfig): Set<string> {
  const selectedIds = [...stack.techTools, ...stack.teamTools] as string[];
  const includedSkills = new Set(getSelectedSkillNames(selectedIds));
  return new Set(ALL_PLUGIN_SKILL_NAMES.filter((s) => !includedSkills.has(s)));
}

/**
 * Plugin IDs to INCLUDE — the user's selected tools.
 */
export function getIncludedPluginIds(stack: StackConfig): Set<string> {
  return new Set([...stack.techTools, ...stack.teamTools]);
}

/**
 * Agents to EXCLUDE — content-engineer if no CMS, database-engineer if no DB.
 */
export function getExcludedAgents(stack: StackConfig): Set<string> {
  const excluded = new Set<string>();
  const hasCms = stack.techTools.some((t) => (CMS_TOOLS as readonly string[]).includes(t));
  const hasDb = stack.techTools.some((t) => (DB_TOOLS as readonly string[]).includes(t));

  if (!hasCms) excluded.add('content-engineer.agent.md');
  if (!hasDb) excluded.add('database-engineer.agent.md');

  return excluded;
}

/**
 * MCP servers to INCLUDE — core + selected tools + auto-detected from repo.
 */
export function getIncludedMcpServers(stack: StackConfig, repoInfo?: RepoInfo): Set<string> {
  const servers = new Set<string>();

  for (const tool of stack.techTools) {
    const server = TECH_TOOL_INFO[tool]?.mcpServer;
    if (server) servers.add(server);
  }
  for (const tool of stack.teamTools) {
    const server = TEAM_TOOL_INFO[tool]?.mcpServer;
    if (server) servers.add(server);
  }

  // Add servers for detected deployment targets
  for (const dep of repoInfo?.deployment ?? []) {
    const server = DETECTED_MCP_MAP[dep];
    if (server) servers.add(server);
  }

  // Auto-detect NX from monorepo info
  if (repoInfo?.monorepo === 'nx' && !stack.techTools.includes('nx')) {
    servers.add('Nx');
  }

  return servers;
}

/**
 * Returns env var requirements for the MCP servers included in the stack.
 * Only returns entries for servers that actually need API keys.
 */
export function getRequiredMcpEnvVars(stack: StackConfig, repoInfo?: RepoInfo): McpEnvRequirement[] {
  const included = getIncludedMcpServers(stack, repoInfo);
  return MCP_ENV_REQUIREMENTS.filter((req) => included.has(req.server));
}

// ── Customization file transforms ─────────────────────────────

// ── Skill matrix JSON types ────────────────────────────────────

export interface SkillMatrixEntry {
  name: string;
  skill: string;
}

export interface SkillMatrixSlot {
  entries: SkillMatrixEntry[];
  description: string;
}

export interface SkillMatrixData {
  bindings: Record<string, SkillMatrixSlot>;
  agents: Record<string, { slots: string[]; directSkills: string[] }>;
}

/**
 * Return a transform callback that pre-populates customization files
 * based on the user's stack selection.
 *
 * Used by all adapters when copying the `customizations/` directory.
 */
export function getCustomizationsTransform(
  stack: StackConfig
): NonNullable<CopyDirOptions['transform']> {
  return (content: string, srcPath: string) => {
    if (srcPath.endsWith('skill-matrix.json')) {
      return updateSkillMatrixContent(content, stack);
    }
    return content;
  };
}

// ── Agent tool injection ──────────────────────────────────────

/**
 * Compute tool injections per agent based on the user's selected stack.
 * Returns a Map where key = agent name (e.g. 'content-engineer'), value = tools to inject.
 */
export function getAgentToolInjections(stack: StackConfig): Map<string, string[]> {
  const injections = new Map<string, string[]>();
  const selectedIds = [...stack.techTools, ...stack.teamTools] as string[];

  for (const id of selectedIds) {
    const plugin = PLUGINS[id];
    if (!plugin?.agentToolMap) continue;

    for (const [agentName, tools] of Object.entries(plugin.agentToolMap)) {
      const existing = injections.get(agentName) ?? [];
      existing.push(...tools);
      injections.set(agentName, existing);
    }
  }

  return injections;
}

/**
 * Returns a transform callback that injects plugin-specific tools
 * into agent file frontmatter based on the user's stack selection.
 */
export function getAgentTransform(
  stack: StackConfig
): NonNullable<CopyDirOptions['transform']> {
  const injections = getAgentToolInjections(stack);

  return (content: string, srcPath: string) => {
    // Extract agent name from filename (e.g., 'content-engineer' from 'content-engineer.agent.md')
    const match = srcPath.match(/([^/\\]+)\.agent\.md$/);
    if (!match) return content;

    const agentName = match[1];
    const toolsToInject = injections.get(agentName);
    if (!toolsToInject || toolsToInject.length === 0) return content;

    // Parse the frontmatter to find the tools array
    const fmMatch = content.match(/^(---\n)([\s\S]*?)\n(---\n)([\s\S]*)$/);
    if (!fmMatch) return content;

    const frontmatter = fmMatch[2];
    const body = fmMatch[4];

    // Find and modify the tools line
    const toolsMatch = frontmatter.match(/^(tools:\s*\[)(.*?)(\]\s*)$/m);
    if (!toolsMatch) return content;

    const existingTools = toolsMatch[2];
    const injectedToolsList = toolsToInject.map((t) => `'${t}'`).join(', ');
    const newTools = existingTools
      ? `${existingTools}, ${injectedToolsList}`
      : injectedToolsList;

    const newFrontmatter = frontmatter.replace(
      toolsMatch[0],
      `${toolsMatch[1]}${newTools}${toolsMatch[3]}`
    );

    return `---\n${newFrontmatter}\n---\n${body}`;
  };
}

// ── Skill matrix update ─────────────────────────────────────────

/** Mapping from plugin subCategory to skill matrix slot name. */
const SUBCATEGORY_TO_SLOT: Record<string, string> = {
  database: 'database',
  cms: 'cms',
  deployment: 'deployment',
  framework: 'framework',
  'codebase-tool': 'codebase-tool',
  'task-management': 'task-management',
  'knowledge-management': 'knowledge-management',
  testing: 'testing',
  'e2e-testing': 'e2e-testing',
};

/**
 * Get the filesystem path to the skill matrix file for a given IDE.
 */
function getSkillMatrixPath(projectRoot: string, _ide: string): string {
  return resolve(projectRoot, '.opencastle', 'agents', 'skill-matrix.json');
}

/**
 * Update the skill matrix file in-place for a specific IDE.
 * Updates slot entries based on the user's current stack selections.
 * Returns true if the file was updated, false if unchanged or missing.
 */
export async function updateSkillMatrixFile(
  projectRoot: string,
  ide: string,
  stack: StackConfig
): Promise<boolean> {
  const matrixPath = getSkillMatrixPath(projectRoot, ide);
  if (!matrixPath || !existsSync(matrixPath)) return false;

  const content = await readFile(matrixPath, 'utf8');
  const updated = updateSkillMatrixContent(content, stack);
  if (updated !== content) {
    await writeFile(matrixPath, updated);
    return true;
  }
  return false;
}

/**
 * Update skill matrix JSON content based on stack selections.
 * Pure function — sets slot entries for all plugin-mapped subcategories.
 * Supports multiple plugins per slot (e.g. multiple databases).
 */
export function updateSkillMatrixContent(content: string, stack: StackConfig): string {
  const data: SkillMatrixData = JSON.parse(content);
  const allTools = [...stack.techTools, ...stack.teamTools] as string[];

  for (const [subCategory, slotName] of Object.entries(SUBCATEGORY_TO_SLOT)) {
    // Find ALL selected tools matching this subcategory (not just the first)
    const matchingTools = allTools.filter((toolId) => {
      const plugin = PLUGINS[toolId];
      return plugin?.subCategory === subCategory;
    });

    const entries: SkillMatrixEntry[] = matchingTools
      .map((toolId) => {
        const plugin = PLUGINS[toolId];
        if (!plugin?.skillName) return null;
        return { name: plugin.name, skill: plugin.skillName };
      })
      .filter((e): e is SkillMatrixEntry => e !== null);

    if (data.bindings[slotName]) {
      data.bindings[slotName].entries = entries;
    }
  }

  return JSON.stringify(data, null, 2) + '\n';
}
