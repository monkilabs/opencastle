import { IDE_ADAPTERS } from './adapters/index.js'
import type { ManagedPaths, Manifest } from './types.js'

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
      ...(stored?.framework ?? []),
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
