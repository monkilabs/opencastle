import type { PluginConfig } from '../orchestrator/plugins/types.js'
import { EXTENSION_NAMESPACE, mcpSchemaUrl, pluginSchemaUrl } from './agent-plugin.js'

/**
 * Each integration as an Agent Plugin: `plugin.json` and `mcp.json` beside its
 * `skills/<name>/SKILL.md`, compiled from the integration's `config.ts`.
 *
 * `config.ts` stays the source: it carries what only OpenCastle reads —
 * detection, the agents whose tools a server extends, earlier defaults to
 * migrate from. That goes under `extensions["dev.opencastle"]`, the namespace
 * the standard gives a client for its own data, and the portable part is what
 * any client loads. `npm run plugins:build` writes the files and a test holds
 * them to `config.ts`, as the website's snippets are held to it.
 */

const REPOSITORY = 'https://github.com/monkilabs/opencastle'

/** An integration's `mcp.json` value, or null when its server cannot be written portably. */
export function packMcp(p: PluginConfig): Record<string, unknown> | null {
  const cfg = p.mcpConfig
  if (!cfg || !p.mcpServerKey) return null
  let server: Record<string, unknown>
  if (cfg.type === 'http') {
    // A URL with a value only the user can supply — a tenant id — is not a
    // portable server; the extension data says what it needs.
    if (!cfg.url || cfg.url.includes('${')) return null
    server = { type: 'streamable-http', url: cfg.url }
  } else {
    if (!cfg.command || [cfg.command, ...(cfg.args ?? [])].some((a) => a.includes('${'))) return null
    // No `env`: the standard has no way to name a secret yet, so a server that
    // needs a token reads it from the environment the assistant runs in, and
    // the extension data lists which.
    server = { type: 'stdio', command: cfg.command, ...(cfg.args && cfg.args.length > 0 && { args: cfg.args }) }
  }
  return { $schema: mcpSchemaUrl(), mcpServers: { [p.mcpServerKey]: server } }
}

/** An integration's `plugin.json` value. */
export function packManifest(p: PluginConfig): Record<string, unknown> {
  const mcp = packMcp(p)
  const what = p.mcpServerKey ? (mcp ? 'skill and MCP server' : 'skill (its MCP server needs per-user setup)') : 'skill'
  return {
    $schema: pluginSchemaUrl(),
    name: p.id,
    description: `${p.name} ${what} for AI coding assistants: ${p.hint.replace(/\.$/, '')}.`,
    homepage: p.docsUrl ?? 'https://www.opencastle.dev/docs/plugins',
    repository: REPOSITORY,
    license: 'MIT',
    keywords: [p.category, p.subCategory],
    extensions: {
      [EXTENSION_NAMESPACE]: {
        label: p.label,
        category: p.category,
        subCategory: p.subCategory,
        authType: p.authType,
        ...(p.envVars.length > 0 && { env: p.envVars.map((e) => e.name) }),
        ...(p.mcpInputs && p.mcpInputs.length > 0 && { inputs: p.mcpInputs.map((i) => i.id) }),
        ...(p.officialDocs && { officialDocs: p.officialDocs }),
      },
    },
  }
}

/** Every file an integration's directory holds besides `config.ts` and its skill, as path → text. */
export function packFiles(p: PluginConfig): Record<string, string> {
  const files: Record<string, string> = { 'plugin.json': JSON.stringify(packManifest(p), null, 2) + '\n' }
  const mcp = packMcp(p)
  if (mcp) files['mcp.json'] = JSON.stringify(mcp, null, 2) + '\n'
  return files
}
