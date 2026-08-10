import { PERMISSION_MODES } from '../../convoy/spec-types.js'
import type { PermissionMode } from '../../convoy/spec-types.js'

/**
 * Which permission modes each adapter can actually honour.
 *
 * `--permission-mode` was validated against the enum, stored on the spec,
 * threaded through four call sites in the engine, handed to the adapter — and
 * then read by exactly one of the five. On `codex`, `cursor`, `opencode` and
 * `copilot` it was accepted in full and dropped, so a run asked to hold a worker
 * to `plan` went ahead and wrote files, saying nothing.
 *
 * Silently ignoring an authority setting is the worst of the three options. The
 * other two are honouring it and refusing it, and this table is what decides
 * which of those happens: a mode listed here is honoured by that adapter, and a
 * mode absent from it is refused before the run starts, naming the alternatives.
 *
 * `ExecuteOptions.permissionMode` used to carry a note saying adapters that
 * cannot express a mode ignore it. They no longer may.
 */

/** Every mode, for an adapter that maps the whole enum. */
const ALL: readonly PermissionMode[] = PERMISSION_MODES

/**
 * The modes that all mean "do the work without asking".
 *
 * `cursor --force`, `opencode`'s unattended run, and the Copilot SDK session
 * with `onPermissionRequest` approving everything are each exactly this and
 * nothing else: there is no flag on any of them for read-only or for a wider
 * grant. They accept the modes that describe what they already do, and refuse
 * the ones that would be a lie.
 */
const EDITS_ONLY: readonly PermissionMode[] = ['acceptEdits', 'auto', 'dontAsk']

export const ADAPTER_PERMISSION_MODES: Record<string, readonly PermissionMode[]> = {
  // Passed straight through as `--permission-mode`.
  claude: ALL,
  // Mapped onto the sandbox setting — see `codexSandboxFor`.
  codex: ALL,
  cursor: EDITS_ONLY,
  opencode: EDITS_ONLY,
  copilot: EDITS_ONLY,
}

/**
 * The sandbox `codex exec -s` should run under for a given mode.
 *
 * `acceptEdits` keeps `workspace-write`, which is what the adapter has always
 * passed, so the default run is byte-for-byte what it was. The other modes stop
 * being silently equal to it.
 */
export function codexSandboxFor(mode: PermissionMode | undefined): string {
  switch (mode) {
    // "writes nothing unattended" and "plan only" are both read-only to codex.
    case 'default':
    case 'plan':
      return 'read-only'
    case 'bypassPermissions':
      return 'danger-full-access'
    // acceptEdits, auto, dontAsk, and no mode at all.
    default:
      return 'workspace-write'
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
