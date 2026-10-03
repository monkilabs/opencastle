import { PERMISSION_MODES } from '../../convoy/spec-types.js'
import type { PermissionMode } from '../../convoy/spec-types.js'

/**
 * What each permission mode means on each agent CLI.
 *
 * The modes are Claude Code's. Every other CLI spells authority differently,
 * and this file is the one place that translates. Three meanings matter:
 *
 * - **read-only** (`plan`, and `default`, which in a headless run can only
 *   refuse what it would have asked about): the agent reads and answers. It
 *   edits no file, and runs no command beyond what the CLI itself treats as
 *   read-only. The planner runs its agents this way.
 * - **edits** (`acceptEdits` — the default — and `auto`, `dontAsk`): the agent
 *   edits files in its working directory without asking. Whether it may also
 *   run commands is each CLI's own rule, noted per CLI below.
 * - **everything** (`bypassPermissions`): no prompts and no sandbox.
 *
 * A mode an adapter cannot express is refused before the run starts, never
 * dropped: a run told to stay read-only that writes anyway is the worst
 * outcome there is.
 */

/** Every mode, for an adapter that maps the whole enum. */
const ALL: readonly PermissionMode[] = PERMISSION_MODES

type Meaning = 'read-only' | 'edits' | 'everything'

/** The three meanings the modes reduce to on a CLI that is not Claude Code. */
export function meaningOf(mode: PermissionMode | undefined): Meaning {
  switch (mode) {
    case 'plan':
    case 'default':
      return 'read-only'
    case 'bypassPermissions':
      return 'everything'
    // acceptEdits, auto, dontAsk, and no mode at all.
    default:
      return 'edits'
  }
}

export const ADAPTER_PERMISSION_MODES: Record<string, readonly PermissionMode[]> = {
  // Passed straight through as `claude -p --permission-mode <mode>`. A headless
  // run refuses whatever it would have asked about. `plan` blocks every edit;
  // it still runs read-only commands, and commands Claude Code's own auto-mode
  // classifier approves as exploration. `acceptEdits` allows edits and simple
  // filesystem commands (mkdir, mv, cp …) in the working directory.
  claude: ALL,
  // `codex exec` never asks for approval; the sandbox is the whole policy.
  // See `codexSandboxFor`. Edits mode can run commands, inside the sandbox.
  codex: ALL,
  // `copilot` tool rules. See `copilotPermissionArgs`. Edits mode runs only
  // read-only commands.
  copilot: ALL,
  // `opencode run` allows edits and commands by default and rejects what it
  // would ask about. See `opencodePermission`.
  opencode: ALL,
  // `cursor-agent -p` applies edits only with `--force`, which also allows
  // commands. See `cursorPermissionArgs`.
  cursor: ALL,
}

/**
 * The sandbox `codex exec -s` runs under.
 *
 * `codex exec` always runs with approval policy "never" — it has no `-a` of
 * its own, and the `-a never` this adapter used to pass before `exec` was
 * parsed as an option of the interactive CLI and ignored — so the sandbox is
 * all there is. `read-only` writes nothing and runs commands read-only;
 * `workspace-write` writes inside the working directory, with no network;
 * `danger-full-access` is unrestricted.
 */
export function codexSandboxFor(mode: PermissionMode | undefined): string {
  switch (meaningOf(mode)) {
    case 'read-only':
      return 'read-only'
    case 'everything':
      return 'danger-full-access'
    default:
      return 'workspace-write'
  }
}

/**
 * Copilot CLI tool rules for a headless run.
 *
 * In prompt mode Copilot cannot ask, so whatever no rule allows is refused;
 * reads inside the working directory, and read-only shell commands, need no
 * rule. `write` is every file-editing tool and `shell` every command. Deny
 * rules beat allow rules — even `--allow-all` and `COPILOT_ALLOW_ALL` in the
 * environment — so read-only is stated as denials rather than left to the
 * absence of an allow. Edits mode allows `write` and leaves commands to that
 * default, which is close to Claude Code's `acceptEdits`.
 */
export function copilotPermissionArgs(mode: PermissionMode | undefined): string[] {
  switch (meaningOf(mode)) {
    case 'read-only':
      return ['--deny-tool=write', '--deny-tool=shell']
    case 'everything':
      return ['--allow-all']
    default:
      return ['--allow-tool=write']
  }
}

/**
 * OpenCode's permission settings for a headless `opencode run`.
 *
 * `run` already allows edits and commands, and rejects whatever would need a
 * question (paths outside the project, a detected loop). Read-only denies the
 * edit and bash tools through `OPENCODE_PERMISSION` — the built-in `plan`
 * agent alone still runs shell commands. `--auto` approves the questions too.
 */
export function opencodePermission(mode: PermissionMode | undefined): { args: string[]; permission?: Record<string, string> } {
  switch (meaningOf(mode)) {
    case 'read-only':
      return { args: [], permission: { edit: 'deny', bash: 'deny' } }
    case 'everything':
      return { args: ['--auto'] }
    default:
      return { args: [] }
  }
}

/**
 * Cursor Agent flags for a headless `cursor-agent -p`.
 *
 * In print mode the agent proposes changes and applies none unless `--force`
 * is given, and `--mode ask` keeps it to read-only questions and answers. A
 * headless run in a workspace Cursor has not been told to trust — every new
 * worktree — exits at once, so read-only passes `--trust`; `--force` implies
 * it. Cursor has no grant narrower than `--force`, which also lets it run
 * commands. Everything also turns Cursor's sandbox off and approves the
 * project's MCP servers.
 */
export function cursorPermissionArgs(mode: PermissionMode | undefined): string[] {
  switch (meaningOf(mode)) {
    case 'read-only':
      return ['--trust', '--mode', 'ask']
    case 'everything':
      return ['--force', '--sandbox', 'disabled', '--approve-mcps']
    default:
      return ['--force']
  }
}

/** True when `adapter` can honour `mode`. Unknown adapters are not second-guessed. */
export function supportsPermissionMode(adapter: string, mode: PermissionMode): boolean {
  const supported = ADAPTER_PERMISSION_MODES[adapter]
  if (!supported) return true
  return supported.includes(mode)
}

/**
 * The refusal message for a mode an adapter cannot honour, or null when it can.
 *
 * Returned rather than printed so the caller decides where it goes — `run`
 * prints it and exits before any worker starts.
 */
export function permissionModeError(adapter: string, mode: PermissionMode): string | null {
  if (supportsPermissionMode(adapter, mode)) return null
  const supported = ADAPTER_PERMISSION_MODES[adapter] ?? []
  return (
    `The "${adapter}" adapter cannot honour permission mode "${mode}".\n` +
    `    It supports: ${supported.join(', ')}\n` +
    `    Use one of those, or run with --adapter claude or --adapter codex, ` +
    `which support every mode.`
  )
}
