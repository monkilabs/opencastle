/**
 * `init` must actually scan the project it is initialising.
 *
 * `bootstrapCustomizations` fills `.opencastle/` in from what the repo turned
 * out to be: the project name, the tech-stack table, and the key-commands block
 * that records which package manager to use. It is guarded so that a re-run
 * cannot overwrite notes the user has since written, because its stack-config
 * step writes unconditionally.
 *
 * That guard read `.opencastle/agents`, and the scaffold step eighteen lines
 * above it creates `.opencastle/agents`. So it was true on the first run too,
 * and the scan never executed for anybody: every marker in
 * `project.instructions.md` stayed bare. The visible symptom was six skills
 * hardcoding `pnpm`, having no populated file to read it from.
 *
 * Both halves are asserted here, because fixing the first by deleting the guard
 * would destroy user content on the second.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(repoRoot, 'bin', 'cli.mjs')

// `bin/cli.mjs` loads the command modules from `dist/`, so with no build these
// would all fail on a missing import rather than on anything they assert. CI
// builds before `npm test`, so nothing here is skipped there.
const cliBuilt = existsSync(join(repoRoot, 'dist', 'cli', 'init.js'))

function run(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '')
  }
}

describe.skipIf(!cliBuilt)('init scans the project it initialises', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oc-bootstrap-'))
    execFileSync('git', ['init', '-q'], { cwd: projectRoot })
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# House rules\n')
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'demo-app',
        description: 'a demo app',
        scripts: { dev: 'next dev', build: 'next build', test: 'vitest run', lint: 'eslint .' },
      }),
    )
    // The lockfile is how the package manager is detected.
    writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), '')
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  const instructions = (): string =>
    readFileSync(join(projectRoot, '.opencastle', 'project.instructions.md'), 'utf8')

  it('records the detected package manager and its commands', () => {
    run(projectRoot, 'init', '--yes')
    const text = instructions()
    expect(text).toContain('**Package manager:** `pnpm`')
    expect(text).toContain('pnpm run test')
  })

  it('records what the repo is, not just what the template says', () => {
    run(projectRoot, 'init', '--yes')
    const text = instructions()
    expect(text).toContain('**Project:** demo-app')
    expect(text).toContain('**Description:** a demo app')
    expect(text).toMatch(/\|\s*Package Manager\s*\|\s*pnpm\s*\|/)
  })

  it('leaves the user’s own notes alone when init is re-run', () => {
    run(projectRoot, 'init', '--yes')
    const stackFile = join(projectRoot, '.opencastle', 'stack', 'testing-config.md')
    expect(existsSync(stackFile)).toBe(true)
    appendFileSync(stackFile, '\nNOTES THE USER WROTE\n')

    run(projectRoot, 'init', '--yes')
    expect(readFileSync(stackFile, 'utf8')).toContain('NOTES THE USER WROTE')
  })

  it('leaves them alone after remove --keep-files, which drops only the manifest', () => {
    run(projectRoot, 'init', '--yes')
    const stackFile = join(projectRoot, '.opencastle', 'stack', 'testing-config.md')
    appendFileSync(stackFile, '\nNOTES THE USER WROTE\n')

    run(projectRoot, 'remove', '--keep-files', '--yes')
    // No manifest means `isReinit` is false, so only the directory check stands
    // between the user's notes and bootstrap's unconditional writes.
    expect(existsSync(join(projectRoot, '.opencastle', 'manifest.json'))).toBe(false)
    expect(existsSync(join(projectRoot, '.opencastle', 'agents'))).toBe(true)

    run(projectRoot, 'init', '--yes')
    expect(readFileSync(stackFile, 'utf8')).toContain('NOTES THE USER WROTE')
  })
})
