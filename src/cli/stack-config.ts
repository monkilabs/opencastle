import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type { TechTool, TeamTool, StackConfig, CopyDirOptions, RepoInfo } from './types.js';
import { isLegacyStack, migrateStackConfig, UnreadableConfigError } from './types.js';
import {
  PLUGINS,
  TECH_PLUGINS,
  TEAM_PLUGINS,
  CMS_PLUGINS,
  DB_PLUGINS,
  ALL_PLUGIN_SKILL_NAMES,
  getSelectedSkillNames,
} from '../orchestrator/plugins/index.js';
import type {} from '../orchestrator/plugins/types.js';
import { parseMcpConfigText } from './mcp-file.js';

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
/**
 * The StackConfig a manifest implies — one answer, for every caller.
 *
 * `sync` and `sync --check` used to derive this differently. The checker
 * substituted an empty stack when the field was missing; the compiler passed
 * `undefined` straight through, and the adapters read `undefined` as "no stack
 * selected, so exclude nothing and include every plugin". A manifest without a
 * `stack` therefore compiled to one tree and was checked against another: `sync`
 * grew the skills directory, the check reported the surplus as drift forever,
 * and running `sync` again changed nothing. Absorbing states like that are worth
 * more than the one line it takes to avoid them.
 */
/**
 * Is this variable set, from the shell or from the project's `.env`?
 *
 * `sync` counted a value in `.env` as satisfied while `doctor` looked only at
 * `process.env`, so a correctly configured project failed the check and was told
 * to run `sync` — a command that cannot set an environment variable. A diagnosis
 * that prescribes something incapable of fixing it is worse than no diagnosis.
 */
export function isEnvVarSatisfied(envVar: string, envFileContents: string): boolean {
  if (process.env[envVar]) return true
  // Line by line: a pattern with `\s` after the `=` crossed the newline, so an
  // empty `NAME=` that init wrote as a placeholder counted as set by whatever
  // the next line held. A comment or empty quotes are no value either.
  const assignment = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${envVar}[ \\t]*=(.*)$`)
  for (const line of envFileContents.split(/\r?\n/)) {
    const value = assignment.exec(line)?.[1].replace(/[ \t]+#.*$/, '').trim()
    if (value && value !== '""' && value !== "''") return true
  }
  return false
}

/**
 * The env files a server reads, as one text: the project's `.env`, and the
 * `envFile` its VS Code entry names.
 *
 * A team that keeps each server's secrets apart — `.env.d/mcp-resend.env` —
 * was told by `doctor`, `explain` and `sync` that the key was not set, because
 * they read only `.env`, while VS Code started the server with it.
 */
export function envFileTextFor(projectRoot: string, server: string): string {
  const read = (rel: string): string => {
    try {
      return readFileSync(resolve(projectRoot, rel), 'utf8')
    } catch {
      return ''
    }
  }
  let named = ''
  try {
    const config = parseMcpConfigText(read('.vscode/mcp.json'), '.vscode/mcp.json') as { servers?: Record<string, { envFile?: unknown }> }
    const envFile = config.servers?.[server]?.envFile
    if (typeof envFile === 'string' && envFile.startsWith('${workspaceFolder}')) named = read(`.${envFile.slice('${workspaceFolder}'.length)}`)
  } catch {
    // No VS Code config, or one with comments: `.env` is still read.
  }
  return `${read('.env')}\n${named}`
}

export function resolveStack(manifest: {
  ide?: string
  ides?: string[]
  stack?: StackConfig
}): StackConfig {
  const ides = (manifest.ides?.length ? manifest.ides : [manifest.ide]).filter(
    (id): id is string => Boolean(id),
  )
  if (!manifest.stack) {
    return { ides: ides as StackConfig['ides'], techTools: [], teamTools: [] }
  }

  // A v1 manifest stores `{ cms, db, pm, notifications }` and has no
  // `techTools`. `update` migrated it in memory and everything downstream was
  // fine; `buildCheckReport` re-reads the manifest from disk, so it handed the
  // v1 object straight to a consumer that spreads `stack.techTools` and got
  // "stack.techTools is not iterable" — a crash in the command this branch
  // makes the CI entry point. Migration belongs at the read, not at one caller.
  const stack = isLegacyStack(manifest.stack)
    ? migrateStackConfig(manifest.stack, ides[0])
    : manifest.stack

  return {
    ...stack,
    techTools: stack.techTools ?? [],
    teamTools: stack.teamTools ?? [],
    ides: (stack.ides?.length ? stack.ides : ides) as StackConfig['ides'],
  }
}

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

/** Frameworks of Python and Go that render pages, not only an API. */
const RENDERS_PAGES = ['django', 'flask']

/**
 * A Python or Go project with no JavaScript in it, and no framework that
 * renders pages: an API service, a CLI, a worker. It has no use for TypeScript
 * or web-interface rules, and nothing for a browser to test.
 */
export function servesNoWebInterface(repoInfo?: RepoInfo): boolean {
  const language = repoInfo?.language
  if (language !== 'python' && language !== 'go') return false
  if (repoInfo?.packageManager || repoInfo?.styling?.length) return false
  return !(repoInfo?.frameworks ?? []).some((f) => RENDERS_PAGES.includes(f))
}

/**
 * Core skills to leave out for what the project is. A FastAPI service was
 * given TypeScript, React, SEO and frontend-design rules on its first day; a
 * Django or Flask app, which renders pages, keeps the web ones.
 */
export function getExcludedCoreSkills(repoInfo?: RepoInfo): Set<string> {
  const language = repoInfo?.language
  if ((language !== 'python' && language !== 'go') || repoInfo?.packageManager) return new Set()
  const web = servesNoWebInterface(repoInfo) ? ['frontend-design', 'accessibility-standards', 'seo-patterns'] : []
  return new Set(['typescript-best-practices', ...web])
}

/**
 * Whether an integration starts selected. Chrome DevTools is preselected for
 * browser checks, which a project with no web interface cannot use.
 */
export function isPreselected(plugin: { preselected?: boolean; subCategory?: string }, repoInfo?: RepoInfo): boolean {
  if (!plugin.preselected) return false
  return !(plugin.subCategory === 'e2e-testing' && servesNoWebInterface(repoInfo))
}

/**
 * Agents to EXCLUDE — content-engineer if no CMS, data-engineer if no DB.
 */
export function getExcludedAgents(stack: StackConfig): Set<string> {
  const excluded = new Set<string>();
  const hasCms = stack.techTools.some((t) => (CMS_TOOLS as readonly string[]).includes(t));
  const hasDb = stack.techTools.some((t) => (DB_TOOLS as readonly string[]).includes(t));

  if (!hasCms) excluded.add('content-engineer.agent.md');
  if (!hasDb) excluded.add('data-engineer.agent.md');

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
  return MCP_ENV_REQUIREMENTS.filter((req) => included.has(req.server) && needsToken(req.server, stack));
}

/**
 * Targets that sign in to a server with OAuth, by server key. A project that
 * compiles only for those never sends the token, and asking for it in `.env`
 * and in `doctor` would be asking for a secret nothing reads.
 */
const OAUTH_TARGETS = new Map(
  Object.values(PLUGINS)
    .filter((p) => p.mcpServerKey && p.tokenAuth)
    .map((p) => [p.mcpServerKey!, p.tokenAuth!.oauthTargets as string[]]),
);

function needsToken(server: string, stack: StackConfig): boolean {
  const oauth = OAUTH_TARGETS.get(server);
  return !oauth || stack.ides.length === 0 || stack.ides.some((ide) => !oauth.includes(ide));
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
  'source-control': 'source-control',
  testing: 'testing',
  'e2e-testing': 'e2e-testing',
  design: 'design',
  email: 'email',
  payments: 'payments',
  observability: 'observability',
  notifications: 'notifications',
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

  // The read is guarded as well as the parse. Hardening the parse and leaving
  // the read bare meant a directory where the file should be took `sync` down
  // with a bare `✗ EISDIR: illegal operation on a directory, read` — naming
  // nothing, from a command that had already written the framework tree.
  let content: string;
  try {
    content = await readFile(matrixPath, 'utf8');
  } catch (err) {
    throw new UnreadableConfigError(relative(projectRoot, matrixPath));
  }
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
/** Every skill name a plugin owns — the entries the compiler is allowed to replace. */
const PLUGIN_SKILL_NAMES = new Set(
  Object.values(PLUGINS)
    .map((p) => p.skillName)
    .filter((s): s is string => Boolean(s)),
);

/**
 * The matrix this package ships, read once: where a slot a release adds is
 * described and which agents it belongs to.
 */
let shipped: SkillMatrixData | null | undefined;
function shippedMatrix(): SkillMatrixData | null {
  if (shipped === undefined) {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'orchestrator', 'customizations', 'agents', 'skill-matrix.json');
    try {
      shipped = JSON.parse(readFileSync(file, 'utf8')) as SkillMatrixData;
    } catch {
      shipped = null;
    }
  }
  return shipped;
}

/**
 * Agents a release merged into another, under the names older matrices still
 * hold them by: the 19 agents became 13, and the Team Lead took its suffix
 * before that. Session Guard went with the logging regime it policed.
 */
export const RETIRED_AGENTS: Readonly<Record<string, string | null>> = {
  'Team Lead': 'Team Lead (OpenCastle)',
  Copywriter: 'Writer',
  'SEO Specialist': 'Writer',
  'Documentation Writer': 'Writer',
  'API Designer': 'Developer',
  'DevOps Expert': 'DevOps & Release',
  'Release Manager': 'DevOps & Release',
  'Data Expert': 'Data Engineer',
  'Database Engineer': 'Data Engineer',
  'Session Guard': null,
};

/** Skills a release removed with nothing of the same name after it. An agent told to load one finds nothing. */
export const RETIRED_SKILLS: ReadonlySet<string> = new Set([
  'agent-hooks', 'agent-memory', 'backbone-scaffolding', 'code-commenting', 'context-map', 'decomposition',
  'documentation-standards', 'memory-merger', 'nextjs-patterns', 'observability-logging', 'orchestration-protocols',
  'performance-optimization', 'project-consistency', 'react-development', 'session-checkpoints', 'task-management',
  'team-lead-reference',
]);

/**
 * Bring a matrix's agents to the current roster.
 *
 * The matrix is the project's, so a merge of agents never reached one written
 * before it: every such project kept eight agents that no longer exist, and
 * the three that replaced them — Data Engineer, DevOps & Release, Writer —
 * had no entry and resolved no skills. A retired agent's slots and skills move
 * to its successor; a current agent the matrix lacks gets the shipped entry;
 * a skill that no longer exists is dropped. Agents the team added are theirs.
 */
function migrateAgents(data: SkillMatrixData, template: SkillMatrixData | null): void {
  const agents = (data.agents ??= {});
  const fresh = (name: string) => structuredClone(template?.agents[name] ?? { slots: [], directSkills: [] });
  for (const [old, now] of Object.entries(RETIRED_AGENTS)) {
    const was = agents[old];
    if (!was) continue;
    delete agents[old];
    if (!now) continue;
    const into = (agents[now] ??= fresh(now));
    for (const slot of was.slots ?? []) if (!into.slots.includes(slot)) into.slots.push(slot);
    for (const skill of was.directSkills ?? []) if (!into.directSkills.includes(skill)) into.directSkills.push(skill);
  }
  for (const name of Object.keys(template?.agents ?? {})) agents[name] ??= fresh(name);
  for (const agent of Object.values(agents)) agent.directSkills = (agent.directSkills ?? []).filter((s) => !RETIRED_SKILLS.has(s));
}

export function updateSkillMatrixContent(content: string, stack: StackConfig): string {
  let data: SkillMatrixData;
  try {
    data = JSON.parse(content) as SkillMatrixData;
  } catch {
    // Same reasoning as the MCP config: this file is committed, so it is a merge
    // conflict candidate, and dying here left the sync half applied.
    throw new UnreadableConfigError('.opencastle/agents/skill-matrix.json');
  }
  const allTools = [...stack.techTools, ...stack.teamTools] as string[];
  const template = shippedMatrix();
  migrateAgents(data, template);

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

    // A slot a release added — `source-control`, for GitHub and GitLab — is in
    // no matrix written before it, and the matrix is the project's, so nothing
    // else adds it: the integration's skill reached no agent. Once a selected
    // integration fills it, add it with the agents the shipped matrix gives it
    // to. Only then: from there the slot exists, and what the team does with
    // it is theirs.
    if (!data.bindings[slotName] && entries.length > 0 && template?.bindings[slotName]) {
      data.bindings[slotName] = { entries: [], description: template.bindings[slotName].description };
      for (const [agent, { slots }] of Object.entries(template.agents)) {
        const theirs = data.agents?.[agent];
        if (slots.includes(slotName) && theirs && !theirs.slots.includes(slotName)) theirs.slots.push(slotName);
      }
    }

    if (data.bindings[slotName]) {
      // Merge, not replace. `skill-matrix.md` told users "to switch tech, update
      // only the binding entries", and this ran on every sync, so the edit the
      // documentation asks for was erased by the next recompile — in the
      // directory the drift checker calls theirs.
      //
      // Ownership is decidable without asking: an entry is ours exactly when its
      // skill is one a plugin ships. Anything else the user wrote, and it stays.
      const theirs = (data.bindings[slotName].entries ?? []).filter(
        (e) => !PLUGIN_SKILL_NAMES.has(e.skill),
      );
      data.bindings[slotName].entries = [...entries, ...theirs];
    }
  }

  return JSON.stringify(data, null, 2) + '\n';
}
