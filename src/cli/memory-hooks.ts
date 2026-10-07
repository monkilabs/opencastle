import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { opencastleRunner } from './ci.js'
import { cliVersionOf } from './layers.js'
import { writeLessonRules } from './lessons-rules.js'

/**
 * The team's memory, shared by the assistant's own hook.
 *
 * Every earlier way to share what agents learn asked an agent, or a person, to
 * do something extra: write a lesson when a retry worked, log a session, run a
 * command later and pick memories. The record shows how that went — 25 lessons
 * in 794 pull requests on the one project that used them, against 72 memories
 * Claude Code wrote by itself on the same project, nearly all about the
 * project and none about the person.
 *
 * So agents keep writing their own memory, which they already do reliably, and
 * the assistant runs `promote memory` when an agent stops: Claude Code on
 * SessionEnd, from the project's `.claude/settings.json`; VS Code on Stop,
 * from `.github/hooks/opencastle.json`. It copies what is about the project
 * into lessons and leaves what is about the person, and the lessons go into
 * the pull request with the work, where the team reviews them.
 *
 * Both files are the project's, committed, so every teammate's assistant runs
 * the hook once they trust the folder. The settings file is the user's too:
 * only OpenCastle's own entry is ever added, replaced or removed.
 */

export const CLAUDE_SETTINGS = '.claude/settings.json'
export const VSCODE_HOOK_FILE = '.github/hooks/opencastle.json'

/** Recognises OpenCastle's entry whatever runner or version it was written with. */
const OURS = /\bopencastle(?:@\S+)?\s+promote\s+memory\b/

/** The command the hook runs. `--json` keeps it quiet and always exits 0. */
export function memoryHookCommand(projectRoot: string, cliVersion: string): string {
  return `${opencastleRunner(projectRoot, cliVersion)} promote memory --json`
}

type Json = Record<string, unknown>

function hookEntry(command: string): Json {
  return { type: 'command', command, timeout: 30 }
}

function isOurs(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && typeof (entry as Json).command === 'string' && OURS.test((entry as Json).command as string))
}

/** Settings with OpenCastle's SessionEnd entry taken out, and nothing else changed. */
function withoutOurs(settings: Json): Json {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...(settings.hooks as Json) } : null
  if (!hooks || !Array.isArray(hooks.SessionEnd)) return settings
  const groups = (hooks.SessionEnd as unknown[])
    .map((g) => {
      if (!g || typeof g !== 'object' || !Array.isArray((g as Json).hooks)) return g
      const kept = ((g as Json).hooks as unknown[]).filter((h) => !isOurs(h))
      return kept.length === 0 ? null : { ...(g as Json), hooks: kept }
    })
    .filter((g) => g !== null)
  if (groups.length > 0) hooks.SessionEnd = groups
  else delete hooks.SessionEnd
  const out = { ...settings }
  if (Object.keys(hooks).length > 0) out.hooks = hooks
  else delete out.hooks
  return out
}

function readJson(abs: string): Json | null | 'unreadable' {
  if (!existsSync(abs)) return null
  try {
    const value = JSON.parse(readFileSync(abs, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

function expectedClaudeSettings(current: Json | null, command: string): Json {
  const base = withoutOurs(current ?? {})
  const hooks = base.hooks && typeof base.hooks === 'object' ? { ...(base.hooks as Json) } : {}
  const groups = Array.isArray(hooks.SessionEnd) ? [...(hooks.SessionEnd as unknown[])] : []
  hooks.SessionEnd = [...groups, { hooks: [hookEntry(command)] }]
  return { ...base, hooks }
}

function hasOurEntry(settings: Json, command: string): boolean {
  const groups = (settings.hooks as Json | undefined)?.SessionEnd
  if (!Array.isArray(groups)) return false
  const want = JSON.stringify(hookEntry(command))
  return groups.some((g) => Array.isArray((g as Json)?.hooks) && ((g as Json).hooks as unknown[]).some((h) => JSON.stringify(h) === want))
}

function vscodeHookText(command: string): string {
  return `${JSON.stringify({ hooks: { Stop: [hookEntry(command)] } }, null, 2)}\n`
}

export interface HookWrite {
  path: string
  outcome: 'created' | 'updated' | 'unchanged' | 'unreadable'
}

/** Add or update OpenCastle's hook for each assistant that has one. */
export function writeMemoryHooks(projectRoot: string, ides: readonly string[], cliVersion: string): HookWrite[] {
  const command = memoryHookCommand(projectRoot, cliVersion)
  const out: HookWrite[] = []
  if (ides.includes('claude-code')) {
    const abs = join(projectRoot, CLAUDE_SETTINGS)
    const current = readJson(abs)
    if (current === 'unreadable') out.push({ path: CLAUDE_SETTINGS, outcome: 'unreadable' })
    else if (current && hasOurEntry(current, command)) out.push({ path: CLAUDE_SETTINGS, outcome: 'unchanged' })
    else {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, `${JSON.stringify(expectedClaudeSettings(current, command), null, 2)}\n`)
      out.push({ path: CLAUDE_SETTINGS, outcome: current ? 'updated' : 'created' })
    }
  }
  if (ides.includes('vscode')) {
    const abs = join(projectRoot, VSCODE_HOOK_FILE)
    const text = vscodeHookText(command)
    let current: string | null = null
    try {
      current = readFileSync(abs, 'utf8')
    } catch {
      current = null
    }
    if (current === text) out.push({ path: VSCODE_HOOK_FILE, outcome: 'unchanged' })
    else {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
      out.push({ path: VSCODE_HOOK_FILE, outcome: current === null ? 'created' : 'updated' })
    }
  }
  return out
}

/** Hooks that are missing or no longer run the command this release writes. */
export function memoryHooksDrift(
  projectRoot: string,
  ides: readonly string[],
  cliVersion: string,
): Array<{ ide: string; path: string; detail: string; unreadable?: boolean }> {
  const command = memoryHookCommand(projectRoot, cliVersion)
  const out: Array<{ ide: string; path: string; detail: string; unreadable?: boolean }> = []
  if (ides.includes('claude-code')) {
    const current = readJson(join(projectRoot, CLAUDE_SETTINGS))
    if (current === 'unreadable') {
      out.push({ ide: 'claude-code', path: CLAUDE_SETTINGS, detail: 'is not valid JSON, so the memory hook cannot be checked', unreadable: true })
    } else if (!current || !hasOurEntry(current, command)) {
      out.push({ ide: 'claude-code', path: CLAUDE_SETTINGS, detail: `has no SessionEnd hook running ${command}` })
    }
  }
  if (ides.includes('vscode')) {
    let current: string | null = null
    try {
      current = readFileSync(join(projectRoot, VSCODE_HOOK_FILE), 'utf8')
    } catch {
      current = null
    }
    if (current !== vscodeHookText(command)) {
      out.push({ ide: 'vscode', path: VSCODE_HOOK_FILE, detail: current === null ? 'the memory hook is missing' : `no longer runs ${command}` })
    }
  }
  return out
}

/**
 * What every compile of an assistant ends with, so a project is never
 * compiled without it: the lessons it loads and, for Claude Code and VS Code,
 * the hook that shares what its agents remember. Run by each adapter, so
 * `init`, `sync` and anything else that compiles a target agree with
 * `sync --check` by construction.
 */
export function compileTeamMemory(pkgRoot: string, projectRoot: string, ide: string): HookWrite[] {
  writeLessonRules(projectRoot, [ide])
  return writeMemoryHooks(projectRoot, [ide], cliVersionOf(pkgRoot))
}

/** The files that hold an OpenCastle memory hook now. */
export function memoryHookPaths(projectRoot: string): string[] {
  const out: string[] = []
  const settings = readJson(join(projectRoot, CLAUDE_SETTINGS))
  if (settings && settings !== 'unreadable' && JSON.stringify(withoutOurs(settings)) !== JSON.stringify(settings)) out.push(CLAUDE_SETTINGS)
  if (existsSync(join(projectRoot, VSCODE_HOOK_FILE))) out.push(VSCODE_HOOK_FILE)
  return out
}

/** Take OpenCastle's hooks out: its entry from the settings, and its own hook file. */
export function stripMemoryHooks(projectRoot: string): string[] {
  const removed: string[] = []
  const settingsPath = join(projectRoot, CLAUDE_SETTINGS)
  const current = readJson(settingsPath)
  if (current && current !== 'unreadable') {
    const next = withoutOurs(current)
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      if (Object.keys(next).length === 0) rmSync(settingsPath)
      else writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
      removed.push(CLAUDE_SETTINGS)
    }
  }
  const hookFile = join(projectRoot, VSCODE_HOOK_FILE)
  if (existsSync(hookFile)) {
    rmSync(hookFile)
    removed.push(VSCODE_HOOK_FILE)
  }
  return removed
}
