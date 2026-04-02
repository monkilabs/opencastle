---
name: vitest-testing
description: "Vitest unit and integration testing patterns, commands, mocking (vi.mock), and coverage. Use when writing .test.ts files, configuring the test runner, or adding coverage thresholds."
---

<!-- ⚠️ This file is managed by OpenCastle. Edits will be overwritten on update. Customize in the .opencastle/ directory instead. -->

# Vitest Testing

For project-specific test configuration, see [testing-config.md](../../.opencastle/stack/testing-config.md).

## Commands

```bash
npx vitest                         # Run in watch mode
npx vitest run                     # Run once (CI)
npx vitest run --coverage          # Run with coverage report
npx vitest run src/utils/          # Run specific directory
npx vitest run auth.test.ts        # Run specific file
npx vitest run -t "should validate"  # Filter by test name
npx vitest --ui                    # Open Vitest UI
npx vitest --reporter=json         # JSON output for CI
npx vitest typecheck               # Run type-checking tests
```

## Test Structure

### File Naming

```
src/
├── utils/
│   ├── format.ts
│   └── format.test.ts         # Co-located test
├── components/
│   ├── Button.tsx
│   └── Button.test.tsx        # Component test
└── __tests__/                 # Integration tests
    └── auth-flow.test.ts
```

### Writing Tests

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatPrice } from './format';

describe('formatPrice', () => {
  it('should format USD prices', () => {
    expect(formatPrice(9.99, 'USD')).toBe('$9.99');
  });

  it('should handle zero', () => {
    expect(formatPrice(0, 'USD')).toBe('$0.00');
  });

  it('should throw for negative values', () => {
    expect(() => formatPrice(-1, 'USD')).toThrow('Price cannot be negative');
  });
});
```

## Mocking

### Module Mocking

```typescript
import { vi, describe, it, expect } from 'vitest';

// Mock entire module
vi.mock('./database', () => ({
  getUser: vi.fn().mockResolvedValue({ id: '1', name: 'Alice' }),
}));

// Mock specific export
vi.mock('./config', async (importOriginal) => {
  const original = await importOriginal<typeof import('./config')>();
  return { ...original, API_URL: 'http://test-api.example.com' };
});
```

### Spy and Stub

```typescript
import { vi, describe, it, expect } from 'vitest';

describe('notifications', () => {
  it('should call the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }))
    );

    await sendNotification('Hello');

    expect(fetchSpy).toHaveBeenCalledWith('/api/notify', expect.objectContaining({
      method: 'POST',
    }));

    fetchSpy.mockRestore();
  });
});
```

### Timer Mocking

```typescript
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should debounce calls', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced();
    debounced();
    debounced();

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledOnce();
  });
});
```

## Configuration (vitest.config.ts)

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,                    // Use describe/it/expect without imports
    environment: 'jsdom',             // 'node' | 'jsdom' | 'happy-dom'
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

## Workflow

1. Create `*.test.ts` adjacent to the source file.
2. Write focused unit tests (happy path + edge cases). Use `vi.mock()` before imports; restore in `afterEach` with `vi.restoreAllMocks()`.
3. Run `npx vitest run <file>` — fix failures.
4. If tests fail: run `npx vitest run <file> --reporter=verbose` to inspect, fix, re-run.
5. Coverage validation: run `npx vitest run --coverage --reporter=json` (CI) or `npx vitest run --coverage --reporter=text` (local) to generate coverage reports. Inspect `coverage`/`coverage-final.json` or the human-readable summary to find uncovered files/branches. If coverage is below thresholds, add targeted tests for uncovered branches, then re-run `npx vitest run --coverage` until thresholds pass.
6. Commit tests alongside source changes.
