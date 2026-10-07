import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { scanForSecrets } from './secret-scan.js'

/**
 * What each assistant remembered about one repository, read from where it
 * keeps it on this machine.
 *
 * Every assistant now has a memory, and almost none of it reaches a teammate:
 * Claude Code's auto memory, VS Code's repository memory and Codex's memories
 * are files in one person's home directory. These readers find the ones that
 * belong to this repository so `promote memory` can turn them into lessons the
 * team reviews, and the status screen can say how many are not shared yet.
 *
 * Cursor keeps its memories on its own servers, and Copilot Memory lives on
 * GitHub; neither is on disk, so neither has a reader.
 */

export interface MemoryCandidate {
  /** The file, or the file and block, the memory came from — for messages. */
  label: string
  title: string
  /** The lesson body: home directory written as ~, checked for credentials. */
  body: string
  /** Recorded on the lesson, so the same memory is never promoted twice. */
  source: string
}

export interface MemorySource {
  assistant: string
  /** Where it was read, for the reader of the output. */
  where: string
  candidates: MemoryCandidate[]
  skipped: Array<[string, string]>
}

function home(): string {
  return process.env.HOME || homedir()
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|\\|$)/, home())
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** One title line from free text, capitalised. */
function asTitle(raw: string): string {
  const one = raw.replace(/[\r\n]+/g, ' ').trim()
  return one.charAt(0).toUpperCase() + one.slice(1)
}

/**
 * The checkout every worktree of this repository belongs to: assistants that
 * key memory by repository share one store across worktrees.
 */
const checkouts = new Map<string, string>()

export function mainCheckout(projectRoot: string): string {
  const known = checkouts.get(projectRoot)
  if (known) return known
  const found = findMainCheckout(projectRoot)
  checkouts.set(projectRoot, found)
  return found
}

function findMainCheckout(projectRoot: string): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return basename(common) === '.git' ? dirname(common) : projectRoot
  } catch {
    return projectRoot
  }
}

/**
 * A path as given and as resolved, so a symlinked checkout still matches. A
 * path that no longer exists, such as a memory's directory since deleted, is
 * resolved through its nearest existing parent.
 */
function forms(path: string): string[] {
  const given = path.replace(/[\\/]+$/, '')
  const out = new Set([given])
  let existing = given
  let rest = ''
  for (;;) {
    try {
      out.add(join(realpathSync(existing), rest))
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) break
      rest = join(basename(existing), rest)
      existing = parent
    }
  }
  return [...out]
}

/** True when `path` is the repository or a directory inside it. */
function within(path: string, roots: string[]): boolean {
  const p = forms(path)
  return roots.some((r) => p.some((x) => x === r || x.startsWith(r + sep)))
}

/**
 * The text of a memory, ready to be a lesson: paths on its author's machine
 * written as ~, and nothing that looks like a credential.
 */
function prepare(label: string, body: string, skipped: Array<[string, string]>): string | null {
  if (!body.trim()) {
    skipped.push([label, 'empty'])
    return null
  }
  const shared = body.split(home()).join('~').trim()
  const scan = scanForSecrets(shared, label)
  if (!scan.clean) {
    skipped.push([label, `holds what looks like a ${scan.findings[0].pattern} (line ${scan.findings[0].line})`])
    return null
  }
  return shared
}

// ── Claude Code ───────────────────────────────────────────────

/** The directory Claude Code's settings point auto memory at, if any of them does. */
function configuredMemoryDir(projectRoot: string, configDir: string): string | null {
  for (const file of [
    join(projectRoot, '.claude', 'settings.local.json'),
    join(projectRoot, '.claude', 'settings.json'),
    join(configDir, 'settings.json'),
  ]) {
    try {
      const value = (JSON.parse(readFileSync(file, 'utf8')) as { autoMemoryDirectory?: unknown }).autoMemoryDirectory
      if (typeof value === 'string' && value) return expandHome(value)
    } catch {
      // Absent or unreadable: the next one, or the default.
    }
  }
  return null
}

/**
 * Where Claude Code keeps this repository's auto memory:
 * `<config>/projects/<repository path, every other character a hyphen>/memory/`.
 * Every worktree of one repository shares it, so the path is the main
 * checkout's, which git names as the common directory's parent.
 */
export function claudeMemoryDir(projectRoot: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home(), '.claude')
  const configured = configuredMemoryDir(projectRoot, configDir)
  if (configured) return configured
  const slug = process.env.CLAUDE_CODE_PROJECT_DIR_NAME || mainCheckout(projectRoot).replace(/[^A-Za-z0-9]/g, '-')
  return join(configDir, 'projects', slug, 'memory')
}

interface MemoryFile {
  file: string
  name: string
  description?: string
  type?: string
  body: string
}

/** Markdown memory files, with or without frontmatter; MEMORY.md is an index. */
function readMemoryFiles(dir: string): MemoryFile[] {
  const out: MemoryFile[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue
    const abs = join(dir, file)
    if (!statSync(abs).isFile()) continue
    const text = readFileSync(abs, 'utf8').replace(/^﻿/, '')
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    let meta: Record<string, unknown> = {}
    try {
      meta = m ? ((parseYaml(m[1]) ?? {}) as Record<string, unknown>) : {}
    } catch {
      meta = {}
    }
    const nested = meta.metadata && typeof meta.metadata === 'object' ? (meta.metadata as Record<string, unknown>) : {}
    const type = typeof meta.type === 'string' ? meta.type : typeof nested.type === 'string' ? nested.type : undefined
    out.push({
      file,
      name: typeof meta.name === 'string' ? meta.name : file.replace(/\.md$/, ''),
      description: typeof meta.description === 'string' ? meta.description : undefined,
      type,
      body: (m ? m[2] : text).trim(),
    })
  }
  return out
}

/**
 * Memory files as lessons. A file's own `# heading` is its title when it has
 * no description, and leaves the body so the lesson does not say it twice.
 */
function fromMemoryFiles(dir: string, prefix: string, skipped: Array<[string, string]>): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  for (const memory of readMemoryFiles(dir)) {
    // Corrections, project notes and pointers to where things live are the
    // team's; a `user` memory is about one person, and stays theirs.
    if (memory.type && !['feedback', 'project', 'reference'].includes(memory.type)) {
      skipped.push([memory.file, memory.type === 'user' ? 'about you, not the project' : `a ${memory.type} memory`])
      continue
    }
    const heading = /^#\s+(.+)\r?\n?/.exec(memory.body)
    const title = asTitle(memory.description ?? heading?.[1] ?? memory.name.replace(/[-_]+/g, ' '))
    const raw = !memory.description && heading ? memory.body.slice(heading[0].length) : memory.body
    const body = prepare(memory.file, raw, skipped)
    if (body === null) continue
    out.push({ label: memory.file, title, body, source: `${prefix}:${memory.file}#${digest(memory.body)}` })
  }
  return out
}

/** Claude Code's auto memory, or a directory of memory files given with --from. */
export function readMemoryDir(dir: string, assistant: string): MemorySource {
  const skipped: Array<[string, string]> = []
  // The prefix stays Claude Code's for --from too: lessons promoted that way
  // before this reader existed carry it, and must still count as promoted.
  const candidates = fromMemoryFiles(dir, 'claude-code-memory', skipped)
  return { assistant, where: dir, candidates, skipped }
}

// ── VS Code (GitHub Copilot Chat) ─────────────────────────────

/**
 * VS Code's user data directories on this machine, stable and Insiders, the
 * way VS Code itself finds them: VSCODE_PORTABLE, then VSCODE_APPDATA, then
 * the platform's application data directory.
 */
export function vscodeUserDirs(): string[] {
  const portable = process.env.VSCODE_PORTABLE
  if (portable) return [join(portable, 'user-data', 'User')]
  const h = home()
  const appData =
    process.env.VSCODE_APPDATA ||
    (process.platform === 'win32'
      ? process.env.APPDATA || join(h, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(h, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(h, '.config'))
  return ['Code', 'Code - Insiders'].map((product) => join(appData, product, 'User'))
}

/**
 * The repository memory directories VS Code's agents keep for this folder:
 * `workspaceStorage/<hash>/GitHub.copilot-chat/memory-tool/memories/repo/`,
 * where `<hash>/workspace.json` names the folder. A folder opened more than
 * once can have more than one store; a worktree has its own.
 */
export function vscodeRepoMemoryDirs(projectRoot: string): string[] {
  const roots = [...new Set([projectRoot, mainCheckout(projectRoot)].flatMap(forms))]
  const out: string[] = []
  for (const user of vscodeUserDirs()) {
    const storage = join(user, 'workspaceStorage')
    let hashes: string[]
    try {
      hashes = readdirSync(storage)
    } catch {
      continue
    }
    for (const hash of hashes.sort()) {
      let folder: unknown
      try {
        folder = (JSON.parse(readFileSync(join(storage, hash, 'workspace.json'), 'utf8')) as { folder?: unknown }).folder
      } catch {
        continue
      }
      if (typeof folder !== 'string' || !folder.startsWith('file:')) continue
      let path: string
      try {
        path = fileURLToPath(folder)
      } catch {
        continue
      }
      if (!forms(path).some((p) => roots.includes(p))) continue
      for (const ext of ['GitHub.copilot-chat', 'github.copilot-chat']) {
        const dir = join(storage, hash, ext, 'memory-tool', 'memories', 'repo')
        if (existsSync(dir) && !out.includes(dir)) out.push(dir)
      }
    }
  }
  return out
}

function readVscode(projectRoot: string): MemorySource[] {
  return vscodeRepoMemoryDirs(projectRoot).map((dir) => {
    const skipped: Array<[string, string]> = []
    return { assistant: 'VS Code', where: dir, candidates: fromMemoryFiles(dir, 'vscode-memory', skipped), skipped }
  })
}

// ── Codex ─────────────────────────────────────────────────────

/** Codex's consolidated memory files: `memories/MEMORY.md`, and v2's. */
export function codexMemoryFiles(): string[] {
  const codexHome = process.env.CODEX_HOME || join(home(), '.codex')
  return ['memories', 'memories_v2'].map((d) => join(codexHome, d, 'MEMORY.md')).filter((f) => existsSync(f))
}

/** The `## <name>` section of a block, without its heading. */
function section(block: string, name: RegExp): string {
  const lines = block.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+/.test(l) && name.test(l.replace(/^##\s+/, '')))
  if (start === -1) return ''
  const end = lines.findIndex((l, i) => i > start && /^##?\s+/.test(l))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
}

/**
 * Codex keeps one memory for every directory a person works in. Its
 * consolidation writes `# Task Group:` blocks, each with an
 * `applies_to: cwd=<path>` line; a block whose path is this repository, or a
 * directory in it, is this repository's. Of each block, the reusable knowledge
 * and the failures are the team's. The task list points at session logs on
 * one machine, and the user preferences are about one person.
 */
function readCodexFile(file: string, projectRoot: string): MemorySource {
  const skipped: Array<[string, string]> = []
  const candidates: MemoryCandidate[] = []
  const roots = [...new Set([projectRoot, mainCheckout(projectRoot)].flatMap(forms))]
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  const blocks = text.split(/^(?=# Task Group:)/m).filter((b) => b.startsWith('# Task Group:'))
  for (const block of blocks) {
    const group = /^# Task Group:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? 'Codex memory'
    const appliesTo = /^applies_to:\s*(.*)$/m.exec(block)?.[1] ?? ''
    const cwd = /cwd=\s*((?:~|[A-Za-z]:[\\/]|\/)[^\s;,)]*)/.exec(appliesTo)?.[1]
    if (!cwd || !within(expandHome(cwd), roots)) continue
    const label = `MEMORY.md: ${group}`
    const parts = [
      ['Reusable knowledge', section(block, /^reusable knowledge/i)],
      ['Failures and how to do differently', section(block, /^failures/i)],
    ]
      .map(([heading, body]) => [heading, body.replace(/\s*(?:\[Task \d+\])+/g, '')] as const)
      .filter(([, body]) => body.trim())
    if (parts.length === 0) {
      skipped.push([label, 'no reusable knowledge or failures, only tasks and preferences'])
      continue
    }
    const body = prepare(label, parts.map(([h, b]) => `## ${h}\n\n${b}`).join('\n\n'), skipped)
    if (body === null) continue
    candidates.push({ label, title: asTitle(group), body, source: `codex-memory:${group}#${digest(body)}` })
  }
  return { assistant: 'Codex', where: file, candidates, skipped }
}

function readCodex(projectRoot: string): MemorySource[] {
  return codexMemoryFiles()
    .map((file) => readCodexFile(file, projectRoot))
    .filter((s) => s.candidates.length > 0 || s.skipped.length > 0)
}

// ── All of them ───────────────────────────────────────────────

/**
 * Every memory this machine's assistants keep about the repository. Claude
 * Code's is listed even when it is absent, so the caller can say where it
 * looked; the others only when they hold something for this repository.
 */
export function readRepositoryMemory(projectRoot: string): { sources: MemorySource[]; looked: string[] } {
  const sources: MemorySource[] = []
  const claude = claudeMemoryDir(projectRoot)
  if (existsSync(claude)) sources.push(readMemoryDir(claude, 'Claude Code'))
  sources.push(...readVscode(projectRoot), ...readCodex(projectRoot))
  const looked = [claude, ...vscodeUserDirs().map((d) => join(d, 'workspaceStorage')), ...['memories', 'memories_v2'].map((d) => join(process.env.CODEX_HOME || join(home(), '.codex'), d))]
  return { sources, looked }
}

/** Memories on this machine not yet promoted, by assistant. */
export function unsharedMemory(projectRoot: string, promoted: Set<string>): Array<{ assistant: string; count: number }> {
  const counts = new Map<string, number>()
  for (const s of readRepositoryMemory(projectRoot).sources) {
    const n = s.candidates.filter((c) => !promoted.has(c.source)).length
    if (n > 0) counts.set(s.assistant, (counts.get(s.assistant) ?? 0) + n)
  }
  return [...counts].map(([assistant, count]) => ({ assistant, count }))
}
