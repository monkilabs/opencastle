import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectRepoInfo, mergeStackIntoRepoInfo, formatRepoInfo, buildDetectedToolsSet } from './detect.js'
import type { StackConfig, RepoInfo } from './types.js'

// ── detectRepoInfo (filesystem-backed) ─────────────────────────

describe('detectRepoInfo', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencastle-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('detects npm from package-lock.json', async () => {
    await writeFile(join(tempDir, 'package-lock.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    expect(info.packageManager).toBe('npm')
  })

  it('detects pnpm from pnpm-lock.yaml', async () => {
    await writeFile(join(tempDir, 'pnpm-lock.yaml'), '')
    const info = await detectRepoInfo(tempDir)
    expect(info.packageManager).toBe('pnpm')
  })

  it('detects yarn from yarn.lock', async () => {
    await writeFile(join(tempDir, 'yarn.lock'), '')
    const info = await detectRepoInfo(tempDir)
    expect(info.packageManager).toBe('yarn')
  })

  it('detects TypeScript from tsconfig.json', async () => {
    await writeFile(join(tempDir, 'tsconfig.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    expect(info.language).toBe('typescript')
  })

  it('detects JavaScript from jsconfig.json', async () => {
    await writeFile(join(tempDir, 'jsconfig.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    expect(info.language).toBe('javascript')
  })

  it('detects Next.js from next.config.mjs', async () => {
    await writeFile(join(tempDir, 'next.config.mjs'), 'export default {}')
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks).toContain('next')
  })

  it('detects Astro from astro.config.mjs', async () => {
    await writeFile(join(tempDir, 'astro.config.mjs'), 'export default {}')
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks).toContain('astro')
  })

  it('detects NX monorepo from nx.json', async () => {
    await writeFile(join(tempDir, 'nx.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    expect(info.monorepo).toBe('nx')
  })

  it('detects Supabase from supabase/config.toml', async () => {
    await mkdir(join(tempDir, 'supabase'), { recursive: true })
    await writeFile(join(tempDir, 'supabase', 'config.toml'), '')
    const info = await detectRepoInfo(tempDir)
    expect(info.databases).toContain('supabase')
  })

  it('detects Prisma from prisma/schema.prisma', async () => {
    await mkdir(join(tempDir, 'prisma'), { recursive: true })
    await writeFile(join(tempDir, 'prisma', 'schema.prisma'), '')
    const info = await detectRepoInfo(tempDir)
    expect(info.databases).toContain('prisma')
  })

  it('detects Vercel from vercel.json', async () => {
    await writeFile(join(tempDir, 'vercel.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    expect(info.deployment).toContain('vercel')
  })

  it('detects Docker from Dockerfile', async () => {
    await writeFile(join(tempDir, 'Dockerfile'), 'FROM node:22')
    const info = await detectRepoInfo(tempDir)
    expect(info.deployment).toContain('docker')
  })

  it('detects Playwright from playwright.config.ts', async () => {
    await writeFile(join(tempDir, 'playwright.config.ts'), 'export default {}')
    const info = await detectRepoInfo(tempDir)
    expect(info.testing).toContain('playwright')
  })

  it('detects GitHub Actions from .github/workflows/', async () => {
    await mkdir(join(tempDir, '.github', 'workflows'), { recursive: true })
    const info = await detectRepoInfo(tempDir)
    expect(info.cicd).toContain('github-actions')
  })

  it('detects Tailwind from tailwind.config.js', async () => {
    await writeFile(join(tempDir, 'tailwind.config.js'), 'module.exports = {}')
    const info = await detectRepoInfo(tempDir)
    expect(info.styling).toContain('tailwind')
  })

  it('detects MCP config from .vscode/mcp.json', async () => {
    await mkdir(join(tempDir, '.vscode'), { recursive: true })
    await writeFile(join(tempDir, '.vscode', 'mcp.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    expect(info.mcpConfig).toBe(true)
  })

  it('detects packages from package.json dependencies', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14.0.0', '@supabase/supabase-js': '^2.0.0' },
        devDependencies: { vitest: '^1.0.0', tailwindcss: '^3.0.0' },
      })
    )
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks).toContain('next')
    expect(info.databases).toContain('supabase')
    expect(info.testing).toContain('vitest')
    expect(info.styling).toContain('tailwind')
  })

  it('detects corepack packageManager field', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@9.0.0' })
    )
    const info = await detectRepoInfo(tempDir)
    expect(info.packageManager).toBe('pnpm')
  })

  it('returns clean object for empty directory', async () => {
    const info = await detectRepoInfo(tempDir)
    expect(info).toBeDefined()
    // No undefined values — only populated fields
    for (const value of Object.values(info)) {
      expect(value).not.toBeUndefined()
    }
  })

  it('deduplicates config files', async () => {
    await writeFile(join(tempDir, 'package-lock.json'), '{}')
    await writeFile(join(tempDir, 'tsconfig.json'), '{}')
    const info = await detectRepoInfo(tempDir)
    const unique = new Set(info.configFiles)
    expect(info.configFiles?.length).toBe(unique.size)
  })

  it('sorts arrays for stable output', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '1', express: '1' },
      })
    )
    const info = await detectRepoInfo(tempDir)
    if (info.frameworks && info.frameworks.length > 1) {
      const sorted = [...info.frameworks].sort()
      expect(info.frameworks).toEqual(sorted)
    }
  })

  it('detects Sanity CMS from sanity.config.ts', async () => {
    await writeFile(join(tempDir, 'sanity.config.ts'), 'export default {}')
    const info = await detectRepoInfo(tempDir)
    expect(info.cms).toContain('sanity')
  })

  it('auto-adds supabase-auth when supabase is detected', async () => {
    await mkdir(join(tempDir, 'supabase'), { recursive: true })
    await writeFile(join(tempDir, 'supabase', 'config.toml'), '')
    const info = await detectRepoInfo(tempDir)
    expect(info.auth).toContain('supabase-auth')
  })

  it('detects multiple tools simultaneously', async () => {
    await writeFile(join(tempDir, 'next.config.mjs'), '')
    await writeFile(join(tempDir, 'vercel.json'), '{}')
    await writeFile(join(tempDir, 'tsconfig.json'), '{}')
    await writeFile(join(tempDir, 'tailwind.config.js'), '')
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks).toContain('next')
    expect(info.deployment).toContain('vercel')
    expect(info.language).toBe('typescript')
    expect(info.styling).toContain('tailwind')
  })
  it('detects tools from workspace package dependencies in NX monorepo', async () => {
    await writeFile(join(tempDir, 'nx.json'), '{}')
    await mkdir(join(tempDir, 'apps', 'web'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0', '@supabase/supabase-js': '^2.0.0' }
    }))
    await mkdir(join(tempDir, 'apps', 'studio'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'studio', 'package.json'), JSON.stringify({
      dependencies: { sanity: '^3.0.0' }
    }))
    const info = await detectRepoInfo(tempDir)
    expect(info.monorepo).toBe('nx')
    expect(info.frameworks).toContain('next')
    expect(info.databases).toContain('supabase')
    expect(info.cms).toContain('sanity')
  })

  it('detects config files in workspace package directories', async () => {
    await writeFile(join(tempDir, 'nx.json'), '{}')
    await mkdir(join(tempDir, 'apps', 'web'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'web', 'next.config.mjs'), 'export default {}')
    await mkdir(join(tempDir, 'apps', 'studio'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'studio', 'sanity.config.ts'), 'export default {}')
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks).toContain('next')
    expect(info.cms).toContain('sanity')
  })

  it('detects tools from pnpm workspace packages', async () => {
    await writeFile(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*')
    await writeFile(join(tempDir, 'pnpm-lock.yaml'), '')
    await mkdir(join(tempDir, 'apps', 'web'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0' }
    }))
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks).toContain('next')
  })

  it('does not duplicate tools found in both root and workspace packages', async () => {
    await writeFile(join(tempDir, 'nx.json'), '{}')
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0' }
    }))
    await mkdir(join(tempDir, 'apps', 'web'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0' }
    }))
    const info = await detectRepoInfo(tempDir)
    expect(info.frameworks?.filter(f => f === 'next')).toHaveLength(1)
  })

  it('detects a full monorepo stack (NX + Next.js + Sanity + Supabase + Vercel)', async () => {
    // Root level
    await writeFile(join(tempDir, 'nx.json'), '{}')
    await writeFile(join(tempDir, 'vercel.json'), '{}')
    await writeFile(join(tempDir, 'tsconfig.json'), '{}')
    await writeFile(join(tempDir, 'pnpm-lock.yaml'), '')

    // apps/web
    await mkdir(join(tempDir, 'apps', 'web'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'web', 'next.config.mjs'), 'export default {}')
    await writeFile(join(tempDir, 'apps', 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0', '@supabase/supabase-js': '^2.0.0' },
      devDependencies: { vitest: '^1.0.0' }
    }))

    // apps/studio
    await mkdir(join(tempDir, 'apps', 'studio'), { recursive: true })
    await writeFile(join(tempDir, 'apps', 'studio', 'sanity.config.ts'), 'export default {}')
    await writeFile(join(tempDir, 'apps', 'studio', 'package.json'), JSON.stringify({
      dependencies: { sanity: '^3.0.0' }
    }))

    // supabase dir at root
    await mkdir(join(tempDir, 'supabase'), { recursive: true })
    await writeFile(join(tempDir, 'supabase', 'config.toml'), '')

    const info = await detectRepoInfo(tempDir)

    expect(info.monorepo).toBe('nx')
    expect(info.packageManager).toBe('pnpm')
    expect(info.language).toBe('typescript')
    expect(info.frameworks).toContain('next')
    expect(info.databases).toContain('supabase')
    expect(info.cms).toContain('sanity')
    expect(info.deployment).toContain('vercel')
    expect(info.testing).toContain('vitest')
    expect(info.auth).toContain('supabase-auth')

    // Verify buildDetectedToolsSet correctly maps all detected tools
    const detected = buildDetectedToolsSet(info)
    expect(detected.has('nx')).toBe(true)
    expect(detected.has('nextjs')).toBe(true)
    expect(detected.has('sanity')).toBe(true)
    expect(detected.has('supabase')).toBe(true)
    expect(detected.has('vercel')).toBe(true)
    expect(detected.has('vitest')).toBe(true)
  })
})

// ── buildDetectedToolsSet ──────────────────────────────────────

describe('detectRepoInfo — Python and Go', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'opencastle-lang-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads a FastAPI service as Python with its framework, and no JavaScript package manager', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\n')
    const info = await detectRepoInfo(dir)
    expect(info.language).toBe('python')
    expect(info.frameworks).toEqual(['fastapi'])
    expect(info.packageManager).toBeUndefined()
  })

  it('reads a Go module with Gin', async () => {
    await writeFile(join(dir, 'go.mod'), 'module x\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n')
    const info = await detectRepoInfo(dir)
    expect(info.language).toBe('go')
    expect(info.frameworks).toEqual(['gin'])
  })

  it('keeps TypeScript for a project that has both', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{}')
    await writeFile(join(dir, 'requirements.txt'), 'flask\n')
    expect((await detectRepoInfo(dir)).language).toBe('typescript')
  })
})

describe('detectRepoInfo — code hosts', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'opencastle-host-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const gitConfig = async (gitDir: string, body: string): Promise<void> => {
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'config'), `[core]\n\tbare = false\n${body}`)
  }

  it('reads GitHub from an https remote, and a self-managed GitLab from an scp-style one', async () => {
    await gitConfig(join(dir, '.git'), '[remote "origin"]\n\turl = https://github.com/acme/web.git\n')
    expect((await detectRepoInfo(dir)).codeHosts).toEqual(['github'])
    await gitConfig(join(dir, '.git'), '[remote "origin"]\n\turl = git@gitlab.acme.example:web/app.git\n')
    expect((await detectRepoInfo(dir)).codeHosts).toEqual(['gitlab'])
  })

  it('ignores a submodule hosted elsewhere', async () => {
    await gitConfig(join(dir, '.git'), [
      '[remote "origin"]', '\turl = https://gitlab.com/acme/web.git',
      '[submodule "vendor/lib"]', '\turl = https://github.com/someone/lib.git', '',
    ].join('\n'))
    expect((await detectRepoInfo(dir)).codeHosts).toEqual(['gitlab'])
  })

  it('follows a worktree to the main repository’s remotes', async () => {
    const main = join(dir, 'main', '.git')
    await gitConfig(main, '[remote "origin"]\n\turl = ssh://git@github.com/acme/web.git\n')
    await mkdir(join(main, 'worktrees', 'feature'), { recursive: true })
    await writeFile(join(main, 'worktrees', 'feature', 'commondir'), '../..\n')
    await mkdir(join(dir, 'feature'))
    await writeFile(join(dir, 'feature', '.git'), `gitdir: ${join(main, 'worktrees', 'feature')}\n`)
    expect((await detectRepoInfo(join(dir, 'feature'))).codeHosts).toEqual(['github'])
  })

  it('reads the remote of the repository a monorepo package sits in', async () => {
    await gitConfig(join(dir, '.git'), '[remote "origin"]\n\turl = https://gitlab.com/acme/platform.git\n')
    await mkdir(join(dir, 'apps', 'web'), { recursive: true })
    expect((await detectRepoInfo(join(dir, 'apps', 'web'))).codeHosts).toEqual(['gitlab'])
  })

  it('falls back to files only a code host reads, without a remote', async () => {
    await writeFile(join(dir, '.gitlab-ci.yml'), 'test:\n  script: npm test\n')
    const info = await detectRepoInfo(dir)
    expect(info.codeHosts).toEqual(['gitlab'])
    expect(buildDetectedToolsSet(info).has('gitlab')).toBe(true)

    await rm(join(dir, '.gitlab-ci.yml'))
    await mkdir(join(dir, '.github'))
    await writeFile(join(dir, '.github', 'dependabot.yml'), 'version: 2\n')
    expect((await detectRepoInfo(dir)).codeHosts).toEqual(['github'])
  })

  it('does not read VS Code’s Copilot files as GitHub', async () => {
    // This tool writes them for every VS Code target, wherever the code is hosted.
    await mkdir(join(dir, '.github', 'agents'), { recursive: true })
    await mkdir(join(dir, '.github', 'prompts'))
    await writeFile(join(dir, '.github', 'copilot-instructions.md'), '# Copilot\n')
    await writeFile(join(dir, '.github', 'agents', 'developer.agent.md'), '---\n---\n')
    expect((await detectRepoInfo(dir)).codeHosts).toBeUndefined()
  })

  it.each([
    ['github:acme/web', 'github'],
    ['acme/web', 'github'],
    ['gitlab:acme/web', 'gitlab'],
    [{ type: 'git', url: 'git+https://gitlab.com/acme/web.git' }, 'gitlab'],
    [{ type: 'git', url: 'git+ssh://git@github.com/acme/web.git' }, 'github'],
  ])('reads %j in package.json as %s', async (repository, host) => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'web', repository }))
    expect((await detectRepoInfo(dir)).codeHosts).toEqual([host])
  })

  it('reads a Go module path, and an SDK for one host', async () => {
    await writeFile(join(dir, 'go.mod'), 'module gitlab.com/acme/svc\n\ngo 1.22\n')
    expect((await detectRepoInfo(dir)).codeHosts).toEqual(['gitlab'])
    await rm(join(dir, 'go.mod'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'bot', dependencies: { '@octokit/rest': '^21.0.0' } }))
    expect((await detectRepoInfo(dir)).codeHosts).toEqual(['github'])
  })

  it('finds no host for a repository without a remote', async () => {
    await gitConfig(join(dir, '.git'), '')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'web', repository: 'bitbucket:acme/web' }))
    expect((await detectRepoInfo(dir)).codeHosts).toBeUndefined()
  })
})

describe('buildDetectedToolsSet', () => {
  it('maps detection labels to plugin IDs', () => {
    const set = buildDetectedToolsSet({
      cms: ['sanity'],
      databases: ['supabase'],
      deployment: ['vercel'],
      monorepo: 'nx',
      frameworks: ['next'],
      testing: ['vitest'],
    })
    expect(set.has('sanity')).toBe(true)
    expect(set.has('supabase')).toBe(true)
    expect(set.has('vercel')).toBe(true)
    expect(set.has('nx')).toBe(true)
    expect(set.has('nextjs')).toBe(true)
    expect(set.has('vitest')).toBe(true)
  })

  it('handles empty repoInfo', () => {
    const set = buildDetectedToolsSet({})
    expect(set.size).toBe(0)
  })

  it('maps next to nextjs but leaves astro as-is', () => {
    const set = buildDetectedToolsSet({ frameworks: ['next', 'astro'] })
    expect(set.has('nextjs')).toBe(true)
    expect(set.has('next')).toBe(false)
    expect(set.has('astro')).toBe(true)
  })
})

// ── mergeStackIntoRepoInfo ─────────────────────────────────────

describe('mergeStackIntoRepoInfo', () => {
  const emptyStack: StackConfig = { ides: [], techTools: [], teamTools: [] }

  it('returns original info when stack is empty', () => {
    const info: RepoInfo = { language: 'typescript' }
    const merged = mergeStackIntoRepoInfo(info, emptyStack)
    expect(merged.language).toBe('typescript')
  })

  it('adds CMS tools from techTools', () => {
    const merged = mergeStackIntoRepoInfo(
      {},
      { ides: [], techTools: ['sanity'], teamTools: [] }
    )
    expect(merged.cms).toContain('sanity')
  })

  it('adds database tools from techTools', () => {
    const merged = mergeStackIntoRepoInfo(
      {},
      { ides: [], techTools: ['supabase'], teamTools: [] }
    )
    expect(merged.databases).toContain('supabase')
  })

  it('adds deployment tools from techTools', () => {
    const merged = mergeStackIntoRepoInfo(
      {},
      { ides: [], techTools: ['vercel'], teamTools: [] }
    )
    expect(merged.deployment).toContain('vercel')
  })

  it('sets NX monorepo from techTools', () => {
    const merged = mergeStackIntoRepoInfo(
      {},
      { ides: [], techTools: ['nx'], teamTools: [] }
    )
    expect(merged.monorepo).toBe('nx')
  })

  it('does not overwrite existing monorepo with NX', () => {
    const merged = mergeStackIntoRepoInfo(
      { monorepo: 'turborepo' },
      { ides: [], techTools: ['nx'], teamTools: [] }
    )
    expect(merged.monorepo).toBe('turborepo')
  })

  it('adds PM tools from teamTools', () => {
    const merged = mergeStackIntoRepoInfo(
      {},
      { ides: [], techTools: [], teamTools: ['linear'] }
    )
    expect(merged.pm).toContain('linear')
  })

  it('adds notification tools from teamTools', () => {
    const merged = mergeStackIntoRepoInfo(
      {},
      { ides: [], techTools: [], teamTools: ['slack'] }
    )
    expect(merged.notifications).toContain('slack')
  })

  it('deduplicates when tool already exists', () => {
    const merged = mergeStackIntoRepoInfo(
      { cms: ['sanity'] },
      { ides: [], techTools: ['sanity'], teamTools: [] }
    )
    expect(merged.cms).toEqual(['sanity'])
  })

  it('preserves existing values while adding new ones', () => {
    const merged = mergeStackIntoRepoInfo(
      { databases: ['prisma'], language: 'typescript' },
      { ides: [], techTools: ['supabase'], teamTools: ['linear'] }
    )
    expect(merged.databases).toContain('prisma')
    expect(merged.databases).toContain('supabase')
    expect(merged.language).toBe('typescript')
    expect(merged.pm).toContain('linear')
  })
})

// ── formatRepoInfo ─────────────────────────────────────────────

describe('formatRepoInfo', () => {
  it('formats empty info as empty string', () => {
    expect(formatRepoInfo({})).toBe('')
  })

  it('includes package manager', () => {
    const output = formatRepoInfo({ packageManager: 'pnpm' })
    expect(output).toContain('pnpm')
  })

  it('includes frameworks', () => {
    const output = formatRepoInfo({ frameworks: ['next', 'astro'] })
    expect(output).toContain('next')
    expect(output).toContain('astro')
  })

  it('includes all populated fields', () => {
    const output = formatRepoInfo({
      packageManager: 'npm',
      monorepo: 'nx',
      language: 'typescript',
      frameworks: ['next'],
      databases: ['supabase'],
      cms: ['sanity'],
      deployment: ['vercel'],
      testing: ['vitest'],
      cicd: ['github-actions'],
      styling: ['tailwind'],
      auth: ['clerk'],
    })
    expect(output).toContain('npm')
    expect(output).toContain('nx')
    expect(output).toContain('typescript')
    expect(output).toContain('next')
    expect(output).toContain('supabase')
    expect(output).toContain('sanity')
    expect(output).toContain('vercel')
    expect(output).toContain('vitest')
    expect(output).toContain('github-actions')
    expect(output).toContain('tailwind')
    expect(output).toContain('clerk')
  })

  it('indents lines with 4 spaces', () => {
    const output = formatRepoInfo({ packageManager: 'npm' })
    expect(output).toMatch(/^ {4}/)
  })
})
