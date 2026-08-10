/**
 * How `opencastle convoy` reads what you typed.
 *
 * The defect: the task was taken from the first argument alone, so an unquoted
 * request lost every word after the first. `opencastle convoy add rate limiting
 * to the API` planned a feature called "add", with no error, and went on to
 * spend a full PRD round-trip on it.
 */
import { describe, it, expect } from 'vitest'
import { positionalWords, splitTaskFlags } from './convoy-cmd.js'

describe('positionalWords', () => {
  it('keeps every word of an unquoted task', () => {
    expect(positionalWords(['add', 'rate', 'limiting', 'to', 'the', 'API'])).toEqual([
      'add',
      'rate',
      'limiting',
      'to',
      'the',
      'API',
    ])
  })

  it('keeps a quoted task as the single word it already is', () => {
    expect(positionalWords(['add rate limiting'])).toEqual(['add rate limiting'])
  })

  it('drops boolean flags wherever they appear', () => {
    expect(positionalWords(['--verbose', 'fix', 'the', 'bug', '--dry-run'])).toEqual([
      'fix',
      'the',
      'bug',
    ])
  })

  it('drops a flag value with its flag, so it cannot join the task', () => {
    // The failure this prevents: planning "fix the login bug codex".
    expect(positionalWords(['fix', 'the', 'login', 'bug', '--adapter', 'codex'])).toEqual([
      'fix',
      'the',
      'login',
      'bug',
    ])
  })

  it('handles a value-taking flag in front of the task', () => {
    expect(positionalWords(['-a', 'claude', 'ship', 'the', 'thing'])).toEqual([
      'ship',
      'the',
      'thing',
    ])
  })

  it('does not swallow a word after a boolean flag', () => {
    expect(positionalWords(['--verbose', 'ship'])).toEqual(['ship'])
  })

  it('returns nothing for a flags-only invocation', () => {
    expect(positionalWords(['--json'])).toEqual([])
  })

  it('treats a value that looks like a word as a value, not a task word', () => {
    expect(positionalWords(['--permission-mode', 'plan', 'do', 'work'])).toEqual(['do', 'work'])
  })
})

describe('the task the planner is given', () => {
  /** What the dispatcher passes to `pipeline` as `--text`. */
  const taskText = (args: string[]): string => positionalWords(args).join(' ')

  it('reassembles an unquoted request in order', () => {
    expect(taskText(['add', 'rate', 'limiting', 'to', 'the', 'API'])).toBe(
      'add rate limiting to the API',
    )
  })

  it('is identical for the quoted and unquoted forms of the same request', () => {
    expect(taskText(['add', 'rate', 'limiting'])).toBe(taskText(['add rate limiting']))
  })

  it('is unaffected by where the flags sit', () => {
    const want = 'refactor the auth module'
    expect(taskText(['refactor', 'the', 'auth', 'module', '--verbose'])).toBe(want)
    expect(taskText(['--verbose', 'refactor', 'the', 'auth', 'module'])).toBe(want)
    expect(taskText(['refactor', '--verbose', 'the', 'auth', 'module'])).toBe(want)
  })
})

describe('status words stay a status query', () => {
  /** The dispatcher's rule: a status word alone, with no other words after it. */
  const STATUS_WORDS = ['status', 'state', 'info', 'ls', 'list']
  const isStatusQuery = (args: string[]): boolean => {
    const words = positionalWords(args)
    return words.length === 1 && STATUS_WORDS.includes(words[0])
  }

  it('treats a bare status word as a status query', () => {
    for (const w of STATUS_WORDS) expect(isStatusQuery([w])).toBe(true)
  })

  it('still does so when flags accompany it', () => {
    expect(isStatusQuery(['status', '--json'])).toBe(true)
  })

  it('treats a status word that opens a sentence as a task', () => {
    // "status" alone means "where do things stand"; "status page for the admin"
    // is a feature, and planning it must not be hijacked.
    expect(isStatusQuery(['status', 'page', 'for', 'the', 'admin'])).toBe(false)
    expect(isStatusQuery(['list', 'all', 'users', 'in', 'the', 'dashboard'])).toBe(false)
  })
})

describe('splitTaskFlags', () => {
  it('forwards a flag the planner reads, with its value', () => {
    // The defect: --adapter was dropped, and the run used the auto-detected
    // adapter while saying nothing about it.
    expect(splitTaskFlags(['add', 'caching', '--adapter', 'codex'])).toEqual({
      forward: ['--adapter', 'codex'],
      unknown: [],
    })
  })

  it('forwards the short form and its value too', () => {
    expect(splitTaskFlags(['ship', '-a', 'claude']).forward).toEqual(['-a', 'claude'])
  })

  it('forwards boolean flags without eating the next word', () => {
    expect(splitTaskFlags(['ship', '--verbose', 'it']).forward).toEqual(['--verbose'])
  })

  it('reports a flag nobody on this path reads instead of dropping it', () => {
    // --json belongs to the status screen; forwarding it would earn an
    // "Unknown option" from the planner, and dropping it hid the mistake.
    expect(splitTaskFlags(['add', 'caching', '--json']).unknown).toEqual(['--json'])
  })

  it('reports a misspelled flag rather than running without it', () => {
    expect(splitTaskFlags(['add', 'caching', '--adaptr', 'codex']).unknown).toEqual(['--adaptr'])
  })

  it('does not mistake an unknown flag value for another unknown flag', () => {
    expect(splitTaskFlags(['x', '--report-dir', 'out']).unknown).toEqual(['--report-dir'])
  })

  it('forwards several flags at once, keeping order', () => {
    const { forward, unknown } = splitTaskFlags([
      'build', 'it', '--verbose', '--adapter', 'codex', '--skip-validation',
    ])
    expect(forward).toEqual(['--verbose', '--adapter', 'codex', '--skip-validation'])
    expect(unknown).toEqual([])
  })

  it('finds nothing to forward or refuse in a bare task', () => {
    expect(splitTaskFlags(['add', 'caching'])).toEqual({ forward: [], unknown: [] })
  })
})
