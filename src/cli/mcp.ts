import { resolve, dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getIncludedMcpServers } from './stack-config.js';
import { PLUGINS } from '../orchestrator/plugins/index.js';
import type { McpInput } from '../orchestrator/plugins/types.js';
import type { ScaffoldResult, StackConfig, RepoInfo, IdeChoice } from './types.js';

// ── IDE-specific MCP format transformation ────────────────────

interface VsCodeServer {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envFile?: string;
}

/**
 * Transform a VS Code–format MCP config into the format
 * expected by the given IDE.
 */
function transformMcpForIde(
  ide: IdeChoice,
  servers: Record<string, VsCodeServer>,
  inputs?: McpInput[]
): Record<string, unknown> {
  switch (ide) {
    case 'cursor':
    case 'claude-code':
    case 'windsurf':
    case 'codex':
    case 'antigravity': {
      // mcpServers format — no 'type' field
      const mcpServers: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(servers)) {
        if (server.type === 'stdio') {
          mcpServers[name] = {
            command: server.command,
            args: server.args,
            ...(server.env && { env: server.env }),
          };
        } else if (server.type === 'http') {
          // Strip VS Code ${input:...} placeholders for non-VS Code IDEs
          let url = server.url ?? '';
          url = url.replace(/\$\{input:\w+\}/g, 'REPLACE_ME');
          mcpServers[name] = { url };
        }
      }
      return { mcpServers };
    }

    case 'opencode': {
      // OpenCode format — type: "local"/"remote", command as array
      const mcp: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(servers)) {
        if (server.type === 'stdio') {
          mcp[name] = {
            type: 'local',
            command: [server.command, ...(server.args ?? [])],
            ...(server.env && { environment: server.env }),
          };
        } else if (server.type === 'http') {
          let url = server.url ?? '';
          url = url.replace(/\$\{input:\w+\}/g, 'REPLACE_ME');
          mcp[name] = {
            type: 'remote',
            url,
          };
        }
      }
      return { mcp };
    }

    default: {
      // VS Code — return as-is (keep type, inputs, envFile)
      const result: Record<string, unknown> = { servers };
      if (inputs && inputs.length > 0) {
        result.inputs = inputs;
      }
      return result;
    }
  }
}

/**
 * Scaffold or merge the MCP server config into the target project.
 *
 * Builds the server list from plugin configs based on the user's
 * stack selection. Writes to `<projectRoot>/<destRelPath>`
 * (e.g. `.vscode/mcp.json`).
 *
 * The output format is adapted to match the target IDE's expectations.
 *
 * If the file already exists, missing servers are merged in without
 * overwriting any existing server configs.
 */
export async function scaffoldMcpConfig(
  projectRoot: string,
  destRelPath: string,
  stack?: StackConfig,
  repoInfo?: RepoInfo,
  ide?: IdeChoice
): Promise<ScaffoldResult> {
  const destPath = resolve(projectRoot, destRelPath);

  // Build server list from plugin configs
  const servers: Record<string, VsCodeServer> = {};
  let inputs: McpInput[] = [];
  const resolvedIde = ide ?? 'vscode';

  if (stack) {
    const included = getIncludedMcpServers(stack, repoInfo);

    for (const plugin of Object.values(PLUGINS)) {
      if (plugin.mcpServerKey && included.has(plugin.mcpServerKey)) {
        const serverConfig = { ...plugin.mcpConfig! } as VsCodeServer;
        if (resolvedIde !== 'vscode' && plugin.envVars.length > 0) {
          const envBlock: Record<string, string> = { ...(serverConfig.env ?? {}) };
          for (const ev of plugin.envVars) {
            envBlock[ev.name] = `\${${ev.name}}`;
          }
          serverConfig.env = envBlock;
          delete serverConfig.envFile;
        }
        servers[plugin.mcpServerKey] = serverConfig;
        if (plugin.mcpInputs) {
          inputs.push(...plugin.mcpInputs);
        }
      }
    }
  }

  // Transform to IDE-specific format
  const output = transformMcpForIde(resolvedIde, servers, inputs.length > 0 ? inputs : undefined);

  if (existsSync(destPath)) {
    // Merge: add missing servers without overwriting existing ones
    const existingContent = await readFile(destPath, 'utf8');
    const existing = JSON.parse(existingContent) as Record<string, unknown>;

    // Determine the server container key for this IDE
    const containerKey = resolvedIde === 'opencode'
      ? 'mcp'
      : resolvedIde === 'vscode'
        ? 'servers'
        : 'mcpServers';

    if (!existing[containerKey]) {
      existing[containerKey] = {};
    }

    const existingServers = existing[containerKey] as Record<string, unknown>;
    const newServers = (output as Record<string, unknown>)[containerKey] as Record<string, unknown> | undefined;

    let added = 0;
    if (newServers) {
      for (const [key, value] of Object.entries(newServers)) {
        if (!(key in existingServers)) {
          existingServers[key] = value;
          added++;
        }
      }
    }

    // For VS Code: merge inputs
    if (resolvedIde === 'vscode' && output.inputs) {
      const existingInputs = (existing.inputs as McpInput[]) ?? [];
      const existingIds = new Set(existingInputs.map((i) => i.id));
      const newInputs = output.inputs as McpInput[];
      for (const input of newInputs) {
        if (!existingIds.has(input.id)) {
          existingInputs.push(input);
          added++;
        }
      }
      if (existingInputs.length > 0) {
        existing.inputs = existingInputs;
      }
    }

    if (added === 0) {
      return { path: destPath, action: 'skipped' };
    }

    await writeFile(destPath, JSON.stringify(existing, null, 2) + '\n');
    return { path: destPath, action: 'created' };
  }

  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, JSON.stringify(output, null, 2) + '\n');

  return { path: destPath, action: 'created' };
}

// ── MCP config rebuild for reconfigure ────────────────────────

/**
 * Returns the relative path to the MCP config file for a given IDE.
 */
function getMcpConfigRelPath(ide: IdeChoice): string {
  switch (ide) {
    case 'vscode':
      return '.vscode/mcp.json';
    case 'cursor':
      return '.cursor/mcp.json';
    case 'claude-code':
      return '.mcp.json';
    case 'opencode':
      return 'opencode.json';
    case 'windsurf':
      return '.windsurf/mcp.json';
    case 'codex':
      return '.codex/mcp.json';
    case 'antigravity':
      return '.agents/mcp_config.json';
  }
}

/**
 * Rebuild the MCP config for a specific IDE after a stack reconfigure.
 *
 * 1. Reads the existing MCP config
 * 2. Removes all plugin-managed server entries
 * 3. Preserves manually-added server entries
 * 4. Re-scaffolds with the new stack selection
 */
export async function rebuildMcpConfig(
  projectRoot: string,
  ide: IdeChoice,
  stack: StackConfig,
  repoInfo?: RepoInfo
): Promise<void> {
  const destRelPath = getMcpConfigRelPath(ide);
  const destPath = resolve(projectRoot, destRelPath);

  if (!existsSync(destPath)) {
    // No existing config — scaffold fresh
    await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide);
    return;
  }

  // Read existing config
  const existing = JSON.parse(await readFile(destPath, 'utf8')) as Record<string, unknown>;
  const containerKey =
    ide === 'opencode' ? 'mcp' : ide === 'vscode' ? 'servers' : 'mcpServers';

  const existingServers = (existing[containerKey] ?? {}) as Record<string, unknown>;

  // Get all known plugin server keys
  const allPluginServerKeys = new Set(
    Object.values(PLUGINS)
      .filter((p) => p.mcpServerKey)
      .map((p) => p.mcpServerKey!)
  );

  // Get the servers the new stack selection includes
  const includedServers = getIncludedMcpServers(stack, repoInfo);

  // Only remove plugin-managed servers that are NOT in the new stack selection.
  // Servers already in the config for the new stack are left untouched so
  // user customizations (env vars, args) are preserved.
  for (const key of Object.keys(existingServers)) {
    if (allPluginServerKeys.has(key) && !includedServers.has(key)) {
      delete existingServers[key];
    }
  }

  // For VS Code: remove only inputs belonging to removed servers
  if (ide === 'vscode') {
    const removedServerKeys = new Set(
      [...allPluginServerKeys].filter((k) => !includedServers.has(k))
    );
    const removedInputIds = new Set<string>();
    for (const plugin of Object.values(PLUGINS)) {
      if (
        plugin.mcpServerKey &&
        removedServerKeys.has(plugin.mcpServerKey) &&
        plugin.mcpInputs
      ) {
        for (const input of plugin.mcpInputs) {
          removedInputIds.add(input.id);
        }
      }
    }
    if (removedInputIds.size > 0) {
      const existingInputs = (existing.inputs as McpInput[]) ?? [];
      const filteredInputs = existingInputs.filter((i) => !removedInputIds.has(i.id));
      if (filteredInputs.length > 0) {
        existing.inputs = filteredInputs;
      } else {
        delete existing.inputs;
      }
    }
  }

  existing[containerKey] = existingServers;

  // Write the cleaned config (preserving manually-added servers and unchanged plugin servers)
  await writeFile(destPath, JSON.stringify(existing, null, 2) + '\n');

  // Re-scaffold: merges new plugin servers into the cleaned config
  await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide);
}
