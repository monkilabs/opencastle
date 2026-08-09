import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { finishRun } from './run.js'

/**
 * A run has to stop when it is over.
 *
 * Five paths finish one — a fresh convoy, a fresh pipeline, a retry, a convoy
 * resume and a pipeline resume — and each spelled the ending out by hand. The
 * no-dashboard half ended in `process.exit`, which stops whether or not anyone
 * remembered to say so. The dashboard half only registered a SIGINT handler, and
 * four of the five then fell into the next block: `convoy run` executed the whole
 * spec on the engine and then a second time on the legacy executor, and
 * `--retry-failed` followed its retry with a full fresh run. Every task twice,
 * paid for twice, and only when a dashboard was up — which is why no test saw it.
 */

const repoRoot = join(import.meta.dirname, '..', '..')

function makeDashboard(): { server: { close: ReturnType<typeof vi.fn<() => void>> }; url: string } {
  return { server: { close: vi.fn<() => void>() }, url: 'http://localhost:4300' }
}

describe('finishRun', () => {
  let exit: ReturnType<typeof vi.spyOn>
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.removeAllListeners('SIGINT')
  })

  it('exits when there is no dashboard to keep alive', () => {
    finishRun(null, false)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits non-zero when the run failed', () => {
    finishRun(null, true)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('stays up for the dashboard instead of exiting', () => {
    const dashboard = makeDashboard()
    finishRun(dashboard, false)
    expect(exit).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join('\n')).toContain('Press Ctrl+C to stop')
  })

  it('carries the run exit code into Ctrl+C', () => {
    const dashboard = makeDashboard()
    finishRun(dashboard, true)
    process.emit('SIGINT')
    expect(dashboard.server.close).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('offers the retry hint only when the run failed', () => {
    finishRun(null, false, 'run it again')
    expect(log.mock.calls.flat().join('\n')).not.toContain('run it again')

    log.mockClear()
    finishRun(null, true, 'run it again')
    expect(log.mock.calls.flat().join('\n')).toContain('run it again')
  })

  it('offers the retry hint with a dashboard up too', () => {
    finishRun(makeDashboard(), true, 'run it again')
    expect(log.mock.calls.flat().join('\n')).toContain('run it again')
  })
})

describe('every path that finishes a run hands control back', () => {
  it('returns from each finishRun call rather than carrying on', () => {
    const src = readFileSync(join(repoRoot, 'src', 'cli', 'run.ts'), 'utf8')
    const calls = [...src.matchAll(/(\w+\s+)?finishRun\(/g)]
      .filter(m => m[1]?.trim() !== 'function')
    expect(calls.length, 'no call sites found — has the helper been renamed?').toBeGreaterThanOrEqual(5)

    const unreturned = calls
      .filter(m => m[1]?.trim() !== 'return')
      .map(m => src.slice(0, m.index).split('\n').length)
    expect(unreturned, `finishRun called without return at line(s): ${unreturned.join(', ')}`).toEqual([])
  })
})
