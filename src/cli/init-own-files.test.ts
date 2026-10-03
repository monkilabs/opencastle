/**
 * What `init` says about files that were there before it.
 *
 * A target is often detected because of a file of the user's in its own rules
 * directory — `.cursor/rules/team.mdc` is what makes Cursor a target — and that
 * directory is generated, so the next `sync` removes the file. `init` used to
 * say nothing, and the first anyone heard of it was `sync` naming a file it had
 * just deleted. The same accounting is what makes "Left N existing files
 * untouched" mean files that were there: a fresh seven-target install said 205,
 * every one of them written a moment earlier by the target before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')

// `bin/cli.mjs` loads the command modules from `dist/`. CI builds before
// `npm test`, so nothing here is skipped there.
const cliBuilt = existsSync(join(repoRoot, 'dist', 'cli', 'init.js'))

describe.skipIf(!cliBuilt)('init and the files already there', () => {
  let projectRoot: string
  let home: string

  const run = (...args: string[]): string =>
    execFileSync('node', [cli, ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A scratch home, so nothing of the person running the tests is read, and
      // plain text to assert on.
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), NO_COLOR: '1' },
    })

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oc-own-files-'))
    home = mkdtempSync(join(tmpdir(), 'oc-own-files-home-'))
    execFileSync('git', ['init', '-q'], { cwd: projectRoot })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('names a rule of yours in a generated directory, and leaves it in place', () => {
    mkdirSync(join(projectRoot, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(projectRoot, '.cursor', 'rules', 'team.mdc'), '---\nalwaysApply: true\n---\nUse tabs.\n')

    const out = run('init', '--yes')

    expect(out).toContain('1 file of yours is in a directory OpenCastle generates')
    expect(out).toContain('.cursor/rules/team.mdc')
    expect(out).toContain('The next sync removes it')
    expect(readFileSync(join(projectRoot, '.cursor', 'rules', 'team.mdc'), 'utf8')).toContain('Use tabs.')
  })

  it('says nothing of the kind when there is nothing of yours there', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# House rules\n')
    expect(run('init', '--yes')).not.toContain('of yours')
  })

  it('counts nothing as left alone on a fresh install for several targets that share a directory', () => {
    // Cursor, Windsurf and OpenCode all write `.agents/skills/`.
    writeFileSync(join(projectRoot, '.cursorrules'), 'rules\n')
    writeFileSync(join(projectRoot, '.windsurfrules'), 'rules\n')
    writeFileSync(join(projectRoot, 'opencode.json'), '{}\n')

    const out = run('init', '--yes')

    expect(out).not.toMatch(/Left \d+ existing files? untouched/)
    const manifest = JSON.parse(readFileSync(join(projectRoot, '.opencastle', 'manifest.json'), 'utf8'))
    const customizable: string[] = manifest.managedPaths.customizable
    expect(customizable.filter((p) => p === '.opencastle/')).toHaveLength(1)
    expect(new Set(manifest.managedPaths.framework).size).toBe(manifest.managedPaths.framework.length)
  })

  it('leaves out the notes for a database and a CMS the project does not use', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# House rules\n')
    run('init', '--yes')
    expect(existsSync(join(projectRoot, '.opencastle', 'stack', 'supabase-config.md'))).toBe(false)
    expect(existsSync(join(projectRoot, '.opencastle', 'stack', 'sanity-config.md'))).toBe(false)
  })

  it('keeps the notes for the one it does use', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# House rules\n')
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@supabase/supabase-js': '2.0.0' } }))
    run('init', '--yes')
    expect(existsSync(join(projectRoot, '.opencastle', 'stack', 'supabase-config.md'))).toBe(true)
    expect(existsSync(join(projectRoot, '.opencastle', 'stack', 'sanity-config.md'))).toBe(false)
  })
})
