import { resolve, dirname } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getIncludedMcpServers } from './stack-config.js';
import { PLUGINS } from '../orchestrator/plugins/index.js';
import { UnreadableConfigError } from './types.js';
import type { McpInput } from '../orchestrator/plugins/types.js';
import type { ScaffoldResult, StackConfig, RepoInfo, IdeChoice, CopyResults } from './types.js';

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
 * The indentation a file already uses, so merging into it does not restyle it.
 *
 * `JSON.stringify(x, null, 2)` re-indented every co-owned config we touched. A
 * hand-written tab-indented `opencode.json` — OpenCode's entire project config —
 * came back two-space indented from a merge that added one key, and never came back
 * from the uninstall at all: 111 bytes in, 114 out, for a strip that took nothing
 * of theirs. Byte fidelity is a claim this tool makes about co-owned files, and a
 * JSON config is one of those.
 *
 * Read from the first indented line, which is what every formatter agrees on.
 * Falls back to two spaces for a file we are creating or one written on a single
 * line, which is what this always did.
 */
function indentOf(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  if (m) return m[1].includes('\t') ? '\t' : m[1].length;
  // A config written on one line has no indentation, and expanding it to three is
  // as much a restyle as collapsing it would be. `0` is what `JSON.stringify` takes
  // for "no whitespace".
  return text.trim().includes('\n') ? 2 : 0;
}

/**
 * Re-serialise a config the way the file was already written.
 *
 * Indentation and line endings both, because `JSON.stringify` emits `\n` whatever
 * it was handed and a CRLF config came back LF from a merge that added one key.
 * The same rule `.gitignore` follows: a CRLF file stays CRLF.
 */
function serialiseLike(original: string, value: unknown): string {
  const text = JSON.stringify(value, null, indentOf(original)) + '\n';
  return /\r\n/.test(original) ? text.replace(/\n/g, '\r\n') : text;
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
      existing = JSON.parse(existingContent) as Record<string, unknown>;
    } catch {
      throw new UnreadableConfigError(destRelPath);
    }

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

    await writeFile(destPath, serialiseLike(existingContent, existing));
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
  ide?: IdeChoice
): Promise<void> {
  try {
    const result = await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide);
    results[result.action].push(result.path);
  } catch (err) {
    if (!(err instanceof UnreadableConfigError)) throw err;
    (results.unreadable ??= []).push(
      err.reason === 'unreadable' ? `${err.file}\u0000unreadable` : err.file,
    );
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
): boolean {
  const containerKeys = ide
    ? [ide === 'opencode' ? 'mcp' : ide === 'vscode' ? 'servers' : 'mcpServers']
    : ['mcp', 'servers', 'mcpServers']

  const ourServerKeys = new Set(
    Object.values(PLUGINS)
      .filter((p) => p.mcpServerKey)
      .map((p) => p.mcpServerKey!),
  );
  const ourInputIds = new Set(
    Object.values(PLUGINS).flatMap((p) => (p.mcpInputs ?? []).map((i) => i.id)),
  );

  for (const containerKey of containerKeys) {
    const servers = (parsed[containerKey] ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(servers)) {
      if (ourServerKeys.has(key)) delete servers[key];
    }
    if (Object.keys(servers).length === 0) delete parsed[containerKey];
    else parsed[containerKey] = servers;
  }

  if (Array.isArray(parsed.inputs)) {
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
): Promise<'deleted' | 'stripped' | 'absent' | 'unreadable'> {
  const destPath = resolve(projectRoot, getMcpConfigRelPath(ide));
  if (!existsSync(destPath)) return 'absent';

  let before: string;
  try {
    before = await readFile(destPath, 'utf8');
  } catch {
    return 'unreadable';
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(before) as Record<string, unknown>;
  } catch {
    // Not ours to repair. Leaving it alone beats deleting something unreadable,
    // but 'stripped' would have removal report "kept your content in N file(s)"
    // for a file it never opened successfully.
    return 'unreadable';
  }

  // A copy to compare against: `willKeepSomethingAfterStrip` edits `parsed` in
  // place, so this is the only record of what the file said before.
  const untouched = JSON.stringify(parsed);
  const keepsSomething = willKeepSomethingAfterStrip(parsed, ide);

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
  await writeFile(destPath, serialiseLike(before, parsed));
  return 'stripped';
}

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
    existing = JSON.parse(before) as Record<string, unknown>;
  } catch {
    throw new UnreadableConfigError(destRelPath);
  }
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
    unchanged = JSON.stringify(JSON.parse(before)) === JSON.stringify(existing);
  } catch {
    unchanged = false;
  }
  if (!unchanged) await writeFile(destPath, serialiseLike(before, existing));

  // Re-scaffold: merges new plugin servers into the cleaned config
  await scaffoldMcpConfig(projectRoot, destRelPath, stack, repoInfo, ide);
}
