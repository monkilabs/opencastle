import type { TDDGateConfig } from './types.js'

export type { TDDGateConfig }

export const DEFAULT_TDD_CONFIG: TDDGateConfig = {
  enabled: true,
  source_patterns: ['src/**/*.ts'],
  test_patterns: ['{name}.test.ts', '{name}.spec.ts'],
  exclude_patterns: [
    '**/types.ts',
    '**/index.ts',
    '**/*.d.ts',
    '**/constants.ts',
    '**/schemas.ts',
  ],
  mode: 'block',
  exempt_agents: ['writer', 'researcher'],
}

export interface TDDCheckResult {
  passed: boolean
  new_source_files: string[]
  missing_test_files: string[]
  existing_test_files: string[]
  excluded_files: string[]
  skipped: boolean
  skip_reason?: string
}

// ── Glob matching ─────────────────────────────────────────────────────────────

function matchGlob(pattern: string, filePath: string): boolean {
  const path = filePath.replace(/\\/g, '/')
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp('^' + regexStr + '$').test(path)
}

function isTestFile(filePath: string, testPatterns: string[]): boolean {
  const basename = filePath.split('/').pop() ?? ''
  return testPatterns.some(pattern => {
    const idx = pattern.indexOf('{name}')
    if (idx < 0) return false
    const prefix = pattern.slice(0, idx).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    const suffix = pattern.slice(idx + '{name}'.length).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    return new RegExp('^' + prefix + '[^/]+' + suffix + '$').test(basename)
  })
}

function resolveTestPaths(sourceFile: string, testPatterns: string[]): string[] {
  const lastSlash = sourceFile.lastIndexOf('/')
  const dir = lastSlash >= 0 ? sourceFile.slice(0, lastSlash) : ''
  const basename = lastSlash >= 0 ? sourceFile.slice(lastSlash + 1) : sourceFile
  const lastDot = basename.lastIndexOf('.')
  const nameWithoutExt = lastDot >= 0 ? basename.slice(0, lastDot) : basename

  return testPatterns.map(pattern => {
    const testBasename = pattern.replace('{name}', nameWithoutExt)
    return dir ? dir + '/' + testBasename : testBasename
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

export function checkTDD(
  changedFiles: string[],
  allFiles: string[],
  config: TDDGateConfig,
  agent?: string,
): TDDCheckResult {
  const empty: TDDCheckResult = {
    passed: true,
    new_source_files: [],
    missing_test_files: [],
    existing_test_files: [],
    excluded_files: [],
    skipped: false,
  }

  if (!config.enabled) {
    return { ...empty, skipped: true, skip_reason: 'disabled' }
  }

  if (agent !== undefined && config.exempt_agents.includes(agent)) {
    return { ...empty, skipped: true, skip_reason: 'exempt_agent' }
  }

  const allFileSet = new Set([...changedFiles, ...allFiles])

  // Filter to files matching source_patterns
  const sourceFiles = changedFiles.filter(f =>
    config.source_patterns.some(p => matchGlob(p, f)),
  )

  // Separate excluded vs candidate files
  const excluded: string[] = []
  const candidates: string[] = []
  for (const f of sourceFiles) {
    if (config.exclude_patterns.some(p => matchGlob(p, f))) {
      excluded.push(f)
      continue
    }
    if (isTestFile(f, config.test_patterns)) {
      excluded.push(f)
      continue
    }
    candidates.push(f)
  }

  // For each candidate, check for corresponding test
  const missingTestFiles: string[] = []
  const existingTestFiles: string[] = []

  for (const sourceFile of candidates) {
    const testPaths = resolveTestPaths(sourceFile, config.test_patterns)
    const hasTest = testPaths.some(tp => allFileSet.has(tp))
    if (hasTest) {
      existingTestFiles.push(sourceFile)
    } else {
      missingTestFiles.push(sourceFile)
    }
  }

  const passed = missingTestFiles.length === 0 || config.mode === 'warn'

  return {
    passed,
    new_source_files: candidates,
    missing_test_files: missingTestFiles,
    existing_test_files: existingTestFiles,
    excluded_files: excluded,
    skipped: false,
  }
}

export function formatTDDFailure(result: TDDCheckResult): string {
  if (result.missing_test_files.length === 0) {
    return 'TDD Gate: all source files have corresponding tests.'
  }
  const lines = ['TDD Gate BLOCKED: New source files without tests:']
  for (const sourceFile of result.missing_test_files) {
    const lastSlash = sourceFile.lastIndexOf('/')
    const dir = lastSlash >= 0 ? sourceFile.slice(0, lastSlash) : ''
    const basename = lastSlash >= 0 ? sourceFile.slice(lastSlash + 1) : sourceFile
    const lastDot = basename.lastIndexOf('.')
    const nameWithoutExt = lastDot >= 0 ? basename.slice(0, lastDot) : basename
    const testFile = (dir ? dir + '/' : '') + nameWithoutExt + '.test.ts'
    lines.push(`  - ${sourceFile} → missing ${testFile}`)
  }
  return lines.join('\n')
}
