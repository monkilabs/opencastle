/**
 * The convoy engine's spec model.
 *
 * These were in src/cli/types.ts, which meant the compiler's type module had to
 * import from the engine to describe them — a dependency pointing the wrong way.
 * They live with the engine now, so the product side depends on nothing here.
 */
import type { ChildProcess } from 'node:child_process';
import type {
  BuiltInGatesConfig, BrowserTestConfig, GuardConfig, CircuitBreakerConfig,
  TaskStep, Hook, TaskOutput, TaskInput, MCPServerConfig,
} from './types.js';

/**
 * How much a worker may do without being asked.
 *
 * These are the modes the Claude Code CLI accepts for `--permission-mode`. A
 * non-interactive worker cannot answer a permission prompt, so a mode that
 * prompts is a mode in which the worker writes nothing.
 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Heuristics for routing tasks to review levels. */
export interface ReviewHeuristics {
  panel_paths?: string[];
  panel_agents?: string[];
  auto_pass_agents?: string[];
  auto_pass_max_lines?: number;
  auto_pass_max_files?: number;
}

/** Default values merged into each task for Convoy Engine (version: 1) specs. */
export interface TaskDefaults {
  timeout?: string;
  model?: string;
  max_retries?: number;
  agent?: string;
  adapter?: string;
  gates?: string[];
  /** How much a worker may do unattended. Defaults to `acceptEdits`. */
  permission_mode?: PermissionMode;
  built_in_gates?: BuiltInGatesConfig;
  gate_timeout?: number;
  on_exhausted?: 'dlq' | 'skip' | 'stop';
  escalate_to?: string;
  circuit_breaker?: CircuitBreakerConfig;
  review?: 'auto' | 'fast' | 'panel' | 'none';
  reviewer_model?: string;
  review_budget?: number;
  on_review_budget_exceeded?: 'skip' | 'downgrade' | 'stop';
  max_concurrent_reviews?: number;
  review_heuristics?: ReviewHeuristics;
  on_dispute?: 'continue' | 'stop';
  /** Maximum concurrent tasks in swarm mode (default: 8). */
  max_swarm_concurrency?: number;
  /** MCP servers available to tasks (Phase 19.7). */
  mcp_servers?: MCPServerConfig[];
  /** Timeout in seconds for MCP server approval prompts (Phase 19.7). */
  mcp_server_approval_timeout?: number;
  /** Browser test gate configuration for default built-in gates. */
  browser_test?: BrowserTestConfig;
  /** Auto-context compaction configuration (Phase 44). */
  compaction?: never;
}

/** Validated task spec from YAML. */
export interface TaskSpec {
  name: string;
  concurrency: number | 'auto';
  on_failure: 'continue' | 'stop';
  adapter: string;
  tasks?: Task[];
  _verbose?: boolean;
  /** Spec schema version: always 1 once parsed. */
  version?: number;
  /** Worker defaults merged into each task (Convoy Engine). */
  defaults?: TaskDefaults;
  /** Shell commands run after all tasks complete; each must exit 0. */
  gates?: string[];
  /** How many times to retry failing gates with an auto-fix task (default: 0). */
  gate_retries?: number;
  /** Git feature branch name. */
  branch?: string;
  /** Optional post-convoy guard configuration. */
  guard?: GuardConfig;
  /** Post-convoy lifecycle hooks. */
  hooks?: Hook[];
}

/** A single task in the spec. */
export interface Task {
  id: string;
  prompt: string;
  agent: string;
  timeout: string;
  depends_on: string[];
  files: string[];
  description: string;
  _process?: ChildProcess;
  /** Model override for this task. */
  model?: string;
  /** Max retry attempts (default: 1). */
  max_retries: number;
  /** Per-task adapter override. */
  adapter?: string;
  /** Per-task gate shell commands run after adapter success. */
  gates?: string[];
  /** Multi-step task sub-prompts. */
  steps?: TaskStep[];
  /** Review level override for this task. */
  review?: 'auto' | 'fast' | 'panel' | 'none';
  /** Lifecycle hooks for this task. */
  hooks?: Hook[];
  /** Outputs this task produces as named artifacts. */
  outputs?: TaskOutput[];
  /** Inputs this task consumes from upstream task artifacts. */
  inputs?: TaskInput[];
  /** Whether this task has persistent agent identity (Phase 17.2). */
  persistent?: boolean;
  /** Browser test gate configuration for this task. */
  browser_test?: BrowserTestConfig;
}

/** Agent runtime adapter for the run command. */
export interface AgentAdapter {
  name: string;
  isAvailable(): Promise<boolean>;
  /**
   * The runtime's own names for a model of each capability tier, used when a
   * spec names no model. Only aliases the runtime keeps current (Claude Code's
   * `opus`, `sonnet`, `haiku`) — never a dated model id, which would go stale.
   * Without it the runtime's default model runs everything, and the default is
   * often the most expensive one: a 30-line change cost $2 on it.
   */
  tierModels?: Partial<Record<'premium' | 'standard' | 'economy', string>>;
  /**
   * Run the task's prompt in `options.cwd` and settle once the agent is done.
   * It enforces `task.timeout` itself, and a run that timed out or was killed
   * resolves with `success: false`.
   */
  execute(_task: Task, _options?: ExecuteOptions): Promise<ExecuteResult>;
  /**
   * Stop whatever is running for this task id — including a step running under
   * a copy of the task — and every process it started. Does nothing when
   * nothing is running.
   */
  kill?(_task: Task): void;
  /** Whether the adapter supports reusing sessions across multi-step task steps. Defaults to false. */
  supportsSessionContinuity?(): boolean;
  /** Clean up any long-lived resources (SDK clients, open connections) so the process can exit. */
  cleanup?(): Promise<void>;
}

/** Options for agent execution. */
export interface ExecuteOptions {
  verbose?: boolean;
  /** Working directory for the agent process (defaults to process.cwd()). */
  cwd?: string;
  /**
   * How much the worker may do unattended.
   *
   * Claude passes it as `--permission-mode`; codex maps it onto the `exec -s`
   * sandbox. An adapter that cannot express a mode no longer ignores it — the
   * run is refused up front instead. See `adapters/permission-modes.ts` for
   * which adapter honours which.
   */
  permissionMode?: PermissionMode;
  /** A model name the runtime understands; omitted means the runtime's own default. */
  model?: string;
  /**
   * @deprecated Ignored. Agents read the project's own MCP config, which
   * `opencastle sync` compiles for every assistant; writing a second copy
   * deleted a committed `mcp.json` and dropped its `env`.
   */
  mcpServers?: MCPServerConfig[];
  /** @deprecated Ignored, with `mcpServers`. */
  mcp_approve_all?: boolean;
}

/**
 * Token usage data from adapter execution, as the runtime reported it. A field
 * the runtime did not report is left unset rather than estimated.
 */
export interface TokenUsage {
  /**
   * Every input token, cached or not: cache reads and writes are included here
   * and also given apart below. Claude Code, Cursor and OpenCode report them
   * separately, so their adapters add them in; Codex already includes them.
   */
  prompt_tokens?: number;
  /** Output tokens, reasoning included. */
  completion_tokens?: number;
  total_tokens?: number;
  /** Input tokens read from the runtime's prompt cache. */
  cache_read_tokens?: number;
  /** Input tokens written to the runtime's prompt cache. */
  cache_write_tokens?: number;
}

/** Result from an agent adapter execution. */
export interface ExecuteResult {
  success: boolean;
  output: string;
  exitCode: number;
  _timedOut?: boolean;
  taskId?: string;
  /** Token usage data if available from the adapter. */
  usage?: TokenUsage;
  /** Cost as the runtime reported it. Undefined when it reports none — never guessed here. */
  costUsd?: number;
  /** The model the runtime actually used, when it says. */
  model?: string;
}

/** Validation result. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Accepted, but ignored — a retired key, or one this build does not honour. */
  warnings?: string[];
}
