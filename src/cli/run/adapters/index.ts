import type { AgentAdapter } from '../../convoy/spec-types.js'
import { readManifest } from '../../manifest.js'
import { stopAllAgents } from './agent-process.js'

/**
 * Adapter registry for agent runtimes.
 */
const ADAPTERS: Record<string, () => Promise<AgentAdapter>> = {
  claude: () => import('./claude.js') as Promise<AgentAdapter>,
  copilot: () => import('./copilot.js') as Promise<AgentAdapter>,
  cursor: () => import('./cursor.js') as Promise<AgentAdapter>,
  opencode: () => import('./opencode.js') as Promise<AgentAdapter>,
  codex: () => import('./codex.js') as Promise<AgentAdapter>,
}

/**
 * Get an adapter module by name.
 * @throws If adapter is not registered
 */
export async function getAdapter(name: string): Promise<AgentAdapter> {
  const loader = ADAPTERS[name]
  if (!loader) {
    const available = Object.keys(ADAPTERS).join(', ')
    throw new Error(
      `Unknown adapter "${name}". Available adapters: ${available}`
    )
  }
  return loader()
}

/** What a person needs to know about each runtime: its name, its command, and how to get it. */
const RUNTIMES: Record<string, { label: string; command: string; install: string }> = {
  claude: { label: 'Claude Code', command: 'claude', install: 'https://code.claude.com/docs/en/setup' },
  codex: { label: 'Codex CLI', command: 'codex', install: 'npm install -g @openai/codex' },
  cursor: { label: 'Cursor Agent CLI', command: 'cursor-agent', install: 'https://cursor.com/docs/cli/installation' },
  opencode: { label: 'OpenCode', command: 'opencode', install: 'npm install -g opencode-ai' },
  copilot: { label: 'GitHub Copilot CLI', command: 'copilot', install: 'npm install -g @github/copilot' },
}

/**
 * Detection order, when nothing chose a runtime. The CLIs that report their
 * own usage come first. Copilot is last: it used to be first and counted as
 * present whenever its SDK — a dependency of this package — could be imported,
 * so every machine "had" it.
 */
const DETECTION_ORDER = ['claude', 'codex', 'cursor', 'opencode', 'copilot'] as const

/**
 * The runtime behind each assistant `opencastle init` can configure. Windsurf
 * and Antigravity have no command-line agent convoy can drive.
 */
const IDE_RUNTIME: Record<string, string | null> = {
  'claude-code': 'claude',
  vscode: 'copilot',
  cursor: 'cursor',
  opencode: 'opencode',
  codex: 'codex',
  windsurf: null,
  antigravity: null,
}

const IDE_LABEL: Record<string, string> = { windsurf: 'Windsurf', antigravity: 'Antigravity' }

export type AdapterSource = 'flag' | 'spec' | 'configured' | 'detected'

export interface ResolvedAdapter {
  name: string
  adapter: AgentAdapter
  source: AdapterSource
  /** One line a person can read: which runtime, and why this one. */
  detail: string
}

const NAMES = Object.keys(RUNTIMES).join(', ')

/** An adapter name as a person might type it: any case, or the assistant id `init` uses. Null for none or `auto`. */
function canonicalName(raw: string | null | undefined, where: string): string | null {
  const name = raw?.trim().toLowerCase()
  if (!name || name === 'auto') return null
  const canonical = RUNTIMES[name] ? name : IDE_RUNTIME[name]
  if (canonical) return canonical
  throw new Error(`Unknown adapter "${raw}" ${where}. Choose one of: ${NAMES}.`)
}

function missingMessage(name: string): string {
  const r = RUNTIMES[name]
  return `${r.label} is not installed: \`${r.command}\` is not on PATH.\n  Install it: ${r.install}`
}

async function pinned(name: string, source: 'flag' | 'spec'): Promise<ResolvedAdapter> {
  const adapter = await getAdapter(name)
  const why = source === 'flag' ? `--adapter ${name}` : `adapter: ${name} in the spec`
  if (!(await adapter.isAvailable())) {
    const other = source === 'flag' ? 'choose another' : 'run another'
    throw new Error(`${missingMessage(name)}\n  Or ${other} with --adapter <${NAMES.replace(/, /g, '|')}>.\n  (Chosen by ${why}.)`)
  }
  return { name, adapter, source, detail: `${RUNTIMES[name].label} — ${why}` }
}

/** The assistants `opencastle init` set up, in the order it recorded them. */
async function configuredIdes(projectRoot: string): Promise<string[]> {
  try {
    const manifest = await readManifest(projectRoot)
    if (!manifest) return []
    return manifest.ides?.length ? manifest.ides : manifest.ide ? [manifest.ide] : []
  } catch {
    // An unreadable manifest is reported by `doctor`; here it only means no
    // runtime was configured that we can see, so detection decides.
    return []
  }
}

/**
 * Decide which agent runtime a run uses.
 *
 * Precedence: `--adapter` → the spec's `adapter` → the assistants in
 * `.opencastle/manifest.json` `ides`, in order (claude-code→claude,
 * vscode→copilot, cursor, opencode, codex; windsurf and antigravity have no
 * runtime) → detection in the order claude, codex, cursor, opencode, copilot.
 *
 * A runtime counts only when its CLI resolves on PATH. A runtime someone named
 * — by flag or in the spec — that is not installed is an error, never a quiet
 * switch to another; so is finding nothing at all. Each error says what to
 * install, or how to choose another.
 */
export async function resolveAdapter(opts: {
  projectRoot: string
  explicit?: string | null
  specAdapter?: string | null
}): Promise<ResolvedAdapter> {
  const flag = canonicalName(opts.explicit, 'given to --adapter')
  if (flag) return pinned(flag, 'flag')
  const spec = canonicalName(opts.specAdapter, 'in the spec')
  if (spec) return pinned(spec, 'spec')

  const notInstalled: string[] = []
  const noRuntime: string[] = []
  for (const ide of await configuredIdes(opts.projectRoot)) {
    if (!(ide in IDE_RUNTIME)) continue
    const name = IDE_RUNTIME[ide]
    if (!name) {
      noRuntime.push(IDE_LABEL[ide] ?? ide)
      continue
    }
    if (notInstalled.includes(name)) continue
    const adapter = await getAdapter(name)
    if (await adapter.isAvailable()) {
      const also = notInstalled.length
        ? ` (${notInstalled.map((n) => RUNTIMES[n].label).join(', ')} came first but ${notInstalled.length === 1 ? 'is' : 'are'} not installed)`
        : ''
      return { name, adapter, source: 'configured', detail: `${RUNTIMES[name].label} — configured by opencastle init${also}` }
    }
    notInstalled.push(name)
  }

  for (const name of DETECTION_ORDER) {
    const adapter = await getAdapter(name)
    if (await adapter.isAvailable()) {
      const notes: string[] = []
      if (notInstalled.length) {
        notes.push(`opencastle init configured ${notInstalled.map((n) => RUNTIMES[n].label).join(' and ')}, but \`${notInstalled.map((n) => RUNTIMES[n].command).join('`, `')}\` is not on PATH`)
      }
      if (noRuntime.length) notes.push(`${noRuntime.join(' and ')} has no command-line agent`)
      return {
        name,
        adapter,
        source: 'detected',
        detail: `${RUNTIMES[name].label} — found on PATH${notes.length ? `; ${notes.join('; ')}` : ''}`,
      }
    }
  }

  if (notInstalled.length) {
    throw new Error(
      `opencastle init configured ${notInstalled.map((n) => RUNTIMES[n].label).join(' and ')}, but no agent CLI is on PATH.\n` +
      notInstalled.map((n) => `  ${RUNTIMES[n].label}: ${RUNTIMES[n].install}`).join('\n') +
      `\n  Or install another runtime and pick it with --adapter <${NAMES.replace(/, /g, '|')}>.`,
    )
  }
  throw new Error(
    `No agent CLI found on PATH. Convoy needs one of these installed:\n` +
    DETECTION_ORDER.map((n) => `  ${RUNTIMES[n].label} (\`${RUNTIMES[n].command}\`): ${RUNTIMES[n].install}`).join('\n') +
    (noRuntime.length ? `\n  (${noRuntime.join(' and ')} has no command-line agent convoy can drive.)` : '') +
    `\n  Then run again, or pick one with --adapter <${NAMES.replace(/, /g, '|')}>.`,
  )
}

/**
 * Auto-detect which adapter CLI is available on the system, in detection
 * order. Returns the adapter name or null if none found.
 *
 * Kept for existing callers; new code uses `resolveAdapter`, which also
 * honours the runtime `opencastle init` configured.
 */
export async function detectAdapter(): Promise<string | null> {
  for (const name of DETECTION_ORDER) {
    const adapter = await getAdapter(name)
    if (await adapter.isAvailable()) {
      return name
    }
  }
  return null
}

/**
 * Stop every agent process an adapter started and has not seen finish, so
 * this process can exit without leaving one running.
 */
export async function cleanupAdapters(): Promise<void> {
  stopAllAgents()
}

/**
 * List all registered adapters with their availability status, in detection order.
 */
export async function listAdapters(): Promise<Array<{ name: string; available: boolean }>> {
  const result: Array<{ name: string; available: boolean }> = []
  for (const name of DETECTION_ORDER) {
    const mod = await getAdapter(name)
    result.push({ name, available: await mod.isAvailable() })
  }
  return result
}
