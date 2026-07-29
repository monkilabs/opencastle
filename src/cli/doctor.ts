import { resolve } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readManifest } from './manifest.js';
import { getRequiredMcpEnvVars, resolveStack, isEnvVarSatisfied } from './stack-config.js';
import { IDE_ADAPTERS, VALID_IDES } from './adapters/index.js';
import { resolveManagedPaths, ROOT_INSTRUCTION_FILES } from './managed-paths.js';
import {
  carriesLegacyBody,
  stripManagedBlock,
  countManagedBlocks,
  diagnoseManagedFile,
  BLOCK_START,
  BLOCK_END,
  type FileDiagnosis,
} from './managed-block.js';
import {
  START_MARKER as GITIGNORE_START,
  END_MARKER as GITIGNORE_END,
  hasOurRules,
} from './gitignore.js';
import { UnreadableConfigError } from './types.js';
import type { CliContext, DoctorCheck, IdeChoice, Manifest } from './types.js';
import { IDE_LABELS } from './types.js';

// ── Styled output helpers ─────────────────────────────────────

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
  warning?: boolean;
  /**
   * What actually clears this failure.
   *
   * The summary used to print one blanket "Run opencastle sync to fix" under
   * every failure, including two that `sync` cannot touch: an env var it has no
   * way to set, and a `.gitignore` rule outside the block it rewrites. A
   * diagnosis that prescribes something incapable of fixing it is worse than no
   * diagnosis, because the user runs it and learns nothing.
   */
  fix?: string;
}

// ── Individual checks ─────────────────────────────────────────

/**
 * Is our `.gitignore` block present and current?
 *
 * The whole of what there is to ask. Our block there is a constant, so any
 * difference — missing file, missing block, edited block, a second block, a
 * stray marker — is fixed by rebuilding it, which one `sync` does. There is no
 * state here that needs a person, which is why this file no longer appears in
 * the torn/severed/unreducible diagnosis at all.
 */
async function checkGitignoreBlock(projectRoot: string): Promise<CheckResult> {
  const label = 'Local artefacts are ignored';
  const path = resolve(projectRoot, '.gitignore');

  // Only inside a git repository: ignore rules mean nothing outside one, and
  // `.gitignore` is written by the commands rather than by the adapters, so a
  // tree compiled by an adapter alone has never had one.
  if (!existsSync(resolve(projectRoot, '.git'))) return { label, ok: true, warning: false };

  if (!existsSync(path)) {
    return {
      label,
      ok: false,
      detail: '.gitignore is missing — .env and the run artefacts are not ignored',
      fix: 'opencastle sync',
    };
  }

  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    return {
      label,
      ok: false,
      detail: `.gitignore cannot be read — ${(err as Error).message}`,
      fix: 'fix the permissions or replace the file; this one needs a person',
    };
  }

  const { gitignoreNeedsRebuild } = await import('./gitignore.js');
  const why = gitignoreNeedsRebuild(content);
  if (why) return { label, ok: false, detail: why, fix: 'opencastle sync' };
  return { label, ok: true, warning: false };
}

function checkManifest(manifest: Manifest | null): CheckResult {
  if (!manifest) {
    // The remedy has to be set here. Without it the summary falls back to a
    // blanket "run sync", and `sync` on a project with no manifest exits 1
    // saying to run `init` — reachable from `remove --keep-files`, which is a
    // documented command, and from deleting `.opencastle/`.
    return {
      ok: false,
      label: 'OpenCastle manifest (.opencastle/manifest.json)',
      detail: 'Not found. Run "npx opencastle init" first.',
      fix: 'opencastle init',
    };
  }
  // A manifest that parses but names no recognised target is not a healthy
  // install: `sync` exits 1 on it while this printed "vundefined, IDE: undefined"
  // and passed.
  const named = manifest.ides?.length ? manifest.ides : manifest.ide ? [manifest.ide] : [];
  const known = named.filter((id) => id && VALID_IDES.includes(id));
  if (known.length === 0) {
    return {
      ok: false,
      label: 'OpenCastle manifest (.opencastle/manifest.json)',
      detail: `names no target this release recognises (valid: ${VALID_IDES.join(', ')})`,
      fix: 'fix the "ides" field, or re-run opencastle init; this one needs a person',
    };
  }
  return { ok: true, label: 'OpenCastle manifest (.opencastle/manifest.json)', detail: `v${manifest.version}, IDE: ${known.join(', ')}` };
}

async function checkCustomizations(projectRoot: string): Promise<CheckResult> {
  const dir = resolve(projectRoot, '.opencastle');
  if (!existsSync(dir)) {
    return { ok: false, label: 'Customizations directory', detail: '.opencastle/ not found' };
  }
  const files = await readdir(dir).catch(() => []);
  return { ok: true, label: 'Customizations directory', detail: `${files.length} entries` };
}

async function checkSkillMatrix(projectRoot: string): Promise<CheckResult> {
  const path = resolve(projectRoot, '.opencastle', 'agents', 'skill-matrix.json');
  if (!existsSync(path)) {
    return { ok: false, label: 'Skill matrix', detail: 'File not found at .opencastle/agents/skill-matrix.json' };
  }
  const { readFile } = await import('node:fs/promises');
  // The read is guarded as well as the parse. `doctor` is the command people
  // run *because* something is wrong, and an unreadable skill matrix — a
  // directory where the file should be, a permissions mistake — took it down
  // with a bare `✗ EISDIR: illegal operation on a directory, read`: the
  // diagnostic dying without naming what it could not read.
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      label: 'Skill matrix',
      detail: `Cannot read .opencastle/agents/skill-matrix.json — ${(err as Error).message}`,
      fix: 'fix or delete the file, then run opencastle sync; this one needs a person',
    };
  }
  try {
    const data = JSON.parse(content);
    const bindings = data.bindings ?? {};
    const emptySlots = Object.entries(bindings).filter(
      ([, slot]) => !Array.isArray((slot as { entries?: unknown[] }).entries) || ((slot as { entries: unknown[] }).entries).length === 0
    );
    if (emptySlots.length > 0) {
      return { ok: true, label: 'Skill matrix', detail: `${emptySlots.length} unresolved capability slot(s)`, warning: true };
    }
    return { ok: true, label: 'Skill matrix', detail: 'All capability slots populated' };
  } catch {
    return {
      ok: false,
      label: 'Skill matrix',
      detail: 'Invalid JSON in skill-matrix.json',
      // Not `sync`: it cannot parse the file either, so it would report success
      // and leave this failing. A merge conflict needs a person.
      fix: 'fix the JSON by hand — a merge conflict, most likely — then run "npx opencastle sync"',
    };
  }
}

async function checkLogs(projectRoot: string): Promise<CheckResult> {
  const dir = resolve(projectRoot, '.opencastle', 'logs');
  if (!existsSync(dir)) {
    // A local run artefact, not part of the project, so a fresh clone has none —
    // and calling that a failure made `doctor` exit 1 on every clone. `sync`
    // creates it; until then "no runs yet" is the honest reading, not a fault.
    return {
      ok: true,
      warning: true,
      label: 'Observability logs',
      detail: 'no logs yet — created on the next sync',
    };
  }
  // A diagnostic does not write. This used to create five empty `.ndjson` files
  // as a side effect — files nothing on this branch reads, and exactly the ones
  // `migrateLegacyLogs` exists to move aside.
  const entries = existsSync(dir) ? await readdir(dir) : [];
  const events = entries.filter((f) => f.endsWith('.ndjson'));
  return {
    ok: true,
    label: 'Observability logs',
    detail: events.length > 0 ? `${events.length} log file(s)` : 'no runs recorded yet',
  };
}

async function checkMcpEnvVars(
  projectRoot: string,
  manifest: Manifest | null,
): Promise<CheckResult> {
  if (!manifest?.stack) {
    return { ok: true, label: 'MCP environment variables', detail: 'No stack config (skipped)' };
  }
  // Through the resolver: a v1 manifest stores `{ cms, db }` with no
  // `techTools`, and handing that straight on threw "stack.techTools is not
  // iterable" — a crash where a diagnosis was the whole point of the command.
  const required = getRequiredMcpEnvVars(resolveStack(manifest), manifest.repoInfo);
  if (required.length === 0) {
    return { ok: true, label: 'MCP environment variables', detail: 'No env vars required' };
  }
  const envFile = await readFile(resolve(projectRoot, '.env'), 'utf8').catch(() => '');
  const missing = required.filter((r) => !isEnvVarSatisfied(r.envVar, envFile));
  if (missing.length > 0) {
    const names = missing.map((m) => m.envVar).join(', ');
    return {
      ok: true,
      warning: true,
      label: 'MCP environment variables',
      detail: `Not set: ${names}`,
      fix: 'add them to .env or your shell',
    };
  }
  return { ok: true, label: 'MCP environment variables', detail: `${required.length} var(s) set` };
}

async function checkDotEnv(projectRoot: string, manifest: Manifest | null): Promise<CheckResult> {
  const envPath = resolve(projectRoot, '.env');
  if (!existsSync(envPath)) {
    if (manifest?.stack) {
      const required = getRequiredMcpEnvVars(resolveStack(manifest), manifest.repoInfo);
      if (required.length > 0) {
        return { ok: true, label: '.env file', detail: 'Not found — consider creating one for MCP secrets', warning: true };
      }
    }
    return { ok: true, label: '.env file', detail: 'Not found (not required)' };
  }
  return { ok: true, label: '.env file', detail: 'Present' };
}

// ── Generic adapter-driven checks ────────────────────────────────

/** Run a single DoctorCheck against the filesystem. */
export async function runDoctorCheck(projectRoot: string, check: DoctorCheck): Promise<CheckResult> {
  const fullPath = resolve(projectRoot, check.path);

  if (check.type === 'file') {
    if (!existsSync(fullPath)) {
      return { ok: false, label: check.label, detail: `${check.path} not found` };
    }
    return { ok: true, label: check.label };
  }

  // type === 'dir'
  if (!existsSync(fullPath)) {
    return { ok: false, label: check.label, detail: `${check.path} not found` };
  }

  // Something is there but it is not a directory we can read — a plain file
  // where the tree belongs, or one we lack permission for. `sync` cannot repair
  // either: it exits non-zero on the same path, so the blanket "run sync"
  // remedy sent the user round a loop that never converged, with `doctor`
  // repeating the advice each time.
  let contents: string[];
  try {
    contents = await readdir(fullPath);
  } catch (err) {
    return {
      ok: false,
      label: check.label,
      detail: `${check.path} cannot be read — ${(err as Error).message}`,
      fix: `remove or fix ${check.path}, then run opencastle sync; this one needs a person`,
    };
  }

  if (check.countContents) {
    // Only entries that are supposed to *be* generated files. A framework
    // directory legitimately holds subdirectories — skills live in one folder
    // each — so "is a directory" is only wrong for something wearing a
    // generated file's name, which is what `countFilter` identifies. Without
    // the filter this flagged normal structure on every healthy project.
    if (check.countFilter) {
      for (const entry of contents.filter((e) => e.endsWith(check.countFilter!))) {
        const child = resolve(fullPath, entry);
        try {
          if (statSync(child).isDirectory()) {
            return {
              ok: false,
              label: check.label,
              detail: `${check.path}${entry} is a directory, not a generated file`,
              fix: `remove ${check.path}${entry}, then run opencastle sync; this one needs a person`,
            };
          }
          readFileSync(child);
        } catch (err) {
          return {
            ok: false,
            label: check.label,
            detail: `${check.path}${entry} cannot be read — ${(err as Error).message}`,
            fix: 'fix the permissions or replace it, then run opencastle sync; this one needs a person',
          };
        }
      }
    }
    const entries = contents;
    const filtered = check.countFilter
      ? entries.filter((e) => e.endsWith(check.countFilter!))
      : entries;
    if (filtered.length === 0) {
      return { ok: false, label: check.label, detail: `No files found in ${check.path}` };
    }
    return { ok: true, label: check.label, detail: `${filtered.length} file(s)` };
  }

  return { ok: true, label: check.label };
}

/** Check MCP config presence from the adapter's customizable paths. */
export function checkMcpFromPaths(projectRoot: string, mcpPaths: string[]): CheckResult {
  if (mcpPaths.length === 0) {
    return { ok: true, label: 'MCP configuration', detail: 'No MCP config path configured' };
  }
  // Opened and parsed, not merely stat'ed. `existsSync` is true of a config
  // nobody can read and of a directory wearing the name — both of which make
  // `sync` exit non-zero, while this check said "1 MCP config(s)" and `doctor`,
  // `status` and `sync --check` all reported health.
  for (const p of mcpPaths) {
    const abs = resolve(projectRoot, p);
    if (!existsSync(abs)) continue;
    try {
      JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      return {
        ok: false,
        label: 'MCP configuration',
        detail: `${p} cannot be read — ${(err as Error).message}`,
        fix: `fix or delete ${p}, then run opencastle sync; this one needs a person`,
      };
    }
  }

  const found = mcpPaths.filter((p) => existsSync(resolve(projectRoot, p)));
  if (found.length === 0) {
    return {
      ok: true,
      label: 'MCP configuration',
      detail: `No MCP config found (${mcpPaths.join(', ')}) — MCP tools unavailable`,
      warning: true,
    };
  }
  return { ok: true, label: 'MCP configuration', detail: `${found.length} MCP config(s)` };
}

// ── Main doctor command ───────────────────────────────────────

const DOCTOR_HELP = `
  opencastle doctor [options]

  Validate your OpenCastle setup — checks manifest, customizations, skills,
  logs, MCP configuration, and IDE-specific rules.

  Options:
    --help, -h      Show this help
`

/**
 * Is any generated file hidden from git?
 *
 * Releases before this one ignored the whole compiled output, including the root
 * instruction file the user writes in. That makes two of the tool's promises
 * false at once — a teammate's clone has no rules, and `sync --check` in CI
 * reports every file as never generated — and nothing anywhere said so. `sync`
 * rewrites the block now, but an install that has not synced yet is still in
 * that state, and this is where it becomes visible.
 */
async function checkGitignoredOutput(
  projectRoot: string,
  manifest: Manifest | null,
): Promise<CheckResult> {
  const label = 'Generated config is committed'
  if (!manifest) return { label, ok: true, warning: false };

  const managed = await resolveManagedPaths(manifest);
  const candidates = [...managed.framework, ...managed.merged].map((p) => p.replace(/\/$/, ''));
  if (candidates.length === 0) return { label, ok: true, warning: false };

  // Asked of git, not of a hand-rolled reading of `.gitignore`. The first
  // version matched trimmed lines against paths, which is a second and much
  // weaker interpreter of a format git already owns: a repository whose own
  // ignore file said `.claude/` hid every generated file while this check
  // reported everything fine — the exact shape of defect the managed-block
  // reader kept producing.
  const hidden = await gitIgnoredPaths(projectRoot, candidates);
  if (hidden === null) return { label, ok: true, warning: false }; // not a git repo
  if (hidden.length === 0) return { label, ok: true, warning: false };

  return {
    label,
    ok: false,
    warning: false,
    detail:
      `${hidden.length} generated path(s) are gitignored (${hidden[0]}${hidden.length > 1 ? ', …' : ''})` +
      ' — a teammate\'s clone would have no rules',
    // Two populations, two remedies — and the question that separates them is
    // "are *these* entries inside a block we maintain", not "does the file
    // contain such a block". The first version asked the second question, which
    // `init` makes true for every install there has ever been, so a project
    // that ignored `.claude/` before OpenCastle arrived was sent to `sync`
    // forever: sync rewrites its own block, the offending line lives below it,
    // and doctor fails again with the same advice. Asking about the offending
    // lines is the whole difference.
    fix: (await syncWouldClearThis(projectRoot, hidden))
      ? 'opencastle sync — those entries are in a block this tool maintains'
      : 'remove those entries from .gitignore; OpenCastle only ignores .env and run artefacts',
  };
}

/**
 * Are the lines doing the ignoring inside a block we maintain?
 *
 * `git check-ignore -v` names the source file and line number of the pattern
 * that matched, which is the only way to answer this without reimplementing
 * gitignore matching — and without writing. An earlier attempt removed our
 * block, re-asked git and put the file back; a diagnostic command must not edit
 * the user's `.gitignore`, least of all one that could be interrupted between
 * the two writes.
 */
async function syncWouldClearThis(projectRoot: string, hidden: string[]): Promise<boolean> {
  const path = resolve(projectRoot, '.gitignore');
  if (!existsSync(path)) return false;

  // Guarded like every other read of a user file. An unreadable `.gitignore`
  // made `sync` exit 1 while this command, `sync --check` and `status` all
  // exited 0 — the same shape as the `.mcp.json` twin fixed one round ago, one
  // file over. `checkTornBlocks` already reports the file itself; this only has
  // to avoid crashing on the way past.
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  // Being inside a block of ours is not enough — `sync` has to be willing to
  // rewrite that block. On an unreducible `.gitignore` it is not, so the
  // "run sync" remedy was a no-op that failed identically on every run, four
  // syncs in a row, while the check that *could* explain it said nothing.
  // Nothing is refused here any more. `.gitignore`'s block is rebuilt rather
  // than maintained, so `sync` always rewrites it — this bail was left over from
  // when the writer could decline, and it sent users to hand-edit entries that
  // one sync clears, while a neighbouring check in the same run said "run sync".
  const { blockRegions } = await import('./managed-block.js');
  const { START_MARKER, END_MARKER } = await import('./gitignore.js');
  const regions = blockRegions(content, START_MARKER, END_MARKER);
  if (regions.length === 0) return false;

  // 1-based line numbers, to match `git check-ignore -v`.
  const lineOf = (offset: number): number => content.slice(0, offset).split('\n').length;
  const ours = regions.map((r) => ({ from: lineOf(r.start), to: lineOf(r.end) }));

  const sources = await gitIgnoreSources(projectRoot, hidden);
  if (sources === null || sources.length === 0) return false;

  // Every hidden path must be hidden by a line of ours; one entry of the user's
  // own is enough to make `sync` the wrong advice.
  return sources.every(
    (s) => s.file === '.gitignore' && ours.some((o) => s.line >= o.from && s.line <= o.to),
  );
}

/** Which ignore file and line matched each path, per `git check-ignore -v`. */
async function gitIgnoreSources(
  projectRoot: string,
  paths: string[],
): Promise<Array<{ file: string; line: number }> | null> {
  if (!existsSync(resolve(projectRoot, '.git'))) return null;
  const { execFile } = await import('node:child_process');
  return new Promise((done) => {
    const child = execFile(
      'git',
      ['-C', projectRoot, 'check-ignore', '-v', '--no-index', '--stdin'],
      (err, stdout) => {
        if (err && (err as { code?: number }).code !== 1 && stdout === '') return done(null);
        const out: Array<{ file: string; line: number }> = [];
        for (const raw of stdout.split('\n')) {
          // "<source>:<line>:<pattern>\t<pathname>"
          const [locator] = raw.split('\t');
          if (!locator) continue;
          const parts = locator.split(':');
          if (parts.length < 3) continue;
          const line = Number(parts[1]);
          if (!Number.isFinite(line)) continue;
          out.push({ file: parts[0], line });
        }
        done(out);
      },
    );
    child.stdin?.end(paths.join('\n') + '\n');
  });
}

/**
 * Which of `paths` git ignores, or null when this is not a git repository.
 *
 * `git check-ignore` is the only implementation that agrees with git, including
 * negations, nested `.gitignore` files, and the global excludes file.
 */
async function gitIgnoredPaths(projectRoot: string, paths: string[]): Promise<string[] | null> {
  if (!existsSync(resolve(projectRoot, '.git'))) return null;
  const { execFile } = await import('node:child_process');
  return new Promise((done) => {
    const child = execFile(
      'git',
      ['-C', projectRoot, 'check-ignore', '--stdin'],
      (err, stdout) => {
        // Exit 1 simply means "none ignored"; anything else, stay quiet rather
        // than inventing a failure from a tool that did not answer.
        if (err && (err as { code?: number }).code !== 1 && stdout === '') return done(null);
        done(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      },
    );
    child.stdin?.end(paths.join('\n') + '\n');
  });
}

/**
 * A root file carrying a start marker with no end marker.
 *
 * The tool will not guess what such a marker delimits — every version that tried
 * destroyed something — so the file needs a person. Naming it here is the whole
 * remedy: `sync` cannot fix it and should not pretend to.
 */
async function checkTornBlocks(
  projectRoot: string,
  manifest: Manifest | null,
): Promise<CheckResult> {
  const label = 'Root files are intact'
  if (!manifest) return { label, ok: true, warning: false }

  const managed = await resolveManagedPaths(manifest)
  // `.gitignore` too. It is co-owned exactly as the root files are, it is the
  // one whose loss cannot be noticed by reading it, and it was the only one no
  // surface ever looked at — so a `.gitignore` the writer had declined to
  // reduce sat there while `doctor` failed on a *different* check with a remedy
  // that could not work, and nothing named the real problem.
  // Root files only. `.gitignore` used to be diagnosed with this same machinery
  // and it was the wrong machinery: these states exist because a root file's
  // block holds a large per-project body that has to be *maintained in place*,
  // so a damaged one cannot safely be rebuilt. `.gitignore`'s block is a
  // constant, so it is always rebuilt and never diagnosed — see
  // `checkGitignoreBlock`, which asks the only question that matters there.
  type Reader = [string, string, (text: string) => boolean]
  const files: Array<{ rel: string; markers: Reader }> = managed.merged.map((rel) => ({
    rel,
    markers: [BLOCK_START, BLOCK_END, carriesLegacyBody] as Reader,
  }))

  const found: Array<{ rel: string; diagnosis: FileDiagnosis }> = []
  for (const { rel, markers } of files) {
    const abs = resolve(projectRoot, rel)
    if (!existsSync(abs)) continue
    // Guarded, like `checkSkillMatrix` twelve lines up. `doctor` is what people
    // run *because* something is wrong, and an unreadable root file made it die
    // with a bare `✗ EACCES` before printing a single check — one reader
    // hardened, its neighbour not.
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch (err) {
      found.push({
        rel,
        diagnosis: {
          state: 'unreadable',
          fixable: false,
          detail: `cannot be read — ${(err as Error).message}`,
          fix: 'fix the permissions or replace the file; this one needs a person',
        },
      })
      continue
    }
    const diagnosis = diagnoseManagedFile(content, markers[0], markers[1], markers[2])
    if (diagnosis.state !== 'clean') found.push({ rel, diagnosis })
    // A whole instruction set from an older release, sitting outside our block.
    // Nothing checked for this: the writer warned about it once while
    // appending and never again, so an upgraded file carrying two complete sets
    // of instructions — the assistant reads both — was reported healthy by
    // every command from the second sync onwards.
    // Only when our block is actually there. With no recognised block — markers
    // indented off column 0, say — the whole file is the adopt case and one
    // `sync` replaces it, so calling that "needs a person" was wrong twice
    // over: it named the current release's own body as an older release's.
    else if (
      diagnoseManagedFile(content, markers[0], markers[1], markers[2]).state === 'clean' &&
      countManagedBlocks(content) > 0 &&
      carriesLegacyBody(stripManagedBlock(content))
    ) {
      found.push({
        rel,
        diagnosis: {
          state: 'stale',
          fixable: false,
          detail: 'contains a whole instruction set from an older OpenCastle release,' +
            ' above the managed block',
          fix:
            'delete the generated text above the OpenCastle block — it is superseded,' +
            ' and only you can tell where your own writing ends; this one needs a person',
        },
      })
    }
  }

  if (found.length === 0) return { label, ok: true, warning: false }

  // Every file, not the first. Returning as soon as one was found dropped a
  // genuinely torn file from the report the moment any other file was doubled.
  const detail = found.map(({ rel, diagnosis }) => `${rel} ${diagnosis.detail}`).join('; ')
  // Failing only when nothing can clear it. A doubled file with no strays is
  // fixed by `sync` in one run, so telling the user to hand-edit 20KB — which
  // the old single remedy did — was both wrong and alarming.
  // A lone stray marker breaks nothing — the block is intact and every command
  // works — and the commonest source of one is a file that documents the
  // convention. Failing on it hands that user a red they can only clear by
  // editing their own prose. It is still named, with its remedy, because only
  // they can tell whether the text beside it is stale output of ours.
  if (found.every(({ diagnosis }) => diagnosis.state === 'torn')) {
    return {
      label,
      ok: true,
      warning: true,
      detail,
      fix: found.map(({ rel, diagnosis }) => `${rel}: ${diagnosis.fix}`).join('; '),
    }
  }

  const needsAPerson = found.filter(({ diagnosis }) => !diagnosis.fixable)
  if (needsAPerson.length === 0) {
    return { label, ok: false, warning: false, detail, fix: 'opencastle sync' }
  }
  return {
    label,
    ok: false,
    warning: false,
    detail,
    fix: needsAPerson.map(({ rel, diagnosis }) => `${rel}: ${diagnosis.fix}`).join('; '),
  }
}

/**
 * Does the manifest still file a co-owned root file as wholly generated?
 *
 * `framework` licenses deletion. A stale record saying CLAUDE.md belongs there
 * is the precondition for losing it, so it is worth naming even though `init`
 * and `remove` no longer trust the record.
 */
function checkRootFileClassification(manifest: Manifest | null): CheckResult {
  const label = 'Manifest classifies root files correctly';
  if (!manifest?.managedPaths) return { label, ok: true, warning: false };

  const misfiled = [
    ...(manifest.managedPaths.framework ?? []),
    ...(manifest.managedPaths.customizable ?? []),
  ].filter((p) => (ROOT_INSTRUCTION_FILES as readonly string[]).includes(p));

  if (misfiled.length === 0) return { label, ok: true, warning: false };
  return {
    label,
    ok: true,
    warning: true,
    detail: `${misfiled.join(', ')} recorded as generated — run "opencastle sync" to repair`,
  };
}

/**
 * The checks that do not depend on a particular target.
 *
 * Exported because `status` needs the same verdict. It used to derive health
 * from a subset of these facts and print "Everything is current" on projects
 * `doctor` was exiting 1 over — a gitignored output tree, an unparseable skill
 * matrix. One fact, two interpreters, which is the defect this codebase keeps
 * producing; the cure is a call, not a second implementation.
 */
/**
 * The adapter-declared half of `doctor`'s verdict.
 *
 * Exported for `status`, which used to build its picture from the shared checks
 * alone — so a missing agent directory made `doctor` red and the front door
 * green. Two readers of one question, in the command whose whole job is to
 * answer it.
 */
export async function runAdapterChecks(
  projectRoot: string,
  manifest: Manifest | null,
): Promise<CheckResult[]> {
  if (!manifest) return [];
  const ides = manifest.ides?.length ? manifest.ides : manifest.ide ? [manifest.ide] : [];
  const out: CheckResult[] = [];
  for (const ide of ides) {
    const loader = IDE_ADAPTERS[ide];
    if (!loader) continue;
    const adapter = await loader();
    for (const check of adapter.getDoctorChecks()) {
      try {
        out.push(await runDoctorCheck(projectRoot, check));
      } catch (err) {
        out.push({
          label: check.label,
          ok: false,
          detail: `could not be checked — ${(err as Error).message}`,
        });
      }
    }
    const mcpPaths = adapter.getManagedPaths().customizable.filter((p) => !p.endsWith('/'));
    out.push(checkMcpFromPaths(projectRoot, mcpPaths));
  }
  return out;
}

export async function runSharedChecks(
  projectRoot: string,
  manifest: Manifest | null,
): Promise<CheckResult[]> {
  return [
    checkManifest(manifest),
    await checkCustomizations(projectRoot),
    await checkSkillMatrix(projectRoot),
    await checkLogs(projectRoot),
    await checkMcpEnvVars(projectRoot, manifest),
    await checkDotEnv(projectRoot, manifest),
    await checkGitignoredOutput(projectRoot, manifest),
    await checkGitignoreBlock(projectRoot),
    await checkTornBlocks(projectRoot, manifest),
    checkRootFileClassification(manifest),
  ];
}

export default async function doctor({ args }: CliContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(DOCTOR_HELP)
    return
  }

  const projectRoot = process.cwd();

  console.log(`\n  🏰 ${BOLD('OpenCastle Doctor')}\n`);
  console.log(`  ${DIM('Checking your setup...')}\n`);

  let manifest: Manifest | null = null;
  let manifestUnreadable: string | undefined;
  try {
    manifest = await readManifest(projectRoot);
  } catch (err) {
    if (!(err instanceof UnreadableConfigError)) throw err;
    manifestUnreadable = err.file;
  }

  // Shared checks (not IDE-specific)
  const sharedResults = manifestUnreadable
    ? [
        {
          ok: false,
          label: 'OpenCastle manifest',
          detail: `${manifestUnreadable} is not valid JSON`,
          // Not `init`: that would run over a populated .opencastle/ and is how
          // this state used to destroy the user's own notes.
          fix: 'fix the JSON by hand — a merge conflict, most likely',
        },
      ]
    : await runSharedChecks(projectRoot, manifest);

  // IDE-specific checks derived from each adapter
  type IdeGroup = { label: string; results: CheckResult[] };
  const ideGroups: IdeGroup[] = [];

  if (manifest) {
    const ides = manifest.ides ?? (manifest.ide ? [manifest.ide] : []);
    for (const ide of ides) {
      const loader = IDE_ADAPTERS[ide];
      if (!loader) continue;
      const adapter = await loader();
      const doctorChecks = adapter.getDoctorChecks();
      const managedPaths = adapter.getManagedPaths();

      const checkResults = await Promise.all(
        doctorChecks.map((c) => runDoctorCheck(projectRoot, c))
      );

      // MCP config check — non-directory entries in the adapter's customizable paths
      const mcpPaths = managedPaths.customizable.filter((p) => !p.endsWith('/'));
      checkResults.push(checkMcpFromPaths(projectRoot, mcpPaths));

      ideGroups.push({
        label: IDE_LABELS[ide as IdeChoice] ?? ide,
        results: checkResults,
      });
    }
  }

  // Print shared results
  for (const r of sharedResults) {
    const icon = r.ok ? (r.warning ? WARN : PASS) : FAIL;
    const detail = r.detail ? `  ${DIM(r.detail)}` : '';
    console.log(`  ${icon} ${r.label}${detail}`);
  }

  // Print IDE-specific results, grouped with a header when multiple IDEs are configured
  if (ideGroups.length > 0) {
    console.log();
    for (const group of ideGroups) {
      if (ideGroups.length > 1) {
        console.log(`  ${BOLD(`[${group.label}]`)}`);
      }
      for (const r of group.results) {
        const icon = r.ok ? (r.warning ? WARN : PASS) : FAIL;
        const detail = r.detail ? `  ${DIM(r.detail)}` : '';
        console.log(`  ${icon} ${r.label}${detail}`);
      }
      if (ideGroups.length > 1) console.log();
    }
  }

  const allResults = [...sharedResults, ...ideGroups.flatMap((g) => g.results)];
  const failures = allResults.filter((r) => !r.ok);
  const warnings = allResults.filter((r) => r.ok && r.warning);

  if (failures.length > 0) {
    console.log(`  ${BOLD(`${failures.length} issue(s) found.`)}\n`);
    // Per failure, because they do not share a remedy.
    for (const f of failures) {
      console.log(`    ${f.label}: ${DIM(f.fix ?? 'run "npx opencastle sync"')}`);
    }
    console.log('');
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(`  ${BOLD('All checks passed')} with ${warnings.length} warning(s).\n`);
    // A warning's remedy was computed and never shown — `fix` was rendered for
    // failures only, so `sync` told the user to run `doctor` and `doctor`
    // printed the problem with no advice attached to it.
    for (const w of warnings) {
      if (w.fix) console.log(`    ${w.label}: ${DIM(w.fix)}`);
    }
    if (warnings.some((w) => w.fix)) console.log('');
  } else {
    console.log(`  ${BOLD('All checks passed.')} Your setup is healthy.\n`);
  }
}
