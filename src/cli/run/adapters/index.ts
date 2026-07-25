import type { AgentAdapter } from '../../convoy/spec-types.js'

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

/**
 * Detection priority order — checked first-to-last.
 * The first available adapter wins.
 */
const DETECTION_ORDER = ['copilot', 'claude', 'cursor', 'opencode', 'codex'] as const

/**
 * Auto-detect which adapter CLI is available on the system.
 * Returns the adapter name or null if none found.
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
 * Clean up all loaded adapters (stop SDK clients, close connections).
 * Call this before process exit to avoid hanging.
 */
export async function cleanupAdapters(): Promise<void> {
  for (const loader of Object.values(ADAPTERS)) {
    try {
      const mod = await loader()
      await mod.cleanup?.()
    } catch { /* ignore */ }
  }
}

/**
 * List all registered adapters with their availability status.
 */
export async function listAdapters(): Promise<Array<{ name: string; available: boolean }>> {
  const result: Array<{ name: string; available: boolean }> = []
  for (const [name, loader] of Object.entries(ADAPTERS)) {
    const mod = await loader()
    result.push({
      name,
      available: await mod.isAvailable(),
    })
  }
  return result
}
