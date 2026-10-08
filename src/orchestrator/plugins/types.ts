import type { IdeChoice } from '../../cli/types.js';

/**
 * Configuration for a tool plugin.
 * Single source of truth for tool metadata used by init, adapters, and agents.
 */
export interface PluginConfig {
  /** Unique ID matching TechTool | TeamTool union type */
  id: string;

  /** Human-readable display name */
  name: string;

  /** Plugin category */
  category: 'tech' | 'team';

  /** Sub-category for grouping */
  subCategory: 'cms' | 'database' | 'deployment' | 'framework' | 'codebase-tool' | 'task-management' | 'knowledge-management' | 'notifications' | 'source-control' | 'testing' | 'e2e-testing' | 'design' | 'email' | 'payments' | 'observability';

  /** Label shown in the `npx opencastle init` multiselect */
  label: string;

  /** Hint shown next to the label in multiselect */
  hint: string;

  /** Skill directory name (matches the old skills/ dirname). null if no skill. */
  skillName: string | null;

  /** MCP server key used in the generated MCP config. Omit if no MCP server. */
  mcpServerKey?: string;

  /** Raw MCP server config (required when mcpServerKey is set) */
  mcpConfig?: McpServerConfig;

  /** Authentication type */
  authType: 'oauth' | 'env-token' | 'none';

  /** Required environment variables for this plugin */
  envVars: EnvVarRequirement[];

  /** Tools to inject into specific agent definitions when this plugin is selected.
   * Key = agent name (e.g. 'content-engineer'), Value = tool names to append. */
  agentToolMap?: Record<string, string[]>;

  /** URL to setup guide on opencastle.dev (null if none) */
  docsUrl: string | null;

  /** Official product documentation URL */
  officialDocs: string;

  /** NPM package for the MCP server (omit for HTTP/OAuth servers or plugins without MCP) */
  mcpPackage?: string;

  /** Whether this plugin should be preselected in the init prompt */
  preselected?: boolean;

  /** VS Code input prompts required by this plugin's MCP config (e.g. tenant ID) */
  mcpInputs?: McpInput[];

  /**
   * For a remote server that only some clients can sign in to with OAuth.
   *
   * GitHub's completes OAuth in VS Code and in no other target: Claude Code,
   * Cursor, Windsurf, OpenCode and Codex must send a personal access token. The
   * targets in `oauthTargets` get `mcpConfig` alone and need no token; every
   * other target also sends `headers`, each value a `${NAME}` reference to one
   * of `envVars`, written in that target's own spelling.
   */
  tokenAuth?: {
    oauthTargets: IdeChoice[];
    headers: Record<string, string>;
  };

  /**
   * What earlier releases generated for this server, newest first.
   *
   * `sync` leaves a server entry alone once it is in a config, because people
   * tune them — an extra env var, a different flag. That also meant a default we
   * had to change never reached anyone who already had it: a package that was
   * unpublished from npm stayed in every existing config, and so did every
   * `@latest`. An entry that is still byte for byte one of these was never
   * customised, so it is ours to replace; anything else stays the user's.
   */
  previousMcpConfigs?: PreviousMcpConfig[];
}

export interface PreviousMcpConfig {
  mcpConfig: McpServerConfig;
  /**
   * The env vars that release injected, written out even when they match the
   * current ones: if a later release changes them, this entry must still
   * describe what its own release wrote, or `sync` stops recognising it.
   */
  envVars: EnvVarRequirement[];
}

export interface McpInput {
  id: string;
  type: 'promptString';
  description: string;
  /** VS Code stores a password input in its secret storage and masks it. */
  password?: boolean;
}

export interface McpServerConfig {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envFile?: string;
}

export interface EnvVarRequirement {
  /** Environment variable name */
  name: string;
  /** Short description of where to get the value */
  hint: string;
}
