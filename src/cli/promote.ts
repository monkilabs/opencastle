import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { checkSkill } from './agent-plugin.js'
import { LESSONS_DIR, newLessonId, readLessons, renderLesson, syncLessons, today, type Lesson } from './lessons.js'
import { readMemoryDir, readRepositoryMemory, type MemorySource } from './memory-sources.js'
import { scanForSecrets } from './secret-scan.js'
import { getOrchestratorRoot } from './copy.js'
import { c } from './prompt.js'
import type { CliContext } from './types.js'

/**
 * `opencastle promote`: what one person's assistant learned, made the team's.
 *
 * Knowledge starts personal. A developer writes a skill for their own
 * assistant, or the assistant remembers a correction it was given — Claude
 * Code, VS Code and Codex keep those on one machine, in one person's home
 * directory, and no teammate's agent ever sees them (memory-sources.ts). Productboard's Spark
 * draws the same line between personal and workspace skills, and makes the
 * step between them an explicit promotion after the author has tried it.
 *
 * This is that step. A skill is checked against the Agent Skills spec and
 * scanned for credentials, then copied into the team's sources — this
 * repository's `.opencastle/`, or a baseline every repository extends — where
 * the next sync compiles it into every assistant. A memory becomes a lesson
 * file. Either way it lands as a change in the working tree, and the pull
 * request that commits it is where the team says yes.
 */

const HELP = `
  npx opencastle promote <skill|memory> [name|path] [options]

  Make what one person's assistant learned the team's: copy it into the
  team's sources, where the next sync compiles it into every assistant.

  skill <name|path>   A skill you use yourself, found by name in your personal
                      skill directories (~/.claude/skills, ~/.agents/skills,
                      ~/.codex/skills, ~/.cursor/skills, ~/.copilot/skills) or
                      given as a path. It is checked against the Agent Skills
                      spec and for credentials, then copied to
                      .opencastle/skills/<name>/ — or with --to, into a
                      baseline or Agent Plugin every repository extends.
  memory              What your assistant remembered about this repository,
                      written as lessons in .opencastle/lessons/: Claude
                      Code's auto memory (corrections and project notes),
                      VS Code's repository memory (Copilot Chat), and the
                      Codex memories whose directory is this repository.
                      Memories about you, credentials, and ones already
                      promoted are left out; your home directory is written
                      as ~. Cursor keeps its memories on its servers and
                      Copilot Memory lives on GitHub; neither can be read.

  Options:
    --to <dir>      skill: a baseline or Agent Plugin directory to put it in
    --from <dir>    memory: read memory files from this directory instead
    --force         skill: replace a team skill with the same name
    --dry-run       Say what would be written, and write nothing
    --help, -h      Show this help
`

function fail(message: string): never {
  console.error(`  ${c.red('✗')} ${message}`)
  process.exit(1)
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const v = args[at + 1]
  if (!v || v.startsWith('--')) fail(`${name} needs a value`)
  return v
}

function home(): string {
  return process.env.HOME || homedir()
}

function tilde(path: string): string {
  const h = home()
  return path === h ? '~' : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

function projectRootFrom(cwd: string): string {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.opencastle'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

/** Every file under a directory, relative to it. */
function filesIn(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`)
      else if (e.isFile()) out.push(`${prefix}${e.name}`)
    }
  }
  walk(dir, '')
  return out
}

// ── skill ─────────────────────────────────────────────────────

/**
 * Where assistants keep a person's own skills.
 *
 * Claude Code's and Codex's under their config homes when those are moved:
 * `promote memory` read `CLAUDE_CONFIG_DIR` and this did not, so one person's
 * memories and skills were looked for in two different places.
 */
export function personalSkillDirs(): string[] {
  const h = home()
  const claude = process.env.CLAUDE_CONFIG_DIR || join(h, '.claude')
  const codex = process.env.CODEX_HOME || join(h, '.codex')
  return [
    join(claude, 'skills'),
    join(h, '.agents', 'skills'),
    join(codex, 'skills'),
    join(h, '.cursor', 'skills'),
    join(h, '.copilot', 'skills'),
  ]
}

function findSkill(ref: string, cwd: string): string {
  const asPath = resolve(cwd, ref.replace(/^~(?=\/|$)/, home()))
  if (ref.includes('/') || ref.startsWith('.')) {
    if (existsSync(join(asPath, 'SKILL.md'))) return asPath
    fail(`${ref} is not a skill directory — it has no SKILL.md`)
  }
  const found = personalSkillDirs().map((d) => join(d, ref)).filter((d) => existsSync(join(d, 'SKILL.md')))
  if (found.length === 0) {
    fail(`no skill named ${ref} in ${personalSkillDirs().map(tilde).join(', ')} — give its path instead`)
  }
  if (found.length > 1) {
    const differ = new Set(found.map((d) => createHash('sha256').update(readFileSync(join(d, 'SKILL.md'))).digest('hex'))).size > 1
    if (differ) fail(`${ref} is in ${found.map(tilde).join(' and ')}, and they differ — give the path of the one to promote`)
  }
  return found[0]
}

/** The `skills/` directory of a baseline or Agent Plugin. */
function skillsDirOf(target: string): string {
  const pkgFile = join(target, 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const baseline = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { opencastle?: { baseline?: unknown } }).opencastle?.baseline
      if (typeof baseline === 'string') return join(resolve(target, baseline), 'skills')
    } catch {
      // Not ours to judge here; the copy below names the directory it used.
    }
  }
  if (existsSync(join(target, 'plugin.json')) || existsSync(join(target, 'config.json'))) return join(target, 'skills')
  fail(`${target} is neither a baseline nor an Agent Plugin — it has no package.json declaring a baseline, no plugin.json and no config.json`)
}

function promoteSkill(pkgRoot: string, args: string[], dryRun: boolean): void {
  const ref = args.find((a, i) => !a.startsWith('--') && !['--to', '--from'].includes(args[i - 1]))
  if (!ref) fail('promote skill needs the skill — its name, or the path to its directory')
  const cwd = process.cwd()
  const source = findSkill(ref, cwd)
  const name = basename(source)

  const skill = checkSkill(source)
  if (skill.errors.length > 0) {
    for (const e of skill.errors) console.error(`  ${c.red('✗')} ${e.replace(/^skills\//, `${tilde(dirname(source))}/`)}`)
    fail('fix it where it is, then promote it — every assistant that follows the Agent Skills spec would skip it as it stands')
  }
  for (const w of skill.warnings) console.log(`  ${c.yellow('!')} ${c.dim(w)}`)

  for (const rel of filesIn(source)) {
    let text: string
    try {
      text = readFileSync(join(source, rel), 'utf8')
    } catch {
      continue
    }
    const scan = scanForSecrets(text, rel)
    if (!scan.clean) {
      const f = scan.findings[0]
      fail(`${name}/${rel} line ${f.line} holds what looks like a ${f.pattern} — the team's sources are committed, so take it out first`)
    }
  }

  const to = flag(args, '--to')
  const projectRoot = projectRootFrom(cwd)
  const destSkills = to ? skillsDirOf(resolve(cwd, to)) : join(projectRoot, '.opencastle', 'skills')
  if (!to && !existsSync(join(projectRoot, '.opencastle'))) fail('no .opencastle/ here — run npx opencastle init first, or promote it into a baseline with --to <dir>')
  const dest = join(destSkills, name)
  const shown = relative(cwd, dest) || '.'
  if (existsSync(dest) && !args.includes('--force')) {
    fail(`${shown} already exists — compare them, then pass --force to replace it`)
  }
  const core = existsSync(join(getOrchestratorRoot(pkgRoot), 'skills', name))

  if (dryRun) {
    console.log(`  [dry-run] Would copy ${tilde(source)} to ${shown}/ (${filesIn(source).length} file(s))`)
    return
  }
  mkdirSync(destSkills, { recursive: true })
  cpSync(source, dest, { recursive: true, force: true })
  console.log(`\n  ${c.green('✓')} Promoted ${c.bold(name)} from ${tilde(source)} to ${shown}/`)
  if (core) console.log(`  ${c.yellow('!')} OpenCastle ships a skill of that name; this one replaces it for everyone it reaches`)
  console.log(
    to
      ? `  ${c.dim('Next:')} ${c.cyan(`npx opencastle baseline check ${relative(cwd, resolve(cwd, to)) || '.'}`)}${c.dim(', then publish a new version.')}\n`
      : `  ${c.dim('Next:')} ${c.cyan('npx opencastle sync')} ${c.dim('compiles it into every assistant; commit it, and the pull request is where the team agrees.')}\n`,
  )
}

// ── memory ────────────────────────────────────────────────────

export { claudeMemoryDir } from './memory-sources.js'

function promoteMemory(args: string[], dryRun: boolean): void {
  const projectRoot = projectRootFrom(process.cwd())
  const customizations = join(projectRoot, '.opencastle')
  if (!existsSync(customizations)) fail('no .opencastle/ here — run npx opencastle init first')
  const from = flag(args, '--from')
  let sources: MemorySource[]
  if (from) {
    const dir = resolve(process.cwd(), from.replace(/^~(?=\/|$)/, home()))
    if (!existsSync(dir)) fail(`no memory at ${tilde(dir)}`)
    sources = [readMemoryDir(dir, 'Memory')]
  } else {
    const found = readRepositoryMemory(projectRoot)
    sources = found.sources
    if (sources.length === 0) {
      fail(
        `no memory at ${tilde(found.looked[0])}, in VS Code's storage for this folder, or in ${tilde(dirname(found.looked[found.looked.length - 1]))}/memories — ` +
          'each assistant writes it once it has saved one for this repository; --from <dir> reads another. ' +
          'Cursor keeps its memories on its servers and Copilot Memory lives on GitHub, so neither can be read here.',
      )
    }
  }

  syncLessons(customizations)
  const { lessons } = readLessons(customizations)
  const promoted = new Set(lessons.map((l) => l.source).filter((s): s is string => Boolean(s)))
  const taken = new Set(lessons.map((l) => l.id))
  const written: string[] = []

  console.log(`\n  🏰 ${c.bold('Promote memory')}`)
  for (const source of sources) {
    const wrote: string[] = []
    const skipped = [...source.skipped]
    for (const memory of source.candidates) {
      if (promoted.has(memory.source)) {
        skipped.push([memory.label, 'already a lesson'])
        continue
      }
      promoted.add(memory.source)
      const id = newLessonId(memory.title, today(), taken)
      taken.add(id)
      const lesson: Omit<Lesson, 'file'> = {
        id,
        title: memory.title,
        category: 'general',
        severity: 'medium',
        added: today(),
        citations: [],
        status: 'active',
        source: memory.source,
        body: memory.body,
      }
      wrote.push(`${LESSONS_DIR}/${id}.md`)
      if (!dryRun) {
        mkdirSync(join(customizations, LESSONS_DIR), { recursive: true })
        writeFileSync(join(customizations, LESSONS_DIR, `${id}.md`), renderLesson(lesson))
      }
    }
    written.push(...wrote)
    console.log(`\n  ${c.bold(source.assistant)} ${c.dim(`from ${tilde(source.where)}`)}`)
    for (const w of wrote) console.log(`  ${c.green(dryRun ? '+' : '✓')} ${dryRun ? 'Would write' : 'Wrote'} .opencastle/${w}`)
    for (const [file, why] of skipped) console.log(`  ${c.dim(`- ${file}: ${why}`)}`)
  }
  if (!dryRun && written.length > 0) syncLessons(customizations)

  if (written.length === 0) console.log(`\n  ${c.dim('Nothing new to promote.')}\n`)
  else if (!dryRun) {
    console.log(
      `\n  ${c.dim('Each is category general, severity medium: set them, add --cite where a lesson is about code,')}` +
        `\n  ${c.dim('and delete any that are yours alone. The pull request that commits them is where the team agrees.')}\n`,
    )
  } else {
    console.log('')
  }
}

export default async function promote({ pkgRoot, args }: CliContext): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || args.includes('--help') || args.includes('-h') || !['skill', 'memory'].includes(sub)) {
    console.log(HELP)
    if (sub && !['skill', 'memory', '--help', '-h'].includes(sub)) process.exit(1)
    return
  }
  const dryRun = rest.includes('--dry-run')
  if (sub === 'skill') promoteSkill(pkgRoot, rest, dryRun)
  else promoteMemory(rest, dryRun)
}

