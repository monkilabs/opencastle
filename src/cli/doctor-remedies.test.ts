/**
 * Every failure `doctor` reports must name a remedy that clears it.
 *
 * Three review rounds found the same shape: a check fails, the summary prints
 * "run npx opencastle sync", `sync` reports health, and the check fails again —
 * forever, because the repair sat behind the up-to-date short-circuit or behind
 * a flag the diagnosis never mentioned. Asserting the property is the only way
 * to stop rediscovering instances of it.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')
const built = existsSync(join(repoRoot, 'dist', 'cli', 'doctor.js'))

/** Run the CLI in `dir`; returns exit code and combined output. */
function run(dir: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe.skipIf(!built)('doctor prescribes remedies that work', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-remedy-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n')
    run(dir, ['init', '--yes'])
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const breakages: Array<[string, (_d: string) => void]> = [
    ['the customizations directory is gone', (d) => rmSync(join(d, '.opencastle', 'agents'), { recursive: true, force: true })],
    ['the skill matrix is gone', (d) => rmSync(join(d, '.opencastle', 'agents', 'skill-matrix.json'), { force: true })],
    ['the logs directory is gone', (d) => rmSync(join(d, '.opencastle', 'logs'), { recursive: true, force: true })],
    ['the gitignore block was deleted', (d) => writeFileSync(join(d, '.gitignore'), 'node_modules\n')],
    ['a generated directory is gone', (d) => rmSync(join(d, '.claude', 'agents'), { recursive: true, force: true })],
  ]

  for (const [name, breakIt] of breakages) {
    it(`recovers when ${name}`, () => {
      breakIt(dir)
      const before = run(dir, ['doctor'])
      if (before.code === 0) return // not a failure state; nothing to prove

      // Whatever it told the user to do, plain `sync` must be enough. No
      // `--force`: a diagnosis that needs a flag it never names is the bug.
      const fixed = run(dir, ['sync', '--yes'])
      expect(fixed.code, `sync failed: ${fixed.out}`).toBe(0)

      const after = run(dir, ['doctor'])
      expect(after.code, `doctor still failing after its own remedy:\n${after.out}`).toBe(0)
    })
  }

  it('never reports health while doctor is failing', () => {
    rmSync(join(dir, '.opencastle', 'agents'), { recursive: true, force: true })
    const status = run(dir, [])
    const health = run(dir, ['doctor'])
    if (health.code !== 0) {
      expect(status.out, 'the front door called a broken install current').not.toContain(
        'Everything is current',
      )
    }
  })
})

describe.skipIf(!built)('sync does not touch what it did not write', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-fence-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n')
    run(dir, ['init', '--yes'])
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('leaves hand edits under .opencastle/ alone, including the skill matrix', () => {
    const matrix = join(dir, '.opencastle', 'agents', 'skill-matrix.json')
    const data = JSON.parse(require('node:fs').readFileSync(matrix, 'utf8')) as {
      bindings: Record<string, { entries: unknown[] }>
    }
    data.bindings.framework.entries = [{ name: 'Internal Framework', skill: 'acme-fw' }]
    writeFileSync(matrix, JSON.stringify(data, null, 2))

    const notes = join(dir, '.opencastle', 'project', 'decisions.md')
    mkdirSync(join(dir, '.opencastle', 'project'), { recursive: true })
    writeFileSync(notes, '# Decisions\n\nNEVER_FORCE_PUSH\n')

    run(dir, ['sync', '--yes', '--force'])
    run(dir, ['sync', '--yes', '--force'])

    const after = JSON.parse(require('node:fs').readFileSync(matrix, 'utf8')) as {
      bindings: Record<string, { entries: Array<{ skill: string }> }>
    }
    expect(after.bindings.framework.entries.map((e) => e.skill)).toContain('acme-fw')
    expect(require('node:fs').readFileSync(notes, 'utf8')).toContain('NEVER_FORCE_PUSH')
  })
})

/**
 * The invariant at the command, not at the function.
 *
 * `writeManagedBlock` collapsed duplicate blocks correctly for two rounds while
 * `sync` never reached it: the checker compared only the last block, so two
 * blocks were not drift, so the command short-circuited. Every unit test passed.
 * These drive the CLI.
 */
describe.skipIf(!built)('a root file with two blocks heals on a plain sync', () => {
  let dir: string

  const START = '<!-- >>> OpenCastle managed — regenerated by `opencastle sync`, edits here are lost >>> -->'
  const END = '<!-- <<< OpenCastle managed <<< -->'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-dupe-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n\nKEEP-ME\n')
    run(dir, ['init', '--yes'])
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** The shape a "keep both sides" merge resolution produces. */
  function duplicateBlock(): void {
    const file = join(dir, 'CLAUDE.md')
    const t = readFileSync(file, 'utf8')
    const a = t.indexOf(START)
    const b = t.indexOf(END) + END.length
    const stale = t.slice(a, b).replace('# Project Instructions', '# Project Instructions\n\nSTALE-MARKER')
    writeFileSync(file, t.slice(0, a) + stale + '\n\n' + t.slice(a))
  }

  function blocks(): number {
    return readFileSync(join(dir, 'CLAUDE.md'), 'utf8').split(END).length - 1
  }

  it('is reported as drift before anything is written', () => {
    duplicateBlock()
    expect(blocks()).toBe(2)
    expect(run(dir, ['sync', '--check']).code, 'the checker cannot see a doubled file').toBe(1)
  })

  it('collapses without --force, and keeps the user half', () => {
    duplicateBlock()
    expect(run(dir, ['sync', '--yes']).code).toBe(0)

    expect(blocks(), 'still doubled after a plain sync').toBe(1)
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(text).not.toContain('STALE-MARKER')
    expect(text).toContain('KEEP-ME')
    expect(run(dir, ['sync', '--check']).code).toBe(0)
  })

  it('leaves nothing of ours behind on uninstall', () => {
    duplicateBlock()
    run(dir, ['remove', '--all', '--yes'])
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(text).not.toContain(START)
    expect(text).not.toContain(END)
    expect(text).toContain('KEEP-ME')
  })
})

/**
 * Committed generated JSON is what a merge conflicts on — the direct consequence
 * of this branch's headline change. An unguarded parse turned that into an abort
 * with no filename, after the adapters had rewritten the framework directories
 * and before the manifest was written.
 */
describe.skipIf(!built)('a generated JSON file that will not parse', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-conflict-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'package.json'), '{"name":"p","version":"1.0.0"}')
    run(dir, ['init', '--yes'])
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function conflict(rel: string): void {
    const p = join(dir, rel)
    if (!existsSync(p)) return
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.splice(2, 0, '<<<<<<< HEAD', '=======', '>>>>>>> feat')
    writeFileSync(p, lines.join('\n'))
  }

  for (const rel of ['.vscode/mcp.json', '.mcp.json', '.opencastle/agents/skill-matrix.json']) {
    it(`names ${rel} and finishes the sync`, () => {
      conflict(rel)
      if (!existsSync(join(dir, rel))) return

      const result = run(dir, ['sync', '--force', '--yes'])
      expect(result.code, `sync aborted:\n${result.out}`).toBe(0)
      expect(result.out, 'the file was not named').toContain(rel)
    })
  }
})
