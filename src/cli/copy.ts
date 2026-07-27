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
      results.copied.push(...sub.copied);
      results.skipped.push(...sub.skipped);
      results.created.push(...sub.created);
      if (sub.visited) (results.visited ??= []).push(...sub.visited);
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
        if (exists && (await readFile(destPath, 'utf8')) === transformed) {
          results.skipped.push(destPath);
          continue;
        }
        await writeFile(destPath, transformed);
        results[exists ? 'copied' : 'created'].push(destPath);
      } else {
        (results.visited ??= []).push(destPath);
        if (exists && (await sameFile(srcPath, destPath))) {
          results.skipped.push(destPath);
          continue;
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
