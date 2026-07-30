import { describe, it, expect } from 'vitest'
import {
  checkTDD,
  formatTDDFailure,
  DEFAULT_TDD_CONFIG,
  type TDDCheckResult,
} from './tdd-gate.js'
import type { TDDGateConfig } from './types.js'

const BASE_CONFIG: TDDGateConfig = { ...DEFAULT_TDD_CONFIG }

describe('checkTDD', () => {
  describe('disabled / skipped', () => {
    it('returns skipped when config.enabled is false', () => {
      const result = checkTDD(['src/foo.ts'], [], { ...BASE_CONFIG, enabled: false })
      expect(result.skipped).toBe(true)
      expect(result.skip_reason).toBe('disabled')
      expect(result.passed).toBe(true)
    })

    it('returns skipped for exempt agent', () => {
      const result = checkTDD(['src/foo.ts'], [], BASE_CONFIG, 'writer')
      expect(result.skipped).toBe(true)
      expect(result.skip_reason).toBe('exempt_agent')
      expect(result.passed).toBe(true)
    })

    it('returns skipped for all exempt agents', () => {
      for (const agent of ['writer', 'writer', 'writer', 'researcher']) {
        const result = checkTDD(['src/foo.ts'], [], BASE_CONFIG, agent)
        expect(result.skipped).toBe(true)
      }
    })

    it('does NOT skip for unknown agent', () => {
      const result = checkTDD(['src/foo.ts', 'src/foo.test.ts'], [], BASE_CONFIG, 'developer')
      expect(result.skipped).toBe(false)
    })
  })

  describe('exclude patterns', () => {
    it('excludes **/types.ts', () => {
      const result = checkTDD(['src/cli/convoy/types.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/cli/convoy/types.ts')
      expect(result.new_source_files).toHaveLength(0)
      expect(result.passed).toBe(true)
    })

    it('excludes **/index.ts', () => {
      const result = checkTDD(['src/index.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/index.ts')
      expect(result.passed).toBe(true)
    })

    it('excludes **/*.d.ts', () => {
      const result = checkTDD(['src/foo.d.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/foo.d.ts')
      expect(result.passed).toBe(true)
    })

    it('excludes **/constants.ts', () => {
      const result = checkTDD(['src/constants.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/constants.ts')
      expect(result.passed).toBe(true)
    })

    it('excludes **/schemas.ts', () => {
      const result = checkTDD(['src/schemas.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/schemas.ts')
      expect(result.passed).toBe(true)
    })
  })

  describe('test file self-exclusion', () => {
    it('excludes .test.ts files from source candidates', () => {
      const result = checkTDD(['src/foo.test.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/foo.test.ts')
      expect(result.new_source_files).toHaveLength(0)
      expect(result.passed).toBe(true)
    })

    it('excludes .spec.ts files from source candidates', () => {
      const result = checkTDD(['src/foo.spec.ts'], [], BASE_CONFIG)
      expect(result.excluded_files).toContain('src/foo.spec.ts')
      expect(result.passed).toBe(true)
    })
  })

  describe('block mode (default)', () => {
    it('passes when source file has test in changedFiles', () => {
      const result = checkTDD(['src/foo.ts', 'src/foo.test.ts'], [], BASE_CONFIG)
      expect(result.passed).toBe(true)
      expect(result.missing_test_files).toHaveLength(0)
      expect(result.existing_test_files).toContain('src/foo.ts')
    })

    it('blocks when source file has no test', () => {
      const result = checkTDD(['src/foo.ts'], [], BASE_CONFIG)
      expect(result.passed).toBe(false)
      expect(result.missing_test_files).toContain('src/foo.ts')
    })

    it('passes when test already exists in allFiles (not changedFiles)', () => {
      const result = checkTDD(['src/foo.ts'], ['src/foo.test.ts'], BASE_CONFIG)
      expect(result.passed).toBe(true)
      expect(result.existing_test_files).toContain('src/foo.ts')
    })

    it('recognizes .spec.ts as valid test file', () => {
      const result = checkTDD(['src/foo.ts', 'src/foo.spec.ts'], [], BASE_CONFIG)
      expect(result.passed).toBe(true)
      expect(result.existing_test_files).toContain('src/foo.ts')
    })

    it('handles multiple files, some with tests and some without', () => {
      const result = checkTDD(
        ['src/a.ts', 'src/b.ts', 'src/a.test.ts'],
        [],
        BASE_CONFIG,
      )
      expect(result.passed).toBe(false)
      expect(result.missing_test_files).toContain('src/b.ts')
      expect(result.existing_test_files).toContain('src/a.ts')
      expect(result.missing_test_files).not.toContain('src/a.ts')
    })

    it('passes when all source files have tests', () => {
      const result = checkTDD(
        ['src/a.ts', 'src/b.ts', 'src/a.test.ts', 'src/b.test.ts'],
        [],
        BASE_CONFIG,
      )
      expect(result.passed).toBe(true)
      expect(result.missing_test_files).toHaveLength(0)
    })
  })

  describe('warn mode', () => {
    const warnConfig: TDDGateConfig = { ...BASE_CONFIG, mode: 'warn' }

    it('passes even when test file is missing', () => {
      const result = checkTDD(['src/foo.ts'], [], warnConfig)
      expect(result.passed).toBe(true)
      expect(result.missing_test_files).toContain('src/foo.ts')
      expect(result.skipped).toBe(false)
    })

    it('still reports all missing test files', () => {
      const result = checkTDD(['src/a.ts', 'src/b.ts'], [], warnConfig)
      expect(result.passed).toBe(true)
      expect(result.missing_test_files).toHaveLength(2)
    })
  })

  describe('source pattern filtering', () => {
    it('ignores files not matching source_patterns', () => {
      const result = checkTDD(['README.md', 'package.json', '.gitignore'], [], BASE_CONFIG)
      expect(result.new_source_files).toHaveLength(0)
      expect(result.passed).toBe(true)
    })

    it('custom source_patterns work', () => {
      const config: TDDGateConfig = { ...BASE_CONFIG, source_patterns: ['lib/**/*.ts'] }
      const result = checkTDD(['lib/foo.ts'], [], config)
      expect(result.passed).toBe(false)
      expect(result.missing_test_files).toContain('lib/foo.ts')
    })
  })

  describe('nested file paths', () => {
    it('resolves test path correctly for deeply nested source file', () => {
      const result = checkTDD(
        ['src/cli/convoy/foo.ts', 'src/cli/convoy/foo.test.ts'],
        [],
        BASE_CONFIG,
      )
      expect(result.passed).toBe(true)
      expect(result.existing_test_files).toContain('src/cli/convoy/foo.ts')
    })

    it('resolves test path against allFiles for pre-existing test', () => {
      const result = checkTDD(
        ['src/cli/convoy/compaction.ts'],
        ['src/cli/convoy/compaction.test.ts'],
        BASE_CONFIG,
      )
      expect(result.passed).toBe(true)
    })

    it('blocks when nested source file has no test', () => {
      const result = checkTDD(['src/cli/convoy/artifacts.ts'], [], BASE_CONFIG)
      expect(result.passed).toBe(false)
      expect(result.missing_test_files).toContain('src/cli/convoy/artifacts.ts')
    })
  })

  describe('empty inputs', () => {
    it('passes with no changed files', () => {
      const result = checkTDD([], [], BASE_CONFIG)
      expect(result.passed).toBe(true)
      expect(result.new_source_files).toHaveLength(0)
    })

    it('passes with no changed files even with allFiles', () => {
      const result = checkTDD([], ['src/foo.ts', 'src/foo.test.ts'], BASE_CONFIG)
      expect(result.passed).toBe(true)
    })
  })
})

describe('formatTDDFailure', () => {
  it('returns success message when no missing test files', () => {
    const result: TDDCheckResult = {
      passed: true,
      new_source_files: ['src/foo.ts'],
      missing_test_files: [],
      existing_test_files: ['src/foo.ts'],
      excluded_files: [],
      skipped: false,
    }
    expect(formatTDDFailure(result)).toBe('TDD Gate: all source files have corresponding tests.')
  })

  it('formats missing file with correct test path', () => {
    const result: TDDCheckResult = {
      passed: false,
      new_source_files: ['src/cli/convoy/artifacts.ts'],
      missing_test_files: ['src/cli/convoy/artifacts.ts'],
      existing_test_files: [],
      excluded_files: [],
      skipped: false,
    }
    const output = formatTDDFailure(result)
    expect(output).toContain('TDD Gate BLOCKED: New source files without tests:')
    expect(output).toContain('src/cli/convoy/artifacts.ts → missing src/cli/convoy/artifacts.test.ts')
  })

  it('formats multiple missing files', () => {
    const result: TDDCheckResult = {
      passed: false,
      new_source_files: ['src/cli/convoy/artifacts.ts', 'src/cli/convoy/compaction.ts'],
      missing_test_files: ['src/cli/convoy/artifacts.ts', 'src/cli/convoy/compaction.ts'],
      existing_test_files: [],
      excluded_files: [],
      skipped: false,
    }
    const output = formatTDDFailure(result)
    expect(output).toContain('src/cli/convoy/artifacts.ts → missing src/cli/convoy/artifacts.test.ts')
    expect(output).toContain('src/cli/convoy/compaction.ts → missing src/cli/convoy/compaction.test.ts')
  })

  it('formats file without directory correctly', () => {
    const result: TDDCheckResult = {
      passed: false,
      new_source_files: ['foo.ts'],
      missing_test_files: ['foo.ts'],
      existing_test_files: [],
      excluded_files: [],
      skipped: false,
    }
    const output = formatTDDFailure(result)
    expect(output).toContain('foo.ts → missing foo.test.ts')
  })
})

describe('DEFAULT_TDD_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_TDD_CONFIG.enabled).toBe(true)
    expect(DEFAULT_TDD_CONFIG.mode).toBe('block')
    expect(DEFAULT_TDD_CONFIG.exempt_agents).toContain('writer')
    expect(DEFAULT_TDD_CONFIG.exempt_agents).toContain('writer')
    expect(DEFAULT_TDD_CONFIG.exempt_agents).toContain('writer')
    expect(DEFAULT_TDD_CONFIG.exempt_agents).toContain('researcher')
    expect(DEFAULT_TDD_CONFIG.source_patterns).toContain('src/**/*.ts')
    expect(DEFAULT_TDD_CONFIG.test_patterns).toContain('{name}.test.ts')
    expect(DEFAULT_TDD_CONFIG.test_patterns).toContain('{name}.spec.ts')
    expect(DEFAULT_TDD_CONFIG.exclude_patterns).toContain('**/types.ts')
    expect(DEFAULT_TDD_CONFIG.exclude_patterns).toContain('**/index.ts')
    expect(DEFAULT_TDD_CONFIG.exclude_patterns).toContain('**/*.d.ts')
  })
})
