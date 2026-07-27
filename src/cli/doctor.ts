import { resolve } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readManifest } from './manifest.js';
import { getRequiredMcpEnvVars, resolveStack, isEnvVarSatisfied } from './stack-config.js';
import { IDE_ADAPTERS } from './adapters/index.js';
import { resolveManagedPaths, ROOT_INSTRUCTION_FILES } from './managed-paths.js';
import { orphanMarkers, countManagedBlocks } from './managed-block.js';
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
  return { ok: true, label: 'OpenCastle manifest (.opencastle/manifest.json)', detail: `v${manifest.version}, IDE: ${manifest.ides?.join(', ') ?? manifest.ide}` };
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
      fix: 'fix or delete the file, then run opencastle sync',
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

  if (check.countContents) {
    const entries = await readdir(fullPath).catch(() => [] as string[]);
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
    fix: (await ignoredByOurBlock(projectRoot, hidden))
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
async function ignoredByOurBlock(projectRoot: string, hidden: string[]): Promise<boolean> {
  const path = resolve(projectRoot, '.gitignore');
  if (!existsSync(path)) return false;

  const content = await readFile(path, 'utf8');
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
  const torn: string[] = []
  const doubled: string[] = []
  for (const rel of managed.merged) {
    const abs = resolve(projectRoot, rel)
    if (!existsSync(abs)) continue
    const content = await readFile(abs, 'utf8')
    if (orphanMarkers(content).length > 0) torn.push(rel)
    if (countManagedBlocks(content) > 1) doubled.push(rel)
  }

  if (torn.length === 0 && doubled.length === 0) return { label, ok: true, warning: false }

  // More than one complete block is two sets of instructions in one file, and
  // the assistant reads both. `sync --check` has always compared block counts;
  // `doctor` looked only for unpaired markers, so it was the one surface that
  // called a doubled root file healthy — and after the writer stopped reducing
  // a torn file, that state persists rather than being collapsed on the next
  // run. Whichever command the user reaches for has to say the same thing.
  if (doubled.length > 0) {
    return {
      label,
      ok: false,
      warning: false,
      detail: `${doubled.join(', ')} contains more than one OpenCastle block`,
      fix:
        'the file also has markers that do not pair up, so this cannot be reduced' +
        ' safely — delete the block you do not want, keeping one start/end pair',
    }
  }
  // A warning, not a failure. The same shape is a torn block of ours *or* a
  // marker the user quoted in their own documentation, and we cannot tell —
  // failing would hand the second user a red check they can never clear, which
  // is the unclearable-CI defect from an earlier round wearing a new hat.
  return {
    label,
    ok: true,
    warning: true,
    detail: `${torn.join(', ')} has an OpenCastle marker that belongs to no block`,
    fix:
      'text beside that marker may be stale generated output — remove it, or restore the' +
      ' missing marker, then run "npx opencastle sync"',
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
  } else {
    console.log(`  ${BOLD('All checks passed.')} Your setup is healthy.\n`);
  }
}
