import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  readVersion,
  listSkillDirs,
  generateManifest,
  generateEntryPoint,
  generateReadme,
  buildPluginPackage,
  parseArgs,
} from './package.js'
import { PLATFORM_CONFIGS, getSkillsForPlatform } from './package-config.js'

const pkgRoot = resolve(process.cwd())

describe('readVersion', () => {
  it('reads the correct version from package.json', () => {
    const version = readVersion(pkgRoot)
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('listSkillDirs', () => {
  it('returns skill directory names', () => {
    const skills = listSkillDirs(pkgRoot)
    expect(skills.length).toBeGreaterThan(0)
    expect(skills).toContain('react-development')
    expect(skills).toContain('testing-workflow')
  })
  it('returns only directory names (not paths)', () => {
    const skills = listSkillDirs(pkgRoot)
    expect(skills.every(s => !s.includes('/'))).toBe(true)
  })
})

describe('getSkillsForPlatform', () => {
  const allSkills = [
    'react-development', 'session-checkpoints', 'panel-majority-vote',
    'orchestration-protocols', 'team-lead-reference', 'testing-workflow',
    'decomposition', 'agent-memory', 'context-map', 'fast-review', 'memory-merger',
  ]

  it('returns all skills for claude-code (fewest exclusions)', () => {
    const skills = getSkillsForPlatform('claude-code', allSkills)
    expect(skills).toEqual(allSkills)
  })

  it('excludes session-checkpoints for cursor', () => {
    const skills = getSkillsForPlatform('cursor', allSkills)
    expect(skills).not.toContain('session-checkpoints')
    expect(skills).toContain('react-development')
  })

  it('excludes team-lead skills from opencode', () => {
    const skills = getSkillsForPlatform('opencode', allSkills)
    expect(skills).not.toContain('session-checkpoints')
    expect(skills).not.toContain('panel-majority-vote')
    expect(skills).not.toContain('orchestration-protocols')
    expect(skills).not.toContain('team-lead-reference')
    expect(skills).not.toContain('decomposition')
    expect(skills).not.toContain('agent-memory')
    expect(skills).not.toContain('context-map')
    expect(skills).not.toContain('fast-review')
    expect(skills).not.toContain('memory-merger')
    expect(skills).toContain('react-development')
    expect(skills).toContain('testing-workflow')
  })

  it('excludes team-lead skills from gemini', () => {
    const skills = getSkillsForPlatform('gemini', allSkills)
    expect(skills).not.toContain('session-checkpoints')
    expect(skills).not.toContain('orchestration-protocols')
  })

  it('returns all skills for unknown platform', () => {
    const skills = getSkillsForPlatform('unknown-platform', allSkills)
    expect(skills).toEqual(allSkills)
  })
})

describe('generateManifest', () => {
  const skills = ['react-development', 'testing-workflow']
  const agents = ['developer', 'reviewer']
  const version = '0.31.6'

  it('generates correct structure for claude-code', () => {
    const m = generateManifest('claude-code', version, skills, agents) as Record<string, unknown>
    expect(m.name).toBe('opencastle')
    expect(m.version).toBe(version)
    expect(m.skills).toEqual(skills)
    expect(m.agents).toEqual(agents)
    expect(m.hooks).toEqual(['SessionStart'])
  })

  it('generates correct structure for cursor', () => {
    const m = generateManifest('cursor', version, skills, agents) as Record<string, unknown>
    expect(m.name).toBe('opencastle')
    expect(m.version).toBe(version)
    expect(m.hooks).toBeUndefined()
    expect(m.type).toBeUndefined()
  })

  it('generates correct structure for opencode', () => {
    const m = generateManifest('opencode', version, skills, agents) as Record<string, unknown>
    expect(m.name).toBe('opencastle')
    expect(m.version).toBe(version)
    expect(m.type).toBeUndefined()
  })

  it('generates correct structure for gemini (includes type: extension)', () => {
    const m = generateManifest('gemini', version, skills, agents) as Record<string, unknown>
    expect(m.name).toBe('opencastle')
    expect(m.version).toBe(version)
    expect(m.type).toBe('extension')
  })

  it('includes version from package.json', () => {
    const ver = readVersion(pkgRoot)
    const m = generateManifest('cursor', ver, skills, agents) as Record<string, unknown>
    expect(m.version).toBe(ver)
  })
})

describe('generateEntryPoint', () => {
  const skills = ['react-development', 'testing-workflow']
  const version = '1.0.0'

  it('generates CLAUDE.md content for claude-code', () => {
    const ep = generateEntryPoint('claude-code', version, skills)
    expect(ep).toContain('OpenCastle v' + version)
    expect(ep).toContain('react-development')
    expect(ep).toContain('Claude Code')
  })

  it('generates .cursorrules content for cursor', () => {
    const ep = generateEntryPoint('cursor', version, skills)
    expect(ep).toContain('OpenCastle v' + version)
    expect(ep).toContain('Cursor')
    expect(ep).toContain('react-development')
  })

  it('generates OPENCODE.md content for opencode', () => {
    const ep = generateEntryPoint('opencode', version, skills)
    expect(ep).toContain('OpenCastle v' + version)
    expect(ep).toContain('react-development')
  })

  it('generates GEMINI.md content for gemini', () => {
    const ep = generateEntryPoint('gemini', version, skills)
    expect(ep).toContain('OpenCastle v' + version)
    expect(ep).toContain('react-development')
  })
})

describe('generateReadme', () => {
  it('contains installation instructions', () => {
    const readme = generateReadme('claude-code', '1.0.0')
    expect(readme).toContain('Installation')
    expect(readme).toContain('Claude Code')
    expect(readme).toContain('1.0.0')
  })

  it('references the correct entry point', () => {
    const readme = generateReadme('cursor', '1.0.0')
    expect(readme).toContain('.cursorrules')
  })
})

describe('PLATFORM_CONFIGS', () => {
  it('has configs for all 4 platforms', () => {
    expect(PLATFORM_CONFIGS).toHaveProperty('claude-code')
    expect(PLATFORM_CONFIGS).toHaveProperty('cursor')
    expect(PLATFORM_CONFIGS).toHaveProperty('opencode')
    expect(PLATFORM_CONFIGS).toHaveProperty('gemini')
  })

  it('each platform config has required fields', () => {
    for (const [, config] of Object.entries(PLATFORM_CONFIGS)) {
      expect(config.outputDir).toBeTruthy()
      expect(config.manifestFile).toBeTruthy()
      expect(config.entryPoint).toBeTruthy()
      expect(Array.isArray(config.includedDirs)).toBe(true)
      expect(config.includedDirs.length).toBeGreaterThan(0)
    }
  })

  it('gemini uses gemini-extension.json manifest', () => {
    expect(PLATFORM_CONFIGS.gemini.manifestFile).toBe('gemini-extension.json')
  })

  it('cursor uses .cursorrules entry point', () => {
    expect(PLATFORM_CONFIGS.cursor.entryPoint).toBe('.cursorrules')
  })
})

describe('buildPluginPackage', () => {
  it('creates correct directory structure for claude-code', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'oc-test-'))
    try {
      const result = buildPluginPackage(pkgRoot, 'claude-code', tmpDir)
      expect(result.platform).toBe('claude-code')
      expect(result.skillCount).toBeGreaterThan(0)
      expect(result.agentCount).toBeGreaterThan(0)
      expect(existsSync(join(result.outputDir, 'manifest.json'))).toBe(true)
      expect(existsSync(join(result.outputDir, 'CLAUDE.md'))).toBe(true)
      expect(existsSync(join(result.outputDir, 'README.md'))).toBe(true)
      expect(existsSync(join(result.outputDir, 'skills'))).toBe(true)
      expect(existsSync(join(result.outputDir, 'agents'))).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('respects platform skill filtering for gemini', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'oc-test-'))
    try {
      const result = buildPluginPackage(pkgRoot, 'gemini', tmpDir)
      expect(existsSync(join(result.outputDir, 'skills', 'session-checkpoints'))).toBe(false)
      expect(existsSync(join(result.outputDir, 'skills', 'react-development'))).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws for unknown platform', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'oc-test-'))
    try {
      expect(() => buildPluginPackage(pkgRoot, 'unknown-platform', tmpDir)).toThrow()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('parseArgs', () => {
  it('parses --platform flag', () => {
    const opts = parseArgs(['--platform', 'cursor'])
    expect(opts.platform).toBe('cursor')
    expect(opts.all).toBe(false)
  })

  it('parses -p shorthand', () => {
    const opts = parseArgs(['-p', 'gemini'])
    expect(opts.platform).toBe('gemini')
  })

  it('parses --all flag', () => {
    const opts = parseArgs(['--all'])
    expect(opts.all).toBe(true)
  })

  it('parses --output flag', () => {
    const opts = parseArgs(['--output', '/tmp/out'])
    expect(opts.output).toBe('/tmp/out')
  })

  it('parses -o shorthand', () => {
    const opts = parseArgs(['-o', '/tmp/out'])
    expect(opts.output).toBe('/tmp/out')
  })

  it('parses --help flag', () => {
    const opts = parseArgs(['--help'])
    expect(opts.help).toBe(true)
  })

  it('returns defaults for empty args', () => {
    const opts = parseArgs([])
    expect(opts.platform).toBeNull()
    expect(opts.all).toBe(false)
    expect(opts.output).toBe('dist/plugins')
    expect(opts.help).toBe(false)
  })
})
