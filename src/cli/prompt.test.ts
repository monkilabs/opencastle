import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { computeVisibleWindow, c } from './prompt.js';

describe('computeVisibleWindow', () => {
  it('returns full range when all items fit', () => {
    expect(computeVisibleWindow(0, 5, 10)).toEqual({ start: 0, end: 5 });
  });

  it('keeps cursor visible at top', () => {
    const { start, end } = computeVisibleWindow(0, 20, 10);
    expect(start).toBeLessThanOrEqual(0);
    expect(end).toBeGreaterThan(0);
    expect(end - start).toBe(10);
  });

  it('keeps cursor visible at bottom', () => {
    const { start, end } = computeVisibleWindow(19, 20, 10);
    expect(start).toBeLessThanOrEqual(19);
    expect(end).toBeGreaterThanOrEqual(20);
    expect(end - start).toBe(10);
  });

  it('keeps cursor visible in middle', () => {
    const { start, end } = computeVisibleWindow(10, 20, 10);
    expect(start).toBeLessThanOrEqual(10);
    expect(end).toBeGreaterThan(10);
    expect(end - start).toBe(10);
  });

  it('handles cursor at exact boundary', () => {
    const { start, end } = computeVisibleWindow(9, 20, 10);
    expect(start).toBeLessThanOrEqual(9);
    expect(end).toBeGreaterThan(9);
  });

  it('window size never exceeds maxVisible', () => {
    for (let cursor = 0; cursor < 20; cursor++) {
      const { start, end } = computeVisibleWindow(cursor, 20, 10);
      expect(end - start).toBeLessThanOrEqual(10);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(20);
      expect(start).toBeLessThanOrEqual(cursor);
      expect(end).toBeGreaterThan(cursor);
    }
  });

  // Test that wrapping cursor (e.g. from 0 to 19 on arrow-up) stays visible
  it('handles wrap from first to last item', () => {
    const { start, end } = computeVisibleWindow(19, 20, 10);
    expect(start).toBeLessThanOrEqual(19);
    expect(end).toBe(20);
  });

  it('handles wrap from last to first item', () => {
    const { start, end } = computeVisibleWindow(0, 20, 10);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(0);
  });

  it('returns valid range for maxVisible of 3 (minimum)', () => {
    const { start, end } = computeVisibleWindow(10, 20, 3);
    expect(end - start).toBe(3);
    expect(start).toBeLessThanOrEqual(10);
    expect(end).toBeGreaterThan(10);
  });
});

describe('colours', () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, TERM: process.env.TERM }
  const tty = process.stdout.isTTY
  const setTty = (v: boolean | undefined) => Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true })
  beforeEach(() => {
    delete process.env.NO_COLOR
    delete process.env.FORCE_COLOR
    delete process.env.TERM
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    setTty(tty)
  })

  it('wrap text in an SGR sequence on a terminal', () => {
    setTty(true)
    expect(c.green('ok')).toBe('\x1B[32mok\x1B[0m')
  })

  it('are left out when output is piped or redirected', () => {
    setTty(false)
    expect(c.green('ok')).toBe('ok')
  })

  it('are left out on a terminal that says it cannot show them', () => {
    setTty(true)
    process.env.TERM = 'dumb'
    expect(c.green('ok')).toBe('ok')
  })

  it('are left out when NO_COLOR is set (no-color.org)', () => {
    setTty(true)
    process.env.NO_COLOR = '1'
    expect(c.green('ok')).toBe('ok')
    expect(c.bold(c.dim('x'))).toBe('x')
  })

  it('are put back anywhere by FORCE_COLOR', () => {
    setTty(false)
    process.env.FORCE_COLOR = '1'
    expect(c.green('ok')).toBe('\x1B[32mok\x1B[0m')
  })
});
