/**
 * The symlink scans against real links on disk. partition.test.ts mocks
 * node:fs, so it cannot follow a link through another one.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { scanSymlinks, scanNewSymlinks } from './partition.js'

let root: string
/** The worktree the scans guard. */
let base: string
/** A directory beside it, outside. */
let outside: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'convoy-symlinks-')))
  base = join(root, 'worktree')
  outside = join(root, 'outside')
  mkdirSync(join(base, 'src', 'auth'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret'), 'x\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanSymlinks, before the task', () => {
  it('refuses a tracked link inside a declared directory that leads out', () => {
    symlinkSync(outside, join(base, 'src/auth/keys'))
    expect(() => scanSymlinks(['src/auth/'], base, ['src/auth/keys'])).toThrow('symlink_escape: "src/auth/keys"')
  })

  it('refuses a link above a declared file', () => {
    symlinkSync(outside, join(base, 'src/vendor'))
    expect(() => scanSymlinks(['src/vendor/lib.ts'], base)).toThrow('symlink_escape: "src/vendor"')
  })

  it('leaves alone a tracked link outside the declared paths', () => {
    symlinkSync(outside, join(base, 'docs-link'))
    expect(() => scanSymlinks(['src/auth/'], base, ['docs-link'])).not.toThrow()
  })

  it('passes a link to something inside that is not there yet, such as a build output', () => {
    symlinkSync('../../dist/index.js', join(base, 'src/auth/built.js'))
    expect(() => scanSymlinks(['src/auth/'], base, ['src/auth/built.js'])).not.toThrow()
  })

  it('refuses a link to something outside that is not there yet', () => {
    symlinkSync(join(outside, 'new', 'authorized_keys'), join(base, 'src/auth/keys'))
    expect(() => scanSymlinks(['src/auth/'], base, ['src/auth/keys'])).toThrow('resolves outside the partition')
  })

  it('follows the links on the way to a target that is not there yet', () => {
    // src/auth/keys → src/vendor/keys, and src/vendor leads out.
    symlinkSync(outside, join(base, 'src/vendor'))
    symlinkSync('../vendor/keys', join(base, 'src/auth/keys'))
    expect(() => scanSymlinks(['src/auth/'], base, ['src/auth/keys'])).toThrow('symlink_escape: "src/auth/keys"')
  })
})

describe('scanNewSymlinks, after the task', () => {
  it('refuses a new link inside a declared directory that leads out', () => {
    symlinkSync(outside, join(base, 'src/auth/keys'))
    expect(() => scanNewSymlinks(base, ['src/auth/'], ['src/auth/service.ts', 'src/auth/keys']))
      .toThrow('symlink_escape_post_task: "src/auth/keys"')
  })

  it('refuses a new link outside the declared paths, and from a task that declares none', () => {
    symlinkSync(join(outside, 'secret'), join(base, 'leak'))
    expect(() => scanNewSymlinks(base, ['src/auth/'], ['leak'])).toThrow('symlink_escape_post_task: "leak"')
    expect(() => scanNewSymlinks(base, [], ['leak'])).toThrow('symlink_escape_post_task: "leak"')
  })

  it('passes a link that stays inside, and a path the change deleted', () => {
    writeFileSync(join(base, 'src/auth/service.ts'), 'export {}\n')
    symlinkSync('service.ts', join(base, 'src/auth/alias.ts'))
    expect(() => scanNewSymlinks(base, ['src/auth/'], ['src/auth/alias.ts', 'src/auth/gone.ts'])).not.toThrow()
  })
})
