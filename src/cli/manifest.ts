import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
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
    if (!existsSync(path)) continue;

    const content = await readFile(path, 'utf8');
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
