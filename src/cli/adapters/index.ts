import type { IdeAdapter } from '../types.js'

/** Lazy-loaded IDE adapters for init/update commands. */
export const IDE_ADAPTERS: Record<string, () => Promise<IdeAdapter>> = {
  vscode: () => import('./vscode.js') as Promise<IdeAdapter>,
  cursor: () => import('./cursor.js') as Promise<IdeAdapter>,
  'claude-code': () =>
    import('./claude-code.js') as Promise<IdeAdapter>,
  opencode: () =>
    import('./opencode.js') as Promise<IdeAdapter>,
  windsurf: () =>
    import('./windsurf.js') as Promise<IdeAdapter>,
  codex: () =>
    import('./codex.js') as Promise<IdeAdapter>,
  antigravity: () =>
    import('./antigravity.js') as Promise<IdeAdapter>,
}

export const VALID_IDES = Object.keys(IDE_ADAPTERS)
