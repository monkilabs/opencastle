import {
  readdir,
  readFile,
  mkdir,
  writeFile,
  copyFile,
  rm,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { CopyResults, CopyDirOptions } from './types.js';

/** Do two files hold the same bytes? */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readFile(a), readFile(b)]);
  return x.equals(y);
}

/**
 * Recursively copy a directory tree.
 */
/**
 * Fold one `CopyResults` into another, every field, named by the source.
 *
 * Four call sites each enumerated the three or four fields they cared about, so
 * every field added since went missing at whichever of them the caller forgot.
 * `unreadable` was dropped for anything below a directory's top level, so `sync`
 * skipped a file it could not read and said nothing; `visited` was dropped by two
 * of them, and `visited` is what the sweep consults before deleting output whose
 * source is gone — the exact mechanism that once deleted 43 skill files.
 *
 * Enumerating fields is the defect, not the particular fields chosen: the list
 * goes stale the moment one is added, and nothing fails to compile when it does.
 * This asks the object what it has. It is the same argument as `recordMerge` one
 * layer up, which exists because an adapter dropped a `MergeResult` field.
 */
export function mergeCopyResults(into: CopyResults, from: CopyResults): void {
  const target = into as unknown as Record<string, string[] | undefined>;
  for (const [key, value] of Object.entries(from)) {
    if (!Array.isArray(value)) continue;
    target[key] = [...(target[key] ?? []), ...(value as string[])];
  }
}

/**
 * Is the destination already this text?
 *
 * `false` means "no, write it"; `true` means "yes, skip". A destination we cannot
 * read answers neither, so it is recorded as unreadable and reported — the same
 * treatment a config that will not parse gets, and for the same reason: aborting
 * here leaves a part-written install and names no file.
 */
async function sameText(
  destPath: string,
  wanted: string,
  results: CopyResults,
): Promise<boolean> {
  try {
    return (await readFile(destPath, 'utf8')) === wanted;
  } catch {
    (results.unreadable ??= []).push(`${destPath}\u0000unreadable`);
    return true;
  }
}

export async function copyDir(
  src: string,
  dest: string,
  { overwrite = false, filter, transform }: CopyDirOptions = {}
): Promise<CopyResults> {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });

  const results: CopyResults = { copied: [], skipped: [], created: [] };

  for (const entry of entries) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);

    if (filter && !filter(entry.name, srcPath)) continue;

    if (entry.isDirectory()) {
      const sub = await copyDir(srcPath, destPath, {
        overwrite,
        filter,
        transform,
      });
      mergeCopyResults(results, sub);
    } else {
      const exists = existsSync(destPath);
      if (exists && !overwrite) {
        (results.visited ??= []).push(destPath);
        results.skipped.push(destPath);
        continue;
      }

      if (transform) {
        const content = await readFile(srcPath, 'utf8');
        const transformed = await transform(content, srcPath);
        // A transform returning null means "do not install this file", so the
        // destination is *not* visited — recording it before this point would
        // have told the sweep to spare a stale copy of a file the compiler had
        // just decided not to produce.
        if (transformed === null) continue;
        (results.visited ??= []).push(destPath);
        // An overwrite that changes nothing is not an update. Callers total
        // `copied` into "Updated N framework files", and counting every file
        // visited made a sync that rewrote nothing indistinguishable from one
        // that rewrote everything.
        // Named and skipped rather than fatal. This read only answers "is it
        // already what we would write?", but a directory wearing a generated
        // file's name made it throw `EISDIR` — which Node raises on the
        // descriptor, so it carries no `.path` for the catch-all in
        // `bin/cli.mjs` to print. `sync` died mid-install with
        // `✗ EISDIR: illegal operation on a directory, read` and nothing to act
        // on, while `sync --check`, reading the same tree, named the path.
        if (exists && (await sameText(destPath, transformed, results))) {
          results.skipped.push(destPath);
          continue;
        }
        await writeFile(destPath, transformed);
        results[exists ? 'copied' : 'created'].push(destPath);
      } else {
        (results.visited ??= []).push(destPath);
        // The twin of the guard above: `sameFile` reads both sides.
        if (exists) {
          let same: boolean;
          try {
            same = await sameFile(srcPath, destPath);
          } catch {
            (results.unreadable ??= []).push(`${destPath}\u0000unreadable`);
            results.skipped.push(destPath);
            continue;
          }
          if (same) {
            results.skipped.push(destPath);
            continue;
          }
        }
        await copyFile(srcPath, destPath);
        results[exists ? 'copied' : 'created'].push(destPath);
      }
    }
  }

  return results;
}

/**
 * Resolve the orchestrator source directory from the CLI package root.
 */
export function getOrchestratorRoot(pkgRoot: string): string {
  return resolve(pkgRoot, 'src', 'orchestrator');
}

/**
 * Remove a directory if it exists. No-op if it doesn't.
 */
export async function removeDirIfExists(dirPath: string): Promise<void> {
  if (existsSync(dirPath)) {
    await rm(dirPath, { recursive: true });
  }
}

/**
 * Resolve the plugins source directory from the CLI package root.
 */
export function getPluginsRoot(pkgRoot: string): string {
  return resolve(pkgRoot, 'src', 'orchestrator', 'plugins');
}

/**
 * Scan plugin directories for SKILL.md files.
 * Returns entries with plugin ID and skill file path.
 */
export async function getPluginSkillEntries(
  pluginsRoot: string,
  includedPluginIds?: Set<string>
): Promise<Array<{ id: string; skillPath: string }>> {
  if (!existsSync(pluginsRoot)) return [];

  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const results: Array<{ id: string; skillPath: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (includedPluginIds && !includedPluginIds.has(entry.name)) continue;
    const skillPath = resolve(pluginsRoot, entry.name, 'SKILL.md');
    if (existsSync(skillPath)) {
      results.push({ id: entry.name, skillPath });
    }
  }

  return results;
}
