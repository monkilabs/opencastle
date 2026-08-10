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
  TaskStep, Hook, TaskOutput, TaskInput, WatchConfig, MCPServerConfig,
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
  review_stages?: boolean;
  reviewer_model?: string;
  review_budget?: number;
  on_review_budget_exceeded?: 'skip' | 'downgrade' | 'stop';
  max_concurrent_reviews?: number;
  review_heuristics?: ReviewHeuristics;
  detect_drift?: boolean;
  on_dispute?: 'continue' | 'stop';
  /** Maximum concurrent tasks in swarm mode (default: 8). */
  max_swarm_concurrency?: number;
  /** MCP servers available to tasks (Phase 19.7). */
  mcp_servers?: MCPServerConfig[];
  /** Auto-approve all MCP tool calls without prompting (Phase 19.7). */
  mcp_approve_all?: boolean;
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
  /** Spec schema version (1 for Convoy Engine format, 2 for pipeline chaining). */
  version?: number;
  /** Worker defaults merged into each task (Convoy Engine). */
  defaults?: TaskDefaults;
  /** Shell commands run after all tasks complete; each must exit 0. */
  gates?: string[];
  /** How many times to retry failing gates with an auto-fix task (default: 0). */
  gate_retries?: number;
  /** Git feature branch name. */
  branch?: string;
  /** Other convoy spec names to run before this one (version: 2 pipeline specs). */
  depends_on_convoy?: string[];
  /** Optional post-convoy guard configuration. */
  guard?: GuardConfig;
  /** Post-convoy lifecycle hooks. */
  hooks?: Hook[];
  /** Watch mode configuration (Phase 17.1). */
  watch?: WatchConfig;
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
  /** Opt-in drift detection (streaming adapters only). */
  detect_drift?: boolean;
  /** Outputs this task produces as named artifacts. */
  outputs?: TaskOutput[];
  /** Inputs this task consumes from upstream task artifacts. */
  inputs?: TaskInput[];
  /** Whether this task has persistent agent identity (Phase 17.2). */
  persistent?: boolean;
  /** Browser test gate configuration for this task. */
  browser_test?: BrowserTestConfig;
}

/** Task execution status. */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'gate-failed'
  | 'skipped'
  | 'timed-out';

/** Result of a single task execution. */
export interface TaskResult {
  id: string;
  status: TaskStatus;
  duration: number;
  output: string;
  exitCode: number;
}

/** Final run report. */
export interface RunReport {
  name: string;
  startedAt: string;
  completedAt: string;
  duration: string;
  summary: RunSummary;
  tasks: TaskResult[];
}

/** Summary counts of task statuses. */
export interface RunSummary {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  'timed-out': number;
}

/** Agent runtime adapter for the run command. */
export interface AgentAdapter {
  name: string;
  isAvailable(): Promise<boolean>;
  execute(_task: Task, _options?: ExecuteOptions): Promise<ExecuteResult>;
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
  /** MCP servers to make available during execution (Phase 19.7). */
  mcpServers?: MCPServerConfig[];
  /** Automatically approve all MCP permission requests. */
  mcp_approve_all?: boolean;
}

/** Token usage data from adapter execution. */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
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
}

/** Reporter interface for the run command. */
export interface Reporter {
  onTaskStart(_task: Task): void;
  onTaskDone(_task: Task, _result: TaskResult): void;
  onTaskSkipped(_task: Task, _reason: string): void;
  onPhaseStart(_phase: number, _tasks: Task[]): void;
  onComplete(_report: RunReport): Promise<void>;
}

/** Reporter options. */
export interface ReporterOptions {
  reportDir?: string;
  verbose?: boolean;
}

/** Parsed CLI args for the run command. */
export interface RunOptions {
  file: string;
  dryRun: boolean;
  concurrency: number | null;
  adapter: string | null;
  reportDir: string | null;
  permissionMode: PermissionMode | null;
  verbose: boolean;
  help: boolean;
  resume: boolean;
  status: boolean;
  retryFailed: boolean;
  retryFailedTaskIds?: string[];
  dlqList: boolean;
  dlqResolve: boolean;
  dlqResolveId?: string;
  dlqResolveText?: string;
  dlqRetry: boolean;
  dlqRetryId?: string;
  dlqConvoyFilter?: string;
  formula: string | null;
  setVars: Record<string, string>;
  watch: boolean;
  watchConfig: string | null;
  clearScratchpad: boolean;
}

/** Validation result. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Accepted, but ignored — a retired key, or one this build does not honour. */
  warnings?: string[];
}

/** Timeout promise with cancel ability. */
export interface TimeoutHandle {
  promise: Promise<ExecuteResult>;
  clear: () => void;
}

/** Executor returned by createExecutor. */
export interface Executor {
  run(): Promise<RunReport>;
  getPhases(): Task[][];
}
