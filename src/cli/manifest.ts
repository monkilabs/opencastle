import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { Manifest } from './types.js';
import { UnreadableConfigError } from './types.js';

const MANIFEST_FILE = '.opencastle/manifest.json';

/**
 * Read the project's OpenCastle manifest, or null if not installed.
 * Tries the new location (.opencastle/manifest.json) first, then falls back
 * to the legacy location (.opencastle.json) for backward compatibility.
 */
export async function readManifest(
  projectRoot: string
): Promise<Manifest | null> {
  for (const rel of [MANIFEST_FILE, '.opencastle.json']) {
    const path = resolve(projectRoot, rel);
    if (!existsSync(path)) {
      // `existsSync` is false for a file we cannot look for as well as for one
      // that is not there, and the two are not the same fact. With
      // `.opencastle/` unreadable, this read said "absent", so `doctor` reported
      // "Not found. Run init" about a manifest sitting right there, the front
      // door said "not set up in this project" over eighty installed files, and
      // both prescribed the `init` that exits 1 on the same directory. Nothing
      // could clear it, and every sentence about it was false.
      //
      // Only the directory is consulted, never the file: asking about the file
      // is what cannot distinguish the two cases.
      const holder = dirname(path);
      if (existsSync(holder)) {
        try {
          readdirSync(holder);
        } catch {
          throw new UnreadableConfigError(`${relative(projectRoot, holder)}/`, 'unreadable');
        }
      }
      continue;
    }

    // Read inside the guard too. A directory wearing the manifest's name took
    // every command down with a bare `✗ EISDIR`, naming nothing, before
    // `doctor` printed a single check — the same shape hardened twice already
    // in the checks this file feeds.
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      // `'unreadable'`, not the default `'unparseable'`. A failed *read* is not a
      // parse failure, and reporting it as one told a user whose `manifest.json`
      // was a directory to "fix the JSON by hand". The reason field exists to
      // carry this distinction; throwing without it discarded the one fact the
      // caller needed.
      throw new UnreadableConfigError(rel, 'unreadable');
    }
    try {
      return JSON.parse(content) as Manifest;
    } catch {
      // Present but unreadable is not the same as absent, and reporting it as
      // absent was actively harmful: every command said "not set up in this
      // project" and `doctor` prescribed `init`, which then ran bootstrap over
      // the populated `.opencastle/` and overwrote the user's own notes. The
      // manifest is committed and its `updatedAt` changes on every sync, so a
      // merge conflict here is the likely cause — say so.
      throw new UnreadableConfigError(rel);
    }
  }
  return null;
}

/**
 * Write the manifest to .opencastle/manifest.json.
 * Creates the .opencastle/ directory if it doesn't exist.
 */
export async function writeManifest(
  projectRoot: string,
  manifest: Manifest
): Promise<void> {
  const path = resolve(projectRoot, MANIFEST_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Create a fresh manifest object.
 */
export function createManifest(version: string, ide: string, ides?: string[]): Manifest {
  return {
    version,
    ide,
    ides: ides ?? [ide],
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
