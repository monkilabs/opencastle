import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Stats } from 'node:fs'

// ── Mock node:fs so all tests run without touching disk ───────────────────────
// The spy-per-test pattern (afterEach restoreAllMocks) keeps tests isolated.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    realpathSync: vi.fn(),
    lstatSync: vi.fn(),
  }
})

// Import after vi.mock so we receive the mocked module
import * as fs from 'node:fs'
import {
  normalizePath,
  pathsOverlap,
  validateFilePartitions,
  determineFsCaseSensitivity,
  scanSymlinks,
  scanNewSymlinks,
} from './partition.js'
import type { Task } from './spec-types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(id: string, files: string[], depends_on: string[] = []): Task {
  return {
    id,
    prompt: `Prompt for ${id}`,
    agent: 'developer',
    timeout: '30s',
    depends_on,
    files,
    description: '',
    max_retries: 0,
  }
}

function makeFakeStats(isSymlink: boolean, ino = 1): Stats {
  return {
    isSymbolicLink: () => isSymlink,
    ino,
  } as unknown as Stats
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── normalizePath ─────────────────────────────────────────────────────────────

describe('normalizePath', () => {
  it('strips leading ./', () => {
    expect(normalizePath('./src/auth/')).toBe('src/auth/')
  })

  it('strips multiple leading ./', () => {
    expect(normalizePath('././src/auth/service.ts')).toBe('src/auth/service.ts')
  })

  it('strips leading /', () => {
    expect(normalizePath('/src/auth/service.ts')).toBe('src/auth/service.ts')
  })

  it('replaces backslashes with forward slashes', () => {
    expect(normalizePath('src\\auth\\service.ts')).toBe('src/auth/service.ts')
  })

  it('throws for paths containing .. segments (resolves within root)', () => {
    expect(() => normalizePath('src/auth/../lib/index.ts')).toThrow('Path traversal detected')
  })

  it('resolves . segments', () => {
    expect(normalizePath('src/./auth/./service.ts')).toBe('src/auth/service.ts')
  })

  it('preserves trailing slash for directories', () => {
    expect(normalizePath('src/auth/')).toBe('src/auth/')
  })

  it('preserves trailing slash after stripping leading ./', () => {
    expect(normalizePath('./src/auth/')).toBe('src/auth/')
  })

  it('does not add trailing slash for files', () => {
    expect(normalizePath('src/auth/service.ts')).toBe('src/auth/service.ts')
  })

  it('handles backslash-terminated paths as directories', () => {
    expect(normalizePath('src\\auth\\')).toBe('src/auth/')
  })

  it('throws for paths containing .. segments via backslash', () => {
    expect(() => normalizePath('src\\auth\\..\\lib\\')).toThrow('Path traversal detected')
  })

  it('throws for paths containing * glob', () => {
    expect(() => normalizePath('src/**/*.ts')).toThrow(
      'Glob patterns are not allowed in file paths: "src/**/*.ts"',
    )
  })

  it('throws for paths containing ? glob', () => {
    expect(() => normalizePath('src/auth?.ts')).toThrow(
      'Glob patterns are not allowed in file paths: "src/auth?.ts"',
    )
  })

  it('throws for path starting with ..', () => {
    expect(() => normalizePath('../etc/passwd')).toThrow('Path traversal detected')
  })

  it('throws for path with escaping .. segments', () => {
    expect(() => normalizePath('foo/../../bar')).toThrow('Path traversal detected')
  })

  it('throws for path with non-escaping .. segment', () => {
    expect(() => normalizePath('foo/../bar')).toThrow('Path traversal detected')
  })

  it('does not throw for relative path starting with ./', () => {
    expect(() => normalizePath('./foo/bar')).not.toThrow()
    expect(normalizePath('./foo/bar')).toBe('foo/bar')
  })

  it('does not throw for plain relative path', () => {
    expect(() => normalizePath('foo/bar')).not.toThrow()
    expect(normalizePath('foo/bar')).toBe('foo/bar')
  })
})

// ── pathsOverlap ──────────────────────────────────────────────────────────────

describe('pathsOverlap', () => {
  it('exact match returns true', () => {
    expect(pathsOverlap('src/auth/service.ts', 'src/auth/service.ts')).toBe(true)
  })

  it('directory prefix overlaps its child file (a is prefix of b)', () => {
    expect(pathsOverlap('src/auth/', 'src/auth/service.ts')).toBe(true)
  })

  it('directory prefix overlaps its child file (b is prefix of a)', () => {
    expect(pathsOverlap('src/auth/service.ts', 'src/auth/')).toBe(true)
  })

  it('non-trailing-slash directory prefix overlaps its child file', () => {
    expect(pathsOverlap('src/auth', 'src/auth/service.ts')).toBe(true)
  })

  it('child file overlaps non-trailing-slash directory prefix', () => {
    expect(pathsOverlap('src/auth/service.ts', 'src/auth')).toBe(true)
  })

  it('sibling directories do not overlap', () => {
    expect(pathsOverlap('src/auth/', 'src/billing/')).toBe(false)
  })

  it('prefix without slash does not match different directory with same prefix', () => {
    // 'src/auth' should NOT overlap 'src/auth-utils/' (different dir)
    expect(pathsOverlap('src/auth', 'src/auth-utils/')).toBe(false)
  })

  it('completely different paths do not overlap', () => {
    expect(pathsOverlap('src/auth/service.ts', 'src/billing/invoice.ts')).toBe(false)
  })

  it('nested directory overlaps parent', () => {
    expect(pathsOverlap('src/', 'src/auth/service.ts')).toBe(true)
  })

  it('same file in different directories does not overlap', () => {
    expect(pathsOverlap('src/auth/index.ts', 'src/billing/index.ts')).toBe(false)
  })
})

// ── validateFilePartitions ────────────────────────────────────────────────────

describe('validateFilePartitions', () => {
  // Stub determineFsCaseSensitivity to always return true (case-sensitive)
  // so partition test results are deterministic regardless of the host OS.
  function stubCaseSensitive(): void {
    vi.mocked(fs.realpathSync).mockReturnValue('/tmp/probe' as unknown as string)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined as never)
    vi.mocked(fs.rmSync).mockReturnValue(undefined as never)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce(makeFakeStats(false, 100))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
  }

  it('returns valid when no overlap between parallel tasks', () => {
    stubCaseSensitive()
    const taskA = makeTask('a', ['src/auth/'])
    const taskB = makeTask('b', ['src/billing/'])
    const phases = [[taskA, taskB]]

    const result = validateFilePartitions([taskA, taskB], phases)

    expect(result.valid).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('returns conflict when parallel tasks have overlapping files', () => {
    stubCaseSensitive()
    const taskA = makeTask('a', ['src/auth/'])
    const taskB = makeTask('b', ['src/auth/service.ts'])
    const phases = [[taskA, taskB]]

    const result = validateFilePartitions([taskA, taskB], phases)

    expect(result.valid).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      phase: 0,
      taskA: 'a',
      taskB: 'b',
    })
    expect(result.conflicts[0].overlapping).toContain('src/auth/')
  })

  it('sequential tasks (different phases) with overlapping files are valid', () => {
    stubCaseSensitive()
    const taskA = makeTask('a', ['src/auth/'])
    const taskB = makeTask('b', ['src/auth/service.ts'], ['a'])
    // Phase 0: [taskA], Phase 1: [taskB]
    const phases = [[taskA], [taskB]]

    const result = validateFilePartitions([taskA, taskB], phases)

    expect(result.valid).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  it('returns valid when files arrays are empty', () => {
    stubCaseSensitive()
    const taskA = makeTask('a', [])
    const taskB = makeTask('b', [])
    const phases = [[taskA, taskB]]

    const result = validateFilePartitions([taskA, taskB], phases)

    expect(result.valid).toBe(true)
  })

  it('skips conflict check when one task has empty files array', () => {
    stubCaseSensitive()
    const taskA = makeTask('a', ['src/auth/'])
    const taskB = makeTask('b', [])
    const phases = [[taskA, taskB]]

    const result = validateFilePartitions([taskA, taskB], phases)

    expect(result.valid).toBe(true)
  })

  it('detects multiple conflicts across task pairs', () => {
    stubCaseSensitive()
    const taskA = makeTask('a', ['src/auth/', 'src/shared/'])
    const taskB = makeTask('b', ['src/auth/login.ts'])
    const taskC = makeTask('c', ['src/shared/utils.ts'])
    const phases = [[taskA, taskB, taskC]]

    const result = validateFilePartitions([taskA, taskB, taskC], phases)

    expect(result.valid).toBe(false)
    expect(result.conflicts).toHaveLength(2)
  })
})

// ── determineFsCaseSensitivity ────────────────────────────────────────────────

describe('determineFsCaseSensitivity', () => {
  it('returns true (case-sensitive) when stat throws for the lowercase path', () => {
    vi.mocked(fs.realpathSync).mockReturnValue('/private/tmp' as unknown as string)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined as never)
    vi.mocked(fs.rmSync).mockReturnValue(undefined as never)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce(makeFakeStats(false, 100)) // mixed-case file exists
      .mockImplementationOnce(() => {
        // lowercase path throws → case-sensitive filesystem
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

    expect(determineFsCaseSensitivity()).toBe(true)
  })

  it('returns false (case-insensitive) when stat returns the same inode for both cases', () => {
    vi.mocked(fs.realpathSync).mockReturnValue('/private/tmp' as unknown as string)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined as never)
    vi.mocked(fs.rmSync).mockReturnValue(undefined as never)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce(makeFakeStats(false, 42)) // mixed-case
      .mockReturnValueOnce(makeFakeStats(false, 42)) // lowercase — same inode

    expect(determineFsCaseSensitivity()).toBe(false)
  })

  it('calls rmSync in finally (cleanup) and returns true (safe default) when statSync throws unexpectedly', () => {
    vi.mocked(fs.realpathSync).mockReturnValue('/private/tmp' as unknown as string)
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined as never)
    vi.mocked(fs.rmSync).mockReturnValue(undefined as never)
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('unexpected disk error')
    })

    // The function handles errors gracefully: assumes case-sensitive (safe default)
    expect(determineFsCaseSensitivity()).toBe(true)
    // Cleanup always runs via finally
    expect(fs.rmSync).toHaveBeenCalled()
  })
})

// ── scanSymlinks ──────────────────────────────────────────────────────────────

describe('scanSymlinks', () => {
  const BASE = '/project/worktree'

  it('passes silently when no symlinks exist in files list', () => {
    vi.mocked(fs.realpathSync).mockReturnValue(BASE as unknown as string)
    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(false))

    expect(() => scanSymlinks(['src/auth/service.ts'], BASE)).not.toThrow()
  })

  it('passes when symlink resolves within the partition (safe symlink)', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce(BASE as unknown as string) // resolve(basePath)
      .mockReturnValueOnce(`${BASE}/src/auth/target.ts` as unknown as string) // symlink target

    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(true))

    expect(() => scanSymlinks(['src/auth/link.ts'], BASE)).not.toThrow()
  })

  it('throws symlink_escape when symlink resolves outside the partition', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce(BASE as unknown as string)
      .mockReturnValueOnce('/etc/passwd' as unknown as string) // escapes

    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(true))

    expect(() => scanSymlinks(['src/evil-link.ts'], BASE)).toThrow('symlink_escape')
  })

  it('skips files that do not exist yet (lstatSync throws)', () => {
    vi.mocked(fs.realpathSync).mockReturnValue(BASE as unknown as string)
    vi.mocked(fs.lstatSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    expect(() => scanSymlinks(['src/not-yet-created.ts'], BASE)).not.toThrow()
  })

  it('throws symlink_escape when realpathSync cannot resolve the symlink target', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce(BASE as unknown as string)
      .mockImplementationOnce(() => {
        throw new Error('broken symlink')
      })

    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(true))

    expect(() => scanSymlinks(['src/broken-link.ts'], BASE)).toThrow('symlink_escape')
  })
})

// ── scanNewSymlinks ───────────────────────────────────────────────────────────

describe('scanNewSymlinks', () => {
  const BASE = '/project/worktree'

  it('passes silently when no symlinks were created', () => {
    vi.mocked(fs.realpathSync).mockReturnValue(BASE as unknown as string)
    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(false))

    expect(() => scanNewSymlinks(BASE, ['src/auth/service.ts'])).not.toThrow()
  })

  it('passes when new symlink resolves within the worktree', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce(BASE as unknown as string)
      .mockReturnValueOnce(`${BASE}/src/auth/target.ts` as unknown as string)

    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(true))

    expect(() => scanNewSymlinks(BASE, ['src/auth/link.ts'])).not.toThrow()
  })

  it('throws symlink_escape_post_task when new symlink escapes worktree', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce(BASE as unknown as string)
      .mockReturnValueOnce('/home/attacker/secret' as unknown as string)

    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(true))

    expect(() => scanNewSymlinks(BASE, ['src/evil-link.ts'])).toThrow(
      'symlink_escape_post_task',
    )
  })

  it('throws symlink_escape_post_task when new symlink cannot be resolved', () => {
    vi.mocked(fs.realpathSync)
      .mockReturnValueOnce(BASE as unknown as string)
      .mockImplementationOnce(() => {
        throw new Error('broken symlink')
      })

    vi.mocked(fs.lstatSync).mockReturnValue(makeFakeStats(true))

    expect(() => scanNewSymlinks(BASE, ['src/new-broken-link.ts'])).toThrow(
      'symlink_escape_post_task',
    )
  })
})
