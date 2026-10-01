import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The namespace every command OpenCastle compiles is invoked under.
 *
 * `/bug-fix` was a name anyone could want: a teammate's own command, another
 * tool's, a skill. Compiled commands now live under one prefix, `/oc:bug-fix`,
 * and in the directories commands live in OpenCastle owns that namespace and
 * nothing beside it — so a command someone writes by hand is never overwritten,
 * swept, removed, or reported as drift.
 *
 * The prefix is a namespace, not a mark of origin. A team's own prompt in a
 * baseline or in `.opencastle/prompts/` compiles to `/oc:<name>` as well: it is
 * shared, reviewed config that `sync` rewrites, which is what the prefix tells
 * the person typing it.
 */
export const COMMAND_NAMESPACE = 'oc'

/** What a person types after the slash: `oc:bug-fix`. */
export function commandName(name: string): string {
  return `${COMMAND_NAMESPACE}:${name}`
}

/**
 * Claude Code names a command after its path under `.claude/commands/`, with
 * each directory becoming a `:` segment — `oc/bug-fix.md` is `/oc:bug-fix`. A
 * directory, not a colon in the file name, because Windows cannot check out a
 * file whose name contains one.
 */
export const CLAUDE_COMMANDS_DIR = `commands/${COMMAND_NAMESPACE}`

/**
 * VS Code reads prompt files from the top of `.github/prompts/` only, so the
 * namespace goes in the file name, and the command name — `name:` in the
 * frontmatter, which VS Code prefers to the file name — carries the colon.
 */
export function vscodePromptFile(fileName: string): string {
  return `${COMMAND_NAMESPACE}.${fileName}`
}

/**
 * Give a prompt file the namespaced command name, in its frontmatter.
 *
 * Any `name:` the source declared is replaced rather than prefixed: Claude Code
 * ignores the field and names commands after the file, so honouring it here
 * would give one prompt two different names in two assistants.
 */
export function withCommandName(content: string, name: string): string {
  const line = `name: '${commandName(name)}'`
  // The file's own line endings, so a CRLF checkout of a team's prompt is not
  // rewritten into mixed endings.
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (close > 0) {
      // The declared name and, for a block scalar (`name: >`), the indented
      // lines that continue it — left behind, they would break the YAML and
      // take `description` and `agent` down with it.
      const kept: string[] = []
      let inName = false
      for (const l of lines.slice(1, close)) {
        if (/^name\s*:/.test(l)) {
          inName = true
          continue
        }
        if (inName && /^[ \t]/.test(l)) continue
        inName = false
        kept.push(l)
      }
      return ['---', line, ...kept, ...lines.slice(close)].join(eol)
    }
  }
  return `---${eol}${line}${eol}---${eol}${eol}${content}`
}

/**
 * Does this file say a release of ours wrote it?
 *
 * Every prompt and workflow OpenCastle has shipped since 0.2 opens with
 * `<!-- ⚠️ This file is managed by OpenCastle. … -->`. Only inside an HTML
 * comment, and only near the top: the same words in a person's own sentence
 * are theirs, which is the distinction `managed-block.ts` learned for root
 * files.
 */
export function carriesOurBanner(content: string): boolean {
  const lines = content
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 12)
  return lines.some((l) => l.startsWith('<!--') && l.includes('This file is managed by OpenCastle'))
}

/**
 * Every prompt and workflow a release before the namespace shipped — read
 * from all 103 release tags, 0.1.0 to 1.0.0. A closed list: those releases are
 * done.
 *
 * The banner alone is not enough to call a file theirs. Namespaced output
 * carries it too, so a person who copies `oc/bug-fix.md` to `our-bug-fix.md`
 * and edits it would see their copy deleted on the next sync. A legacy file is
 * one of these names *and* carries the banner.
 */
const LEGACY_PROMPTS = [
  'assess-complexity', 'bootstrap-customizations', 'brainstorm', 'bug-fix', 'create-skill',
  'fix-convoy', 'fix-prd', 'generate-convoy', 'generate-prd', 'generate-task-spec',
  'implement-feature', 'metrics-report', 'quick-refinement', 'resolve-pr-comments',
  'validate-convoy', 'validate-prd',
]
const LEGACY_WORKFLOWS = [
  'README', 'bug-fix', 'data-pipeline', 'database-migration', 'feature-implementation',
  'performance-optimization', 'refactoring', 'schema-changes', 'security-audit',
  'shared-delivery-phase',
]

/** File names a release before the namespace wrote at the top of `.claude/commands/`. */
const LEGACY_CLAUDE_NAMES = new Set([
  ...LEGACY_PROMPTS.map((n) => `${n}.md`),
  ...LEGACY_WORKFLOWS.map((n) => `workflow-${n}.md`),
])

/** File names a release before the namespace wrote in `.github/prompts/`. */
const LEGACY_VSCODE_NAMES = new Set(LEGACY_PROMPTS.map((n) => `${n}.prompt.md`))

/**
 * Was this project last compiled by a release before the namespace?
 *
 * Legacy output is looked for only then — during the sync that upgrades it,
 * or over an install whose manifest is gone. Afterwards the old names are free
 * again: a team that copies `oc/bug-fix.md` back to `bug-fix.md` because it
 * prefers the short name keeps its copy, banner and all.
 *
 * Read from a mark in the manifest, not from its version. 1.0.0 shipped
 * without the namespace, and which number the namespaced release gets depends
 * on what else merges first — a version cut-off guessed here would miss every
 * project compiled in between, and leave a stale `/bug-fix` beside
 * `/oc:bug-fix` in each of them.
 */
export function compiledBeforeNamespace(projectRoot: string): boolean {
  for (const rel of ['.opencastle/manifest.json', '.opencastle.json']) {
    const abs = resolve(projectRoot, rel)
    if (!existsSync(abs)) continue
    try {
      const manifest = JSON.parse(readFileSync(abs, 'utf8')) as { commandNamespace?: unknown }
      return manifest.commandNamespace !== COMMAND_NAMESPACE
    } catch {
      return true
    }
  }
  return true
}

/** Does the file at `abs` carry our banner? An unreadable file is not ours to delete. */
function bannerAt(abs: string): boolean {
  try {
    return carriesOurBanner(readFileSync(abs, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Commands a release before the namespace compiled into the top of
 * `.claude/commands/`.
 *
 * Those releases wrote `bug-fix.md` and `workflow-bug-fix.md` there and swept
 * the whole directory on every sync. Now commands go under `oc/`, and nothing
 * the rest — so the old files would linger as a second, stale `/bug-fix` beside
 * `/oc:bug-fix`. One of their names with our banner is theirs; anything else in
 * the directory is a person's, and is left alone.
 *
 * Paths are relative to the project root, with forward slashes.
 */
export function legacyClaudeCommands(projectRoot: string, dotDir = '.claude'): string[] {
  const dir = resolve(projectRoot, dotDir, 'commands')
  if (!existsSync(dir) || !compiledBeforeNamespace(projectRoot)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && LEGACY_CLAUDE_NAMES.has(e.name) && bannerAt(resolve(dir, e.name)))
    .map((e) => `${dotDir}/commands/${e.name}`)
    .sort()
}

/**
 * Is this file in `.github/prompts/` one OpenCastle wrote?
 *
 * VS Code reads prompts only from the top of that directory, so OpenCastle's
 * and a person's share it. Ours are the `oc.` files, plus the un-namespaced
 * ones a release before the namespace wrote — which `sync` replaces. Everything else is
 * theirs: never swept, never reported as drift, never removed.
 */
export function isOurVscodePrompt(fileName: string, abs: string, projectRoot: string): boolean {
  if (fileName.startsWith(`${COMMAND_NAMESPACE}.`)) return true
  return LEGACY_VSCODE_NAMES.has(fileName) && compiledBeforeNamespace(projectRoot) && bannerAt(abs)
}

/**
 * Prompt files a release before the namespace wrote in `.github/prompts/`,
 * present now — `bug-fix.prompt.md`, written today as `oc.bug-fix.prompt.md`.
 */
export function legacyVscodePrompts(projectRoot: string): string[] {
  const dir = resolve(projectRoot, '.github', 'prompts')
  if (!existsSync(dir) || !compiledBeforeNamespace(projectRoot)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && LEGACY_VSCODE_NAMES.has(e.name) && bannerAt(resolve(dir, e.name)))
    .map((e) => `.github/prompts/${e.name}`)
    .sort()
}
