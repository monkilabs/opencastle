import { resolve, dirname } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getIncludedMcpServers } from './stack-config.js';
import { PLUGINS } from '../orchestrator/plugins/index.js';
import { UnreadableConfigError } from './types.js';
import type { McpInput, McpServerConfig, EnvVarRequirement } from '../orchestrator/plugins/types.js';
import type { ScaffoldResult, StackConfig, RepoInfo, IdeChoice, CopyResults } from './types.js';
import type { TeamMcpPlan } from './layers.js';
import { EDITOR_VARIABLES, type TeamMcpServer } from './team-config.js';
import { parseMcpConfigText, serialiseMcpConfig, TomlEditError } from './mcp-file.js';

// ── IDE-specific MCP format transformation ────────────────────

interface VsCodeServer {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envFile?: string;
  headers?: Record<string, string>;
}

/**
 * How each target spells "the value of environment variable NAME".
 *
 * There is no common syntax. Claude Code expands `${NAME}`; Cursor and Windsurf
 * expand `${env:NAME}`; OpenCode expands `{env:NAME}`. Every other spelling is
 * passed to the server as literal text — so the `${SENTRY_ACCESS_TOKEN}` this
 * wrote for every target reached a Cursor or OpenCode user's server as those
 * twenty-two characters, in place of the token their shell already held, and
 * the server failed to authenticate. VS Code uses `envFile` instead and never
 * reaches here. Codex and Antigravity keep `${NAME}` until their documented
 * syntax is confirmed.
 */
export function envRef(ide: IdeChoice, name: string): string {
  switch (ide) {
    case 'cursor':
    case 'windsurf':
      return `\${env:${name}}`;
    case 'opencode':
      return `{env:${name}}`;
    default:
      return `\${${name}}`;
  }
}

/**
 * An editor variable for a target that does not have editor variables.
 *
 * VS Code and Cursor expand `${workspaceFolder}` and `${userHome}` themselves.
 * Claude Code, OpenCode and Windsurf document only environment variables, so
 * the text reached the server as written and the path it named was broken.
 * These targets start a project's servers in the project directory, so the
 * workspace is `.`, and the home directory is the `HOME` variable. Anything
 * with no such equivalent is left as written, and `doctor` says so.
 */
function editorVariableFor(ide: IdeChoice, name: string, original: string): string {
  if (ide === 'vscode' || ide === 'cursor') return original;
  if (name === 'workspaceFolder' || name === 'workspaceRoot' || name === 'cwd') return '.';
  if (name === 'userHome') return envRef(ide, 'HOME');
  if (name === 'pathSeparator') return '/';
  return original;
}

/** The variable a value is wholly a reference to — `${NAME}` and nothing else — or null. */
function wholeReference(value: string): string | null {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  return m && !EDITOR_VARIABLES.has(m[1]) ? m[1] : null;
}

/** Rewrite every `${NAME}` in a value into the target's own spelling. */
function rewriteRefs(value: string, ide: IdeChoice): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) =>
    EDITOR_VARIABLES.has(name) ? editorVariableFor(ide, name, m) : envRef(ide, name),
  );
}

/**
 * Transform a VS Code–format MCP config into the format
 * expected by the given IDE.
 *
 * `legacy` reproduces what releases before this one wrote, so an entry still in
 * that shape can be recognised as ours and brought forward. It is never written.
 */
function transformMcpForIde(
  ide: IdeChoice,
  servers: Record<string, VsCodeServer>,
  inputs?: McpInput[],
  options: { legacy?: boolean } = {},
): Record<string, unknown> {
  switch (ide) {
    case 'cursor':
    case 'claude-code':
    case 'windsurf':
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
          // Claude Code reads an entry with no `type` as a stdio server, and its
          // MCP docs call a bare `url` a configuration error. Every remote server
          // this wrote into `.mcp.json` — Supabase, Stripe, Vercel and the rest —
          // was therefore a stdio server with no command, and never loaded. The
          // other targets in this group take the bare `url`.
          const headers = server.headers && { headers: server.headers };
          mcpServers[name] =
            ide === 'claude-code' && !options.legacy ? { type: 'http', url, ...headers } : { url, ...headers };
        }
      }
      return { mcpServers };
    }

    case 'codex': {
      // Codex CLI reads `[mcp_servers.<name>]` tables in `.codex/config.toml`
      // and expands no variables anywhere in them. What it offers instead is
      // structural: `env_vars` forwards a variable from the environment Codex
      // was started in, `bearer_token_env_var` sends `Authorization: Bearer`
      // with one, and `env_http_headers` sets a header to one. A reference that
      // is exactly one of those shapes is written as it; anything else is left
      // as written, and `doctor` says so.
      const mcp_servers: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(servers)) {
        if (server.type === 'stdio') {
          const env: Record<string, string> = {};
          const envVars: string[] = [];
          for (const [key, value] of Object.entries(server.env ?? {})) {
            if (wholeReference(value) === key) envVars.push(key);
            else env[key] = value;
          }
          mcp_servers[name] = {
            command: server.command,
            ...(server.args && { args: server.args }),
            ...(Object.keys(env).length > 0 && { env }),
            ...(envVars.length > 0 && { env_vars: envVars }),
          };
        } else if (server.type === 'http') {
          const url = (server.url ?? '').replace(/\$\{input:\w+\}/g, 'REPLACE_ME');
          const literal: Record<string, string> = {};
          const fromEnv: Record<string, string> = {};
          let bearer: string | undefined;
          for (const [header, value] of Object.entries(server.headers ?? {})) {
            const token = /^Bearer\s+(\$\{[A-Za-z_][A-Za-z0-9_]*\})$/.exec(value);
            const bearerVar = header.toLowerCase() === 'authorization' && token ? wholeReference(token[1]) : null;
            const whole = wholeReference(value);
            if (bearerVar) bearer = bearerVar;
            else if (whole) fromEnv[header] = whole;
            else literal[header] = value;
          }
          mcp_servers[name] = {
            url,
            ...(bearer && { bearer_token_env_var: bearer }),
            ...(Object.keys(literal).length > 0 && { http_headers: literal }),
            ...(Object.keys(fromEnv).length > 0 && { env_http_headers: fromEnv }),
          };
        }
      }
      return { mcp_servers };
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
            ...(server.headers && { headers: server.headers }),
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
 * One plugin's server as the VS Code–format config, with the env vars other
 * targets need spelled out — they have no `envFile`.
 */
function serverFor(
  plugin: { mcpConfig?: McpServerConfig; envVars: EnvVarRequirement[] },
  ide: IdeChoice,
  legacyEnv = false,
): VsCodeServer {
  const serverConfig = { ...plugin.mcpConfig! } as VsCodeServer;
  if (ide !== 'vscode' && plugin.envVars.length > 0) {
    const envBlock: Record<string, string> = { ...(serverConfig.env ?? {}) };
    for (const ev of plugin.envVars) {
      // `legacyEnv` is what releases before per-target syntax wrote everywhere.
      envBlock[ev.name] = legacyEnv ? `\${${ev.name}}` : envRef(ide, ev.name);
    }
    serverConfig.env = envBlock;
    delete serverConfig.envFile;
  }
  return serverConfig;
}

export function containerKeyFor(ide: IdeChoice): string {
  if (ide === 'codex') return 'mcp_servers';
  return ide === 'opencode' ? 'mcp' : ide === 'vscode' ? 'servers' : 'mcpServers';
}

/** One server entry exactly as it is written into `ide`'s config. */
function entryFor(server: VsCodeServer, ide: IdeChoice, legacy = false): unknown {
  const out = transformMcpForIde(ide, { entry: server }, undefined, { legacy });
  return (out[containerKeyFor(ide)] as Record<string, unknown>).entry;
}

/** Key order is not meaning: compare two parsed JSON values as values. */
export function canonicalJson(value: unknown): string {
  return canonical(value);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * A team server as one target's config entry, with the VS Code inputs it needs.
 *
 * Team layers write variables one way, `${NAME}`, and each target gets its own
 * spelling. For VS Code the integrations' convention holds: a variable a local
 * server only forwards comes from `.env` through `envFile` (and the editor's
 * own environment, which the server inherits) — VS Code opened from the Dock
 * does not see the shell's variables, so `.env` is what works however it was
 * launched. A reference anywhere else — a header, an argument — becomes a
 * password input VS Code asks for once and keeps in its secret storage.
 * Editor variables such as `${workspaceFolder}` are passed through untouched.
 */
export function teamEntryFor(key: string, server: TeamMcpServer, ide: IdeChoice): { entry: unknown; inputs: McpInput[] } {
  const inputs: McpInput[] = [];
  const http = server.type === 'http' || (!server.type && Boolean(server.url) && !server.command);
  if (ide === 'vscode') {
    const toInput = (value: string): string =>
      value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
        if (EDITOR_VARIABLES.has(name)) return m;
        if (!inputs.some((i) => i.id === name)) {
          inputs.push({ id: name, type: 'promptString', description: teamInputDescription(name, key), password: true });
        }
        return `\${input:${name}}`;
      });
    if (http) {
      const entry: VsCodeServer = { type: 'http', url: toInput(server.url ?? '') };
      if (server.headers) entry.headers = Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, toInput(v)]));
      return { entry, inputs };
    }
    const entry: VsCodeServer = { type: 'stdio', command: toInput(server.command ?? '') };
    if (server.args) entry.args = server.args.map(toInput);
    const env: Record<string, string> = {};
    let forwards = false;
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (value === `\${${name}}`) {
        forwards = true;
        continue;
      }
      env[name] = toInput(value);
    }
    if (Object.keys(env).length > 0) entry.env = env;
    if (forwards) entry.envFile = '${workspaceFolder}/.env';
    return { entry, inputs };
  }
  const rw = (v: string): string => rewriteRefs(v, ide);
  const vs: VsCodeServer = http
    ? {
        type: 'http',
        url: rw(server.url ?? ''),
        ...(server.headers && { headers: Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, rw(v)])) }),
      }
    : {
        type: 'stdio',
        command: rw(server.command ?? ''),
        ...(server.args && { args: server.args.map(rw) }),
        ...(server.env && { env: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, rw(v)])) }),
      };
  return { entry: entryFor(vs, ide), inputs };
}

/** Every team server's entry for one target, as `sync` writes them. */
export function expectedTeamEntries(plan: TeamMcpPlan | undefined, ide: IdeChoice): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, server] of Object.entries(plan?.servers ?? {})) out[key] = teamEntryFor(key, server, ide).entry;
  return out;
}

/** How this tool describes an input it writes for a team server. */
function teamInputDescription(id: string, key: string): string {
  return `${id} for the ${key} MCP server`;
}

/**
 * The inputs among `candidates` that this tool wrote for a team server and
 * that no server left in the config still reads.
 */
export function ownedUnusedInputs(config: Record<string, unknown>, candidates: string[]): string[] {
  const inputs = Array.isArray(config.inputs) ? (config.inputs as McpInput[]) : [];
  const servers = JSON.stringify(config.servers ?? {});
  return inputs
    .filter((i) => candidates.includes(i.id))
    .filter((i) => /^\S+ for the .+ MCP server$/.test(i.description ?? '') && i.description.startsWith(`${i.id} for the `))
    .filter((i) => !servers.includes(`\${input:${i.id}}`))
    .map((i) => i.id);
}

/**
 * Put the team's servers into a parsed config: written exactly as defined,
 * whatever is there; retired ones and ones the policy refuses taken out.
 * Returns what changed, by key.
 */
function applyTeamPlan(
  existing: Record<string, unknown>,
  ide: IdeChoice,
  plan: TeamMcpPlan | undefined,
): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  if (!plan) return { written, removed };
  const containerKey = containerKeyFor(ide);
  const servers = (existing[containerKey] ?? {}) as Record<string, unknown>;
  const inputs: McpInput[] = [];
  for (const [key, server] of Object.entries(plan.servers)) {
    const { entry, inputs: needed } = teamEntryFor(key, server, ide);
    inputs.push(...needed);
    if (key in servers && canonical(servers[key]) === canonical(entry)) continue;
    servers[key] = entry;
    written.push(key);
  }
  for (const key of [...plan.retired, ...plan.blocked]) {
    if (key in servers && !(key in plan.servers)) {
      delete servers[key];
      removed.push(key);
    }
  }
  if (Object.keys(servers).length > 0 || containerKey in existing) existing[containerKey] = servers;
  // Inputs only a retired team server asked for go with it; left behind, they
  // were the last thing in a `.vscode/mcp.json` an uninstall then kept. Only
  // ones this tool wrote, and only if no server still in the file uses them —
  // a user's own server may read an input of the same name.
  if (ide === 'vscode' && Array.isArray(existing.inputs) && (plan.retiredInputs ?? []).length > 0) {
    const takeable = new Set(ownedUnusedInputs(existing, plan.retiredInputs!));
    const kept = (existing.inputs as McpInput[]).filter((i) => !takeable.has(i.id));
    if (kept.length !== (existing.inputs as McpInput[]).length) {
      if (kept.length > 0) existing.inputs = kept;
      else delete existing.inputs;
      removed.push('inputs');
    }
  }
  if (ide === 'vscode' && inputs.length > 0) {
    const have = (existing.inputs as McpInput[] | undefined) ?? [];
    const ids = new Set(have.map((i) => i.id));
    for (const input of inputs) {
      if (ids.has(input.id)) continue;
      have.push(input);
      ids.add(input.id);
      if (!written.includes('inputs')) written.push('inputs');
    }
    existing.inputs = have;
  }
  return { written: written.filter((k) => k !== 'inputs'), removed: removed.filter((k) => k !== 'inputs') };
}

/**
 * Bring forward plugin servers that still read exactly as an earlier release
 * wrote them. Returns the server keys it replaced.
 *
 * A rebuild leaves an existing entry alone, because people tune them. That was
 * also why a default we had to change never reached an existing install: three
 * servers pointed at npm packages that do not exist — one of them unpublished,
 * so its name is anyone's to claim — and every remote server in `.mcp.json` was
 * written in a shape Claude Code cannot load. An entry that is byte for byte
 * what we generated was never customised, so replacing it takes nothing of the
 * user's. Anything that differs, even by one argument, stays theirs, and
 * `doctor` says what is wrong with it instead.
 */
export function upgradeGeneratedServers(
  existingServers: Record<string, unknown>,
  ide: IdeChoice,
  included: Set<string>,
): string[] {
  const upgraded: string[] = [];
  for (const plugin of Object.values(PLUGINS)) {
    const key = plugin.mcpServerKey;
    if (!key || !plugin.mcpConfig || !included.has(key) || !(key in existingServers)) continue;
    const current = entryFor(serverFor(plugin, ide), ide);
    const have = canonical(existingServers[key]);
    if (have === canonical(current)) continue;
    // Every shape an earlier release wrote: each earlier default, in the entry
    // shape and the env-variable spelling of the time.
    const earlier: unknown[] = [];
    const configs = [
      { mcpConfig: plugin.mcpConfig, envVars: plugin.envVars },
      ...(plugin.previousMcpConfigs ?? []).map((p) => ({ mcpConfig: p.mcpConfig, envVars: p.envVars })),
    ];
    for (const cfg of configs) {
      for (const legacyEnv of [false, true]) {
        const old = serverFor(cfg, ide, legacyEnv);
        earlier.push(entryFor(old, ide), entryFor(old, ide, true));
      }
    }
    if (earlier.some((e) => canonical(e) === have)) {
      existingServers[key] = current;
      upgraded.push(key);
    }
  }
  return upgraded;
}

/**
 * The text to write, or the same refusal an unparseable config gets when a
 * TOML config is laid out in a way that cannot be changed line by line —
 * named and left alone, never rewritten wholesale.
 */
function serialiseOrRefuse(before: string | null, value: Record<string, unknown>, rel: string): string {
  try {
    return serialiseMcpConfig(before, value, rel);
  } catch (err) {
    if (err instanceof TomlEditError) throw new UnreadableConfigError(rel, 'uneditable');
    throw err;
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
  ide?: IdeChoice,
  team?: TeamMcpPlan,
): Promise<ScaffoldResult> {
  const destPath = resolve(projectRoot, destRelPath);

  // Build server list from plugin configs
  const servers: Record<string, VsCodeServer> = {};
  let inputs: McpInput[] = [];
  const resolvedIde = ide ?? 'vscode';
  // A team server with an integration's name replaces it, and an integration
  // the team's policy refuses is not written at all.
  const teamOwned = new Set([...Object.keys(team?.servers ?? {}), ...(team?.blocked ?? [])]);

  if (stack) {
    const included = getIncludedMcpServers(stack, repoInfo);

    for (const plugin of Object.values(PLUGINS)) {
      if (plugin.mcpServerKey && included.has(plugin.mcpServerKey) && !teamOwned.has(plugin.mcpServerKey)) {
        servers[plugin.mcpServerKey] = serverFor(plugin, resolvedIde);
        if (plugin.mcpInputs) {
          inputs.push(...plugin.mcpInputs);
        }
      }
    }
  }

  // Transform to IDE-specific format
  const output = transformMcpForIde(resolvedIde, servers, inputs.length > 0 ? inputs : undefined);

  if (existsSync(destPath)) {
    // Merge: add missing servers without overwriting existing ones.
    //
    // Guarded for the same reason `rebuildMcpConfig` below is, and it took
    // longer to get here because this is the *scaffold* path — nobody expected
    // a first install to meet a config it could not read. It does: VS Code
    // reads `mcp.json` as JSONC, so a hand-written one with a `//` comment is
    // legal to VS Code and fatal here, and every adapter's `install()` runs
    // this. An unguarded throw left the framework tree written and the manifest
    // absent, which the front door then read as "not set up" — pointing at the
    // `init` that had just crashed. One file, two readers, one hardened.
    // The read is guarded as well as the parse. Guarding one and not the other
    // meant an unreadable config took `sync` down with a bare `✗ EACCES` while
    // `doctor`, `status` and `sync --check` — which only ever call `existsSync`
    // on this path — all reported the project healthy.
    let existingContent: string;
    try {
      existingContent = await readFile(destPath, 'utf8');
    } catch {
      throw new UnreadableConfigError(destRelPath, 'unreadable');
    }
    let existing: Record<string, unknown>;
    try {
      existing = parseMcpConfigText(existingContent, destRelPath);
    } catch {
      throw new UnreadableConfigError(destRelPath);
    }

    const containerKey = containerKeyFor(resolvedIde);

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

    const teamChanges = applyTeamPlan(existing, resolvedIde, team);
    added += teamChanges.written.length + teamChanges.removed.length;

    if (added === 0) {
      return { path: destPath, action: 'skipped', team: teamChanges };
    }

    await writeFile(destPath, serialiseOrRefuse(existingContent, existing, destRelPath));
    return { path: destPath, action: 'created', team: teamChanges };
  }

  const teamChanges = applyTeamPlan(output, resolvedIde, team);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, serialiseOrRefuse(null, output, destRelPath));

  return { path: destPath, action: 'created', team: teamChanges };
}

// ── MCP config rebuild for reconfigure ────────────────────────

/**
 * Returns the relative path to the MCP config file for a given IDE.
 */
export function getMcpConfigRelPath(ide: IdeChoice): string {
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
      return '.codex/config.toml';
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
/**
 * Scaffold the MCP config into `results`, naming a config we cannot read
 * instead of aborting.
 *
 * Every adapter's `install()` ends here, and `init` always runs `install()`, so
 * an unparseable config used to take the whole command down — leaving the
 * framework tree written and no manifest beside it. The front door then read
 * that as "not set up in this project" and recommended the `init` that had just
 * crashed, with the offending file never named. Naming it and carrying on is
 * what `sync` already does for the skill matrix.
 */
export async function scaffoldMcpConfigInto(
  results: CopyResults,
  projectRoot: string,
  destRelPath: string,
  stack?: StackConfig,
  repoInfo?: RepoInfo,
  ide?: IdeChoice,
  team?: TeamMcpPlan,
): Promise<void> {
  try {
    const result = await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide, team);
    results[result.action].push(result.path);
    // Reported by the command, as the rebuild's changes are: a server removed
    // here, before the rebuild runs, was otherwise removed without a word.
    if (result.team?.written.length) (results.mcpTeamWritten ??= []).push(...result.team.written);
    if (result.team?.removed.length) (results.mcpTeamRemoved ??= []).push(...result.team.removed);
  } catch (err) {
    if (!(err instanceof UnreadableConfigError)) throw err;
    (results.unreadable ??= []).push(err.reason === 'unparseable' ? err.file : `${err.file}\u0000${err.reason}`);
  }
}

/**
 * Take our MCP servers back out of a config file we only merged into.
 *
 * `scaffoldMcpConfig` never clobbers: if the file exists it adds the servers it
 * owns and leaves everything else alone. `remove --all` did not honour that — it
 * unlinked the whole file, so a project with a hand-written `opencode.json`
 * (OpenCode's entire project config, not just its MCP section) lost it. Same
 * mistake as deleting a co-owned CLAUDE.md, one file type over.
 *
 * Returns 'deleted' only when nothing of the user's was left in it.
 */
/**
 * Strip our servers from a parsed MCP config, in place, and say whether anything
 * of the user's is left. Shared with `remove`'s preview so the two agree.
 */
export function willKeepSomethingAfterStrip(
  parsed: Record<string, unknown>,
  ide?: IdeChoice,
  /** Servers the team's layers had OpenCastle write — ours to take back too. */
  teamKeys: string[] = [],
  /** VS Code inputs those servers asked for. */
  teamInputs: string[] = [],
): boolean {
  const containerKeys = ide
    ? [containerKeyFor(ide)]
    : ['mcp', 'servers', 'mcpServers', 'mcp_servers']

  const ourServerKeys = new Set([
    ...Object.values(PLUGINS)
      .filter((p) => p.mcpServerKey)
      .map((p) => p.mcpServerKey!),
    ...teamKeys,
  ]);
  const pluginInputIds = Object.values(PLUGINS).flatMap((p) => (p.mcpInputs ?? []).map((i) => i.id));

  for (const containerKey of containerKeys) {
    const servers = (parsed[containerKey] ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(servers)) {
      if (ourServerKeys.has(key)) delete servers[key];
    }
    if (Object.keys(servers).length === 0) delete parsed[containerKey];
    else parsed[containerKey] = servers;
  }

  if (Array.isArray(parsed.inputs)) {
    // Judged after the servers came out, so an input a user's own server still
    // reads survives the uninstall.
    const ourInputIds = new Set([...pluginInputIds, ...ownedUnusedInputs(parsed, teamInputs)]);
    const kept = (parsed.inputs as McpInput[]).filter((i) => !ourInputIds.has(i.id));
    if (kept.length > 0) parsed.inputs = kept;
    else delete parsed.inputs;
  }

  return Object.keys(parsed).length > 0;
}

export async function stripManagedMcpServers(
  projectRoot: string,
  ide: IdeChoice,
  createdByUs = false,
  teamKeys: string[] = [],
  teamInputs: string[] = [],
): Promise<'deleted' | 'stripped' | 'absent' | 'unreadable'> {
  return stripConfigAt(projectRoot, getMcpConfigRelPath(ide), ide, createdByUs, teamKeys, teamInputs);
}

/**
 * MCP configs a release before this one wrote where the assistant never looks.
 *
 * Codex CLI reads project servers only from `.codex/config.toml`; the
 * `.codex/mcp.json` OpenCastle wrote for it was never loaded, so every server
 * in it was one Codex did not have.
 */
export const LEGACY_MCP_CONFIGS: Partial<Record<IdeChoice, string>> = {
  codex: '.codex/mcp.json',
};

/**
 * Take our servers back out of a target's legacy MCP config, and delete it if
 * we created it and nothing of the user's is left. Anything they added stays —
 * it never reached the assistant either, and `sync` says where it belongs.
 */
export async function retireLegacyMcpConfig(
  projectRoot: string,
  ide: IdeChoice,
  createdByUs = false,
  teamKeys: string[] = [],
  teamInputs: string[] = [],
): Promise<'deleted' | 'stripped' | 'absent' | 'unreadable'> {
  const rel = LEGACY_MCP_CONFIGS[ide];
  if (!rel) return 'absent';
  // No `ide`: the legacy file is in the shape it was written in, not today's.
  return stripConfigAt(projectRoot, rel, undefined, createdByUs, teamKeys, teamInputs);
}

async function stripConfigAt(
  projectRoot: string,
  rel: string,
  ide: IdeChoice | undefined,
  createdByUs: boolean,
  teamKeys: string[],
  teamInputs: string[],
): Promise<'deleted' | 'stripped' | 'absent' | 'unreadable'> {
  const destPath = resolve(projectRoot, rel);
  if (!existsSync(destPath)) return 'absent';

  let before: string;
  try {
    before = await readFile(destPath, 'utf8');
  } catch {
    return 'unreadable';
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseMcpConfigText(before, rel);
  } catch {
    // Not ours to repair. Leaving it alone beats deleting something unreadable,
    // but 'stripped' would have removal report "kept your content in N file(s)"
    // for a file it never opened successfully.
    return 'unreadable';
  }

  // A copy to compare against: `willKeepSomethingAfterStrip` edits `parsed` in
  // place, so this is the only record of what the file said before.
  const untouched = JSON.stringify(parsed);
  const keepsSomething = willKeepSomethingAfterStrip(parsed, ide, teamKeys, teamInputs);

  // Nothing of ours was in there, so there is nothing to do — and in particular
  // nothing to delete.
  //
  // This test used to run *after* the delete branch, and the delete branch asks
  // only whether the object ends up with no keys. A config that was already empty
  // before OpenCastle ever ran — `{}`, or the `{"mcpServers": {}}` Claude Code
  // leaves behind when you remove the last project server — is empty by that
  // measure, so `remove --all` unlinked it: a file the user had committed, gone,
  // with no backup, while the preview explained that it "holds only our MCP
  // servers". `opencode.json` is OpenCode's entire project config.
  //
  // Emptiness was never the question. Whether anything of ours came out is. This
  // is the same correction `.gitignore` got four files away, where `.trim()` was
  // deciding that a file holding a single newline did not look like much.
  //
  // It also keeps byte fidelity: re-serialising reformatted a hand-written
  // one-line `opencode.json` on every uninstall, for a strip that took nothing.
  if (JSON.stringify(parsed) === untouched) return 'absent';

  // Deleted only if we created it. A file that ends up empty is not evidence that
  // it was ours — the user's own copy may have been empty when we found it — and
  // the manifest is the only thing that actually knows. An old manifest has no
  // such record, and "unknown" is treated as "not ours".
  if (!keepsSomething && createdByUs) {
    await rm(destPath, { force: true });
    return 'deleted';
  }

  // The file's own indentation, not ours. Taking our servers out of a
  // tab-indented config used to restyle every line of it.
  try {
    await writeFile(destPath, serialiseMcpConfig(before, parsed, rel));
  } catch (err) {
    if (err instanceof TomlEditError) return 'unreadable';
    throw err;
  }
  return 'stripped';
}

export interface RebuildOutcome {
  /** Integration servers moved to the current default. */
  upgraded: string[];
  /** Integration servers the stack no longer includes, deleted. */
  removed: string[];
  /** Team servers written or rewritten to match their layer. */
  teamWritten: string[];
  /** Team servers retired, and integration servers the policy refuses, deleted. */
  teamRemoved: string[];
}

export async function rebuildMcpConfig(
  projectRoot: string,
  ide: IdeChoice,
  stack: StackConfig,
  repoInfo?: RepoInfo,
  team?: TeamMcpPlan,
): Promise<RebuildOutcome> {
  const destRelPath = getMcpConfigRelPath(ide);
  const destPath = resolve(projectRoot, destRelPath);

  if (!existsSync(destPath)) {
    // No existing config — scaffold fresh
    const fresh = await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide, team);
    return { upgraded: [], removed: [], teamWritten: fresh.team?.written ?? [], teamRemoved: [] };
  }

  // Read existing config. Committed generated JSON is exactly what a merge
  // conflicts on, and an unguarded parse turned that into an abort with no
  // filename — after the adapters had already rewritten the framework
  // directories and before the manifest was written, so the sync was half
  // applied. `remove` already names the file and carries on; so does this.
  let before: string;
  try {
    before = await readFile(destPath, 'utf8');
  } catch {
    throw new UnreadableConfigError(destRelPath, 'unreadable');
  }
  let existing: Record<string, unknown>;
  try {
    existing = parseMcpConfigText(before, destRelPath);
  } catch {
    throw new UnreadableConfigError(destRelPath);
  }
  const containerKey = containerKeyFor(ide);

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
  // Returned so `sync` can say so: deleting a server from a file the user
  // commits, without a word, reads as a bug when it turns up in review.
  // Keys the team's layers decide — its own servers, and integrations its
  // policy refuses — are left to `applyTeamPlan`, which reports them apart.
  const teamOwned = new Set([...Object.keys(team?.servers ?? {}), ...(team?.blocked ?? [])]);
  const removed: string[] = [];
  for (const key of Object.keys(existingServers)) {
    if (allPluginServerKeys.has(key) && !includedServers.has(key) && !teamOwned.has(key)) {
      delete existingServers[key];
      removed.push(key);
    }
  }

  // Entries still exactly as an earlier release wrote them move to the current
  // default; customised ones are left alone (see `upgradeGeneratedServers`).
  const upgraded = upgradeGeneratedServers(
    existingServers,
    ide,
    new Set([...includedServers].filter((k) => !teamOwned.has(k))),
  );

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

  // Only set the container when there is something to put in it, or it was
  // already there. Writing `"mcp": {}` into a hand-written `opencode.json` —
  // OpenCode's entire project config — added a key the user never asked for and
  // reformatted the file, on a stack that contributes no MCP servers at all.
  if (Object.keys(existingServers).length > 0 || containerKey in existing) {
    existing[containerKey] = existingServers;
  }

  // Write the cleaned config (preserving manually-added servers and unchanged
  // plugin servers) — but only if it actually differs. This rewrote the file on
  // every sync regardless, which is how a compact config came back
  // pretty-printed by a command that had removed nothing from it.
  // Compared as values, not as text. Comparing the serialised forms meant a
  // hand-written compact config was "different" from its own pretty-printed
  // self, so `sync` reformatted a file it had changed nothing in — while
  // `remove`, which compares properly, left the same file alone. One file, two
  // policies, and the user's formatting lost to the stricter of them.
  let unchanged = false;
  try {
    unchanged = JSON.stringify(parseMcpConfigText(before, destRelPath)) === JSON.stringify(existing);
  } catch {
    unchanged = false;
  }
  if (!unchanged) await writeFile(destPath, serialiseOrRefuse(before, existing, destRelPath));

  // Re-scaffold: merges new plugin servers into the cleaned config, and writes
  // the team's servers exactly as its layers define them.
  const after = await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide, team);
  return { upgraded, removed, teamWritten: after.team?.written ?? [], teamRemoved: after.team?.removed ?? [] };
}
