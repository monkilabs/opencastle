import { describe, it, expect, afterEach } from 'vitest';
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
  const saved = process.env.NO_COLOR;
  afterEach(() => {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  });

  it('wrap text in an SGR sequence by default', () => {
    delete process.env.NO_COLOR;
    expect(c.green('ok')).toBe('\x1B[32mok\x1B[0m');
  });

  it('are left out when NO_COLOR is set (no-color.org)', () => {
    process.env.NO_COLOR = '1';
    expect(c.green('ok')).toBe('ok');
    expect(c.bold(c.dim('x'))).toBe('x');
  });
});
