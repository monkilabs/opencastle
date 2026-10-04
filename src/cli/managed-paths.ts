import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { IDE_ADAPTERS } from './adapters/index.js'
import type { IdeAdapter, ManagedPaths, Manifest } from './types.js'
import { CLAUDE_COMMANDS_DIR } from './command-namespace.js'

/**
 * What the manifest *should* say, given what the adapters declare today.
 *
 * `managedPaths` is a record written at install time, and the destructive
 * commands act on it: `framework` means "wholly generated, safe to unlink".
 * Trusting a record written by an older release is how the co-owned root file
 * kept getting deleted — every release up to 0.35.2 put `CLAUDE.md` in
 * `framework` and wrote no `merged` key at all, so the strip-the-block fix
 * iterated an empty array while the unlink still fired. The orphaned-install
 * path in `init` already recomputed from the adapters and was the only one of
 * the three that behaved; this makes that the rule rather than the exception.
 *
 * Stored paths are kept, not discarded — a target the user has since dropped
 * still has files on disk that removal should clean up. They are re-sorted into
 * the category today's compiler would give them.
 */

/**
 * Root instruction files, whichever adapter wrote them.
 *
 * A stored path that names one of these is co-owned even when no installed
 * adapter claims it, which is what happens after switching assistants. The list
 * is asserted against the adapters in boundary.test.ts, so it cannot drift.
 */
export const ROOT_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
] as const

/**
 * Framework paths a release recorded that today's compiler has narrowed.
 *
 * Before the `oc:` namespace the whole of `.claude/commands/` was generated, and manifests
 * recorded it. Commands now live under `.claude/commands/oc/`, and the rest of
 * the directory is the user's — so a stored `.claude/commands/` must not stay
 * in `framework`, where `remove` and a dropped target's cleanup would delete
 * every command a person wrote there. What those releases left at the top is
 * found by its banner instead (`getLegacyOutputs`).
 */
const SUPERSEDED_FRAMEWORK: Record<string, string> = {
  '.claude/commands/': `.claude/${CLAUDE_COMMANDS_DIR}/`,
  // Codex never read `.codex/skills/`; its skills moved to the shared location,
  // and OpenCode's followed.
  '.codex/skills/': '.agents/skills/',
  '.opencode/skills/': '.agents/skills/',
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Every path the adapters for `ides` declare, by category. */
export async function declaredManagedPaths(ides: string[]): Promise<ManagedPaths> {
  const declared: Required<ManagedPaths> = { framework: [], customizable: [], merged: [] }
  for (const ide of ides) {
    const load = IDE_ADAPTERS[ide]
    if (!load) continue
    const managed = (await load()).getManagedPaths()
    declared.framework.push(...managed.framework)
    declared.customizable.push(...managed.customizable)
    declared.merged.push(...(managed.merged ?? []))
  }
  return {
    framework: unique(declared.framework),
    customizable: unique(declared.customizable),
    merged: unique(declared.merged),
  }
}

/**
 * The manifest's paths, re-sorted by what the adapters say today.
 *
 * A path is `merged` if any installed adapter calls it merged, or if it is a
 * known root instruction file. Everything else keeps its stored category.
 */
export async function resolveManagedPaths(manifest: Manifest): Promise<Required<ManagedPaths>> {
  const ides = manifest.ides?.length ? manifest.ides : [manifest.ide]
  const declared = await declaredManagedPaths(ides.filter((id): id is string => Boolean(id)))

  const stored = manifest.managedPaths
  const mergedNames = new Set<string>([
    ...(declared.merged ?? []),
    ...ROOT_INSTRUCTION_FILES,
  ])

  const isMerged = (p: string): boolean => mergedNames.has(p)

  return {
    framework: unique([
      ...(stored?.framework ?? []).map((p) => SUPERSEDED_FRAMEWORK[p] ?? p),
      ...declared.framework,
    ]).filter((p) => !isMerged(p)),
    customizable: unique([
      ...(stored?.customizable ?? []),
      ...declared.customizable,
    ]).filter((p) => !isMerged(p)),
    merged: unique([
      ...(stored?.merged ?? []),
      ...(declared.merged ?? []),
      // A root file the old manifest filed under framework or customizable.
      ...(stored?.framework ?? []).filter(isMerged),
      ...(stored?.customizable ?? []).filter(isMerged),
    ]),
  }
}

/**
 * Which files in a framework directory the given targets wrote, when one of
 * them shares that directory with the user — `undefined` when the directory is
 * wholly generated and can be removed whole.
 */
export function ownerOf(
  adapters: IdeAdapter[],
  dir: string,
  projectRoot: string,
): ((_rel: string) => boolean) | undefined {
  const sharing = adapters.filter((a) => a.ownsFile && a.getSharedDirs?.().includes(dir))
  if (sharing.length === 0) return undefined
  return (rel) => sharing.every((a) => a.ownsFile!(rel, projectRoot))
}

/**
 * Delete the files at the top of a shared directory that `owns` claims, and the
 * directory itself if that empties it — never anything of the user's.
 *
 * Only the top level: the one shared directory, `.github/prompts/`, is read
 * there and nowhere deeper, so nothing below it is ours, and walking into a
 * person's subfolders could only delete their empty ones or stop at one it
 * cannot read. A path that is not a readable directory is left for a person.
 * Returns how many files went.
 */
export function removeOwnedFiles(projectRoot: string, dir: string, owns: (_rel: string) => boolean): number {
  const root = resolve(projectRoot, dir)
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  let entries
  try {
    if (!statSync(root).isDirectory()) return 0
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (entry.isDirectory() || !owns(`${prefix}${entry.name}`)) continue
    try {
      // `rmSync` rather than `unlinkSync`: on Windows it gets past a read-only
      // file, which `unlink` fails on with EPERM.
      rmSync(resolve(root, entry.name), { force: true })
      removed++
    } catch {
      // Left for a person; one stubborn file must not stop the uninstall.
    }
  }
  try {
    if (readdirSync(root).length === 0) rmdirSync(root)
  } catch {
    // As above.
  }
  return removed
}

/**
 * Files an install is not complete without.
 *
 * `sync` restores them, `doctor` fails without them, and `status` must not call
 * an install "current" while they are missing — three commands that each used to
 * decide this for themselves, which is how the front door came to report health
 * on a project `doctor` was failing.
 */
export const REQUIRED_CUSTOMIZATIONS = [
  'agents/skill-matrix.json',
  'agents/agent-registry.md',
] as const

/** Which required files this project is missing, relative to `.opencastle/`. */
export function missingRequiredCustomizations(projectRoot: string): string[] {
  return REQUIRED_CUSTOMIZATIONS.filter(
    (rel) => !existsSync(resolve(projectRoot, '.opencastle', ...rel.split('/'))),
  )
}
