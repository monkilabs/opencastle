import { describe, it, expect } from 'vitest'
import { createProgress, firstLine, formatCost } from './progress.js'

function sink(isTTY: boolean, columns = 80) {
  const chunks: string[] = []
  return { chunks, stream: { isTTY, columns, write: (s: string) => { chunks.push(s); return true } } }
}

describe('createProgress', () => {
  it('prints plain lines and no status line when not a terminal', () => {
    const { chunks, stream } = sink(false)
    const p = createProgress({ stream })
    p.setStatus(() => '▸ a · 1/2 done')
    p.line('  ✓ [a]')
    p.stop()
    expect(chunks.join('')).toBe('  ✓ [a]\n')
  })

  it('redraws one status line in place under the permanent lines on a terminal', () => {
    const { chunks, stream } = sink(true)
    const p = createProgress({ stream })
    p.setStatus(() => '▸ a · 0/1 done')
    p.line('  ▶ [a] developer')
    p.stop()
    const out = chunks.join('')
    // The status is cleared before the permanent line, then drawn again under it.
    expect(out).toContain('\r\x1b[2K  ▶ [a] developer\n\r\x1b[2K▸ a · 0/1 done')
    expect(out.endsWith('\r\x1b[2K')).toBe(true)
  })

  it('keeps the status line within the terminal width', () => {
    const { chunks, stream } = sink(true, 30)
    const p = createProgress({ stream })
    p.setStatus(() => 'x'.repeat(200))
    p.stop()
    const drawn = chunks.find((c) => c.includes('x'))!
    expect(drawn.replace('\r\x1b[2K', '').length).toBeLessThanOrEqual(29)
  })
})

describe('helpers', () => {
  it('takes the first non-empty line of a reason', () => {
    expect(firstLine('\n  boom: it broke\nstack…')).toBe('boom: it broke')
  })

  it('marks estimated cost', () => {
    expect(formatCost(0.8412, true)).toBe('$0.84 (est.)')
    expect(formatCost(0.8412, false)).toBe('$0.84')
    expect(formatCost(null, true)).toBeNull()
  })
})
