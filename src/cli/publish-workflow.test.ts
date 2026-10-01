import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parse as yamlParse } from 'yaml'

/**
 * The release checks its credential before it spends ten minutes earning one.
 *
 * npm answers a publish it will not authorize with `E404 … PUT /opencastle —
 * Not found`, hiding the difference between "no such package" and "not your
 * package". Five releases failed that way over six weeks, each after a full
 * install, type-check, test run and build, and each reading as though the
 * package had never existed — while `opencastle` sat on the registry the whole
 * time. The credential is the one input the workflow cannot recover from on its
 * own, so it is the first thing it checks.
 */

const repoRoot = join(import.meta.dirname, '..', '..')

interface Step { name?: string; run?: string; uses?: string }

const workflow = yamlParse(
  readFileSync(join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> }

const steps = workflow.jobs.publish.steps
const indexOf = (predicate: (_s: Step) => boolean): number => steps.findIndex(predicate)

/** The steps that cost real time — everything the credential check must precede. */
const EXPENSIVE = [
  { label: 'installing dependencies', match: /npm ci\b/ },
  { label: 'the test suite', match: /npm test\b/ },
  { label: 'the build', match: /npm run build\b/ },
]

describe('the publish workflow', () => {
  const credentialCheck = indexOf(s => /whoami/.test(s.run ?? ''))

  it('asks npm who it is before publishing', () => {
    expect(credentialCheck, 'no step runs `npm whoami`').toBeGreaterThanOrEqual(0)
  })

  it('checks the credential before spending anything on the release', () => {
    const late = EXPENSIVE.filter(({ match }) => {
      const at = indexOf(s => match.test(s.run ?? ''))
      return at !== -1 && at < credentialCheck
    }).map(e => e.label)
    expect(late, `these run before the credential is checked: ${late.join(', ')}`).toEqual([])
  })

  it('checks the credential before it mutates the version', () => {
    const bump = indexOf(s => /npm version /.test(s.run ?? ''))
    expect(bump).toBeGreaterThan(credentialCheck)
  })

  it('gives the token to every step that talks to the registry', () => {
    // `npm whoami` reads the same ~/.npmrc as `npm publish`, and that file
    // refers to NODE_AUTH_TOKEN by name — a check without the env var in scope
    // reports a missing token on every run, including the healthy ones.
    for (const step of steps) {
      if (!/npm (whoami|publish)/.test(step.run ?? '')) continue
      const env = (step as { env?: Record<string, string> }).env ?? {}
      expect(env.NODE_AUTH_TOKEN, `"${step.name}" talks to the registry without NODE_AUTH_TOKEN`).toBeTruthy()
    }
  })

  it('publishes before it tags, so a rejected publish leaves no release behind', () => {
    const publish = indexOf(s => /npm publish/.test(s.run ?? ''))
    const tag = indexOf(s => /git tag /.test(s.run ?? ''))
    expect(publish).toBeGreaterThanOrEqual(0)
    expect(tag).toBeGreaterThan(publish)
  })

  it('writes a tag and never a branch', () => {
    // `main` is protected by a ruleset with an empty bypass list, so a push to
    // it is rejected — and the step that tried it ran *after* the publish had
    // already succeeded. 0.36.0 reached npm while the repository kept no record
    // of it: no tag, no release, and a version the next run would try again.
    const pushes = steps
      .flatMap(s => [...(s.run ?? '').matchAll(/git push origin ([^\s"']*"?[^\s"']*)/g)])
      .map(m => m[1])
    expect(pushes.length, 'nothing pushes at all — has the tag step gone?').toBeGreaterThan(0)
    const toBranch = pushes.filter(ref => !/tag|TAG|v?\$\{/.test(ref))
    expect(toBranch, `pushes a branch the ruleset will reject: ${toBranch.join(', ')}`).toEqual([])
  })
})

/**
 * The version a merge releases, from the step that decides it, run for real in
 * a scratch repository: a package.json and, optionally, the last release tag.
 */
describe('the version a release takes', () => {
  const step = steps.find(s => s.name === 'Determine next version')
  const script = step?.run ?? ''

  function release(pkgVersion: string, lastTag: string | null, bump: 'major' | 'minor' | 'patch'): string {
    const dir = mkdtempSync(join(tmpdir(), 'oc-release-'))
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' })
      }
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', version: pkgVersion }, null, 2) + '\n')
      git('init', '-q')
      git('add', '.')
      git('commit', '-q', '-m', 'release')
      if (lastTag) git('tag', lastTag)
      const output = join(dir, 'github-output')
      writeFileSync(output, '')
      execFileSync('bash', ['-e', '-c', script.replaceAll('${{ steps.bump.outputs.type }}', bump)], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: output },
        stdio: 'ignore',
      })
      return /^new=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1] ?? ''
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exists', () => {
    expect(script).toMatch(/npm version/)
  })

  it('ships a version a PR wrote by hand exactly as written', () => {
    // A minor bump on top of it would turn the 1.0.0 the PR asked for into 1.1.0.
    expect(release('1.0.0', 'v0.38.2', 'minor')).toBe('v1.0.0')
    expect(release('1.0.0', 'v0.38.2', 'major')).toBe('v1.0.0')
  })

  it('bumps the last tag when package.json trails it', () => {
    expect(release('0.35.3', 'v0.38.2', 'minor')).toBe('v0.39.0')
    expect(release('0.35.3', 'v0.38.2', 'patch')).toBe('v0.38.3')
  })

  it('bumps the last tag once package.json has caught up with it', () => {
    expect(release('1.0.0', 'v1.0.0', 'patch')).toBe('v1.0.1')
    expect(release('1.0.0', 'v1.0.0', 'major')).toBe('v2.0.0')
  })

  it('bumps package.json when nothing has been tagged yet', () => {
    expect(release('0.1.0', null, 'patch')).toBe('v0.1.1')
  })
})
