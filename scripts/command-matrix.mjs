#!/usr/bin/env node
/* global console, process */
/**
 * Every command, against every combination of its flags, in every project state
 * it can meet — checked against properties rather than against 5,000 hand-written
 * expectations.
 *
 * Twenty-one review rounds found defects in this surface one instance at a time,
 * and the flag surface itself turned out to be untested: `sync --chekc --yes` ran a
 * full sync instead of a read-only check and exited 0; `doctor --fix` was accepted
 * and ignored; `init --ide` silently installed something else. None of those is a
 * subtle bug. Nothing was looking.
 *
 * The tables are derived from the CLI, not written down beside it, so a flag or a
 * command added later is covered without anyone remembering this file. The
 * assertions are properties every invocation must satisfy whatever it does, which
 * is what makes the matrix tractable:
 *
 *   P1  never a stack trace
 *   P2  an errno in the output means a path in the output — no anonymous failures
 *   P3  exit code is 0 or 1, never a crash or a signal
 *   P4  --dry-run writes nothing: the tree is byte-identical afterwards
 *   P5  a writing command run twice changes nothing the second time
 *   P6  a non-zero exit leaves the install coherent — never framework files with
 *       no manifest
 *   P7  no invocation hangs waiting for an answer nobody can give
 *   P8  after a run, `doctor` and `sync --check` do not disagree about health
 *
 * Usage: node scripts/command-matrix.mjs [--tier=1|2|3] [--only=sync,init] [--verbose]
 *
 *   tier 1  subsets of size <= 2, on three states        (a commit gate)
 *   tier 2  full per-command powerset, on every state it can meet
 *   tier 3  everything, including the states a command cannot normally reach
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'bin', 'cli.mjs')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const TIER = Number(arg('tier', '1'))
const ONLY = arg('only', '')
  .split(',')
  .filter(Boolean)
const VERBOSE = argv.includes('--verbose')

let pass = 0
const failures = []
const ok = () => { pass++ }
const bad = (what, detail) => { failures.push({ what, detail }) }

// ── The command surface, read from the entrypoint ────────────────────────────

/**
 * Commands and the flags each one reads.
 *
 * `COMMAND_FLAGS` in `bin/cli.mjs` is the entrypoint's own table, already asserted
 * against every command's `--help` by `docs-accuracy.test.ts`. Reading it here
 * means this matrix cannot fall behind the CLI either.
 */
function surface() {
  const src = readFileSync(CLI, 'utf8')
  const table = /const COMMAND_FLAGS = \{([\s\S]*?)\n\}/.exec(src)
  if (!table) throw new Error('COMMAND_FLAGS not found in bin/cli.mjs')
  const out = new Map()
  for (const row of table[1].split('\n')) {
    const m = /^\s*([a-z]+):\s*\[(.*?)\],?\s*$/.exec(row)
    if (!m) continue
    // One spelling per flag: `--dryRun` is an alias for `--dry-run` and testing
    // both doubles the matrix to learn nothing.
    const flags = [...m[2].matchAll(/'(-{1,2}[\w-]+)'/g)]
      .map((x) => x[1])
      .filter((f) => f !== '--dryRun' && f !== '-y')
    out.set(m[1], flags)
  }
  // Commands whose input is open-ended: they validate their own arguments, so the
  // matrix exercises them bare rather than inventing flags for them.
  out.set('', [])
  out.set('doctor', out.get('doctor') ?? [])
  return out
}

// ── Project states ───────────────────────────────────────────────────────────

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function seedRepo(dir) {
  mkdirSync(dir, { recursive: true })
  sh('git', ['init', '-q'], dir)
  writeFileSync(join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}\n')
}

/**
 * Each state is built once into a template and copied per test case. Running
 * `init` for every one of several hundred cases would dominate the runtime and
 * test the same install repeatedly.
 */
const STATES = {
  'no-git': (dir) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}\n')
  },
  fresh: (dir) => seedRepo(dir),
  'pre-existing': (dir) => {
    seedRepo(dir)
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n\nMY OWN RULE\n')
    writeFileSync(join(dir, '.gitignore'), 'node_modules\nkeep-me\n')
    writeFileSync(join(dir, 'opencode.json'), '{"theme":"tokyonight"}\n')
  },
  installed: (dir) => {
    seedRepo(dir)
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n\nMY OWN RULE\n')
    sh('node', [CLI, 'init', '--yes'], dir)
  },
  drifted: (dir) => {
    STATES.installed(dir)
    const f = firstGenerated(dir)
    if (f) writeFileSync(f, readFileSync(f, 'utf8') + '\nMY HAND EDIT\n')
  },
  'dir-for-file': (dir) => {
    STATES.installed(dir)
    const f = firstGenerated(dir)
    if (f) { rmSync(f); mkdirSync(f) }
  },
  'file-for-dir': (dir) => {
    STATES.installed(dir)
    const d = firstGeneratedDir(dir)
    if (d) { rmSync(d, { recursive: true }); writeFileSync(d, 'x\n') }
  },
  'no-manifest': (dir) => {
    STATES.installed(dir)
    rmSync(join(dir, '.opencastle', 'manifest.json'), { force: true })
  },
  'kept-files': (dir) => {
    STATES.installed(dir)
    sh('node', [CLI, 'remove', '--keep-files', '--yes'], dir)
  },
  legacy: (dir) => {
    seedRepo(dir)
    const body = [
      '# Project Instructions', '',
      'All conventions, architecture, and project context are embedded below.', '',
      '## Agent Definitions', '', '- API Designer', '',
    ].join('\n')
    writeFileSync(join(dir, 'CLAUDE.md'), `# MY OWN RULES\n\nNever force-push main.\n\n${body}`)
    mkdirSync(join(dir, '.claude'), { recursive: true })
    sh('node', [CLI, 'init', '--yes'], dir)
  },
  // `unreadable` has no builder: a `chmod 000` directory cannot be copied by a
  // non-root user, so baking it into a template made `cp -a` fail for every case
  // that used it. It is built from the `installed` template and locked afterwards,
  // per case — see AFTER_COPY.
  unreadable: (dir) => STATES.installed(dir),
}

/**
 * Mutations applied to a fresh copy rather than to the template.
 *
 * Anything that makes a directory uncopyable belongs here. The template stays
 * readable so `cp -a` works, and the fault is introduced in the case directory a
 * moment before the command runs.
 */
const AFTER_COPY = {
  unreadable: (dir) => {
    const d = join(dir, '.opencastle', 'agents')
    if (existsSync(d)) chmodSync(d, 0o000)
  },
}

/** The template a state copies from, when it is not its own. */
const TEMPLATE_OF = { unreadable: 'installed' }

const TIER_STATES = {
  1: ['fresh', 'installed', 'drifted'],
  2: ['no-git', 'fresh', 'pre-existing', 'installed', 'drifted', 'dir-for-file', 'no-manifest'],
  3: Object.keys(STATES),
}

function walk(dir, out = [], base = dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, base)
    else out.push(relative(base, p))
  }
  return out
}

function firstGenerated(dir) {
  for (const rel of walk(dir).sort()) {
    if (rel.startsWith('.opencastle')) continue
    if ((rel.startsWith('.claude/') || rel.startsWith('.github/')) && rel.endsWith('.md')) {
      return join(dir, rel)
    }
  }
  return null
}

function firstGeneratedDir(dir) {
  for (const root of ['.claude/skills', '.github/skills']) {
    const abs = join(dir, root)
    if (!existsSync(abs)) continue
    const kids = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory())
    if (kids.length) return join(abs, kids[0].name)
  }
  return null
}

/**
 * A hash of every file the fixture holds, so "wrote nothing" is checkable.
 *
 * The manifest's `updatedAt` is normalised away. It is a record of when the tool
 * last ran, so it moves on a `--force` run by design, and hashing it made every
 * forced sync look non-idempotent — a property failing on its own bookkeeping
 * rather than on anything the tool generated. Checked first that this is not
 * hiding something: a plain `sync` on an up-to-date project leaves `git diff`
 * clean and does not touch the manifest at all, which is the CI shape that matters.
 *
 * Nothing else is excluded. Narrowing this further would be the same mistake as an
 * assertion that cannot fail.
 */
function treeHash(dir) {
  const h = createHash('sha256')
  for (const rel of walk(dir).sort()) {
    h.update(rel)
    let bytes
    try {
      bytes = readFileSync(join(dir, rel))
    } catch {
      h.update('<unreadable>')
      continue
    }
    if (rel === join('.opencastle', 'manifest.json')) {
      try {
        const m = JSON.parse(bytes.toString('utf8'))
        // Three fields, each excluded for a reason, and nothing else.
        //
        // `updatedAt`/`installedAt` record when the tool ran, so they move on a
        // forced run by design. `repoInfo` is a snapshot of what detection found:
        // on a first install `.vscode/mcp.json` does not exist yet, and on the
        // next run it does, because we wrote it. Detection describing the project
        // truthfully at two different moments is not the tool being unstable —
        // and `remove --all` cleans up correctly either way, which was checked
        // rather than assumed.
        //
        // Everything else is compared: every generated file, `managedPaths`,
        // `stack`, `ides`, and `createdConfigs` — which is where this property
        // found a real defect.
        delete m.updatedAt
        delete m.installedAt
        delete m.repoInfo
        bytes = Buffer.from(JSON.stringify(m))
      } catch {
        // Unparseable is itself a fact worth hashing — leave the bytes alone.
      }
    }
    h.update(bytes)
  }
  return h.digest('hex')
}

// ── Combinations ─────────────────────────────────────────────────────────────

function subsets(flags, maxSize) {
  const out = [[]]
  const rec = (start, acc) => {
    if (acc.length >= maxSize) return
    for (let i = start; i < flags.length; i++) {
      const next = [...acc, flags[i]]
      out.push(next)
      rec(i + 1, next)
    }
  }
  rec(0, [])
  return out
}

// ── One invocation ───────────────────────────────────────────────────────────

const ERRNO = /\b(EISDIR|EACCES|EPERM|ENOENT|EEXIST|ENOTDIR|EMFILE)\b/
const STACK = /\bat async\b|\bat Object\.|node:internal|Node\.js v\d/

function invoke(dir, args) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\[[0-9;]*m/g, '')
  return { out, code: r.status, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT' }
}

function check(state, cmd, flags, dir) {
  const label = `${state}: opencastle ${[cmd, ...flags].filter(Boolean).join(' ') || '(bare)'}`
  const args = [cmd, ...flags].filter(Boolean)
  const isDryRun = flags.includes('--dry-run')
  const before = treeHash(dir)

  const { out, code, signal, timedOut } = invoke(dir, args)

  // P7 — nothing may hang. stdin is closed, so a command waiting for an answer
  // that can never come is a defect, not a slow test.
  if (timedOut || signal) {
    bad(label, `did not terminate (signal=${signal ?? 'none'}, timedOut=${timedOut})`)
    return
  }
  ok()

  // P3 — a documented exit code.
  if (code !== 0 && code !== 1) bad(label, `exit code ${code}`)
  else ok()

  // P1 — never a stack trace.
  if (STACK.test(out)) bad(label, `stack trace:\n${out.split('\n').slice(0, 4).join('\n')}`)
  else ok()

  // P2 — an errno without a path is an error the user cannot act on.
  //
  // Judged per line, not over the whole output. Asking whether the output contains
  // any path at all made this nearly unfalsifiable: `doctor` prints paths in normal
  // operation, so an injected `EISDIR: illegal operation` with nothing to act on
  // passed because unrelated lines above it happened to mention files. The defect
  // shape is a single anonymous line — `✗ EISDIR: illegal operation on a directory,
  // read` — so the line carrying the errno is what has to name something.
  // Judged over the errno line and the two non-empty lines above it, which is how
  // the CLI actually presents these: the path on one line, the reason indented
  // beneath it.
  //
  //   ! .github/prompts/x.prompt.md (vscode)
  //       cannot be read — EISDIR: illegal operation on a directory, read
  //
  // Requiring the path on the errno line itself called all 64 of those a defect.
  // Allowing any path anywhere in the output let the real one through, because
  // most commands print paths in normal operation. The window is what distinguishes
  // "named, with the reason below" from a lone `✗ EISDIR: …` under a banner.
  const lines = out.split('\n')
  const nonEmptyBefore = (i) => {
    const seen = []
    for (let k = i - 1; k >= 0 && seen.length < 2; k--) {
      if (lines[k].trim() !== '') seen.push(lines[k])
    }
    return seen
  }
  const anonymous = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => ERRNO.test(line))
    .filter(({ line, i }) => ![line, ...nonEmptyBefore(i)].some((l) => /[/\\]/.test(l)))
  if (anonymous.length > 0) bad(label, `errno with no path nearby: ${anonymous[0].line.trim()}`)
  else ok()

  // P4 — a dry run writes nothing at all.
  if (isDryRun) {
    if (treeHash(dir) !== before) bad(label, '--dry-run changed the tree')
    else ok()
  }

  // P5 — run it again; a settled command changes nothing the second time.
  if (!isDryRun && WRITERS.has(cmd)) {
    const afterFirst = treeHash(dir)
    invoke(dir, args)
    if (treeHash(dir) !== afterFirst) bad(label, 'not idempotent — the second run changed the tree')
    else ok()
  }

  // P6 — a failure must not leave generated files with no manifest to find them by.
  const files = walk(dir).filter((f) => f.startsWith('.claude/') || f.startsWith('.github/') || f.startsWith('.cursor/'))
  const manifest = existsSync(join(dir, '.opencastle', 'manifest.json'))
  if (files.length > 0 && !manifest && !NO_MANIFEST_STATES.has(state) && cmd !== 'remove') {
    bad(label, `${files.length} generated files and no manifest`)
  } else ok()

  // P8 — the two reporting surfaces must not contradict each other afterwards.
  if (TIER >= 2 && !isDryRun) {
    const dr = invoke(dir, ['doctor']).code
    const gate = invoke(dir, ['sync', '--check'])
    if (dr === 0 && gate.code !== 0 && /match their sources/.test(gate.out)) {
      bad(label, 'gate claims everything matches while doctor is red')
    } else ok()
  }

  if (VERBOSE) console.log(`  ${code === 0 ? '·' : '!'} ${label}`)
}

/** Commands that write, so idempotence is a meaningful question for them. */
const WRITERS = new Set(['init', 'sync', 'update', 'add', 'remove'])
/** States where the absence of a manifest is the point of the fixture. */
const NO_MANIFEST_STATES = new Set(['no-manifest', 'kept-files', 'fresh', 'pre-existing', 'no-git', 'legacy'])

// ── Run ──────────────────────────────────────────────────────────────────────

const flagsFor = surface()
const states = TIER_STATES[TIER] ?? TIER_STATES[1]
const maxSize = TIER === 1 ? 2 : 99
const root = mkdtempSync(join(tmpdir(), 'oc-matrix-'))
const templates = new Map()

console.log(`\n  command matrix — tier ${TIER}`)
console.log(`  states: ${states.join(' ')}`)
console.log(`  commands: ${[...flagsFor.keys()].map((c) => c || '(bare)').join(' ')}\n`)

let cases = 0
for (const state of states) {
  const templateName = TEMPLATE_OF[state] ?? state
  const template = join(root, `tpl-${templateName}`)
  if (!templates.has(templateName)) {
    try {
      STATES[templateName](template)
    } catch (err) {
      bad(`${state}: fixture`, String(err))
      continue
    }
    templates.set(templateName, template)
  }

  for (const [cmd, flags] of flagsFor) {
    if (ONLY.length && !ONLY.includes(cmd || 'bare')) continue
    for (const combo of subsets(flags, maxSize)) {
      const dir = join(root, `c${cases++}`)
      // `cp -a` preserves the 000 mode the unreadable fixture depends on.
      const cp = sh('cp', ['-a', template, dir], root)
      if (cp.status !== 0) { bad(`${state}: copy`, cp.stderr); continue }
      AFTER_COPY[state]?.(dir)
      check(state, cmd, combo, dir)
      // Unlock the whole case directory before removing it. Restoring one known
      // path was not enough: `remove --all` parks `.opencastle/` as
      // `.opencastle.removed/`, taking the locked directory with it under a name
      // the cleanup did not know, and the run died on its own fixture.
      sh('chmod', ['-R', 'u+rwX', dir], root)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

sh('chmod', ['-R', 'u+rwX', root], root)
rmSync(root, { recursive: true, force: true })

console.log(`\n  ${cases} invocations, ${pass} assertions passed, ${failures.length} failed\n`)
for (const f of failures.slice(0, 40)) {
  console.log(`  FAIL ${f.what}`)
  console.log(`       ${f.detail.split('\n').join('\n       ')}`)
}
if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`)
process.exit(failures.length === 0 ? 0 : 1)
