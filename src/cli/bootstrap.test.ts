/**
 * Tests for bootstrapCustomizations — validates programmatic population of
 * .opencastle/ template files from RepoInfo and package.json data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import type { StackConfig, RepoInfo } from './types.js'
import { bootstrapCustomizations } from './bootstrap.js'
import { copyDir, getOrchestratorRoot } from './copy.js'

// ── Helpers ────────────────────────────────────────────────────

/** The real package root — tests run against the actual source tree. */
const PKG_ROOT = resolve(import.meta.dirname, '../..')

const STACK_EMPTY: StackConfig = {
  ides: ['vscode'],
  techTools: [],
  teamTools: [],
}

/** Copy raw customization templates to <projectRoot>/.opencastle/ */
async function scaffoldTemplates(projectRoot: string): Promise<void> {
  const custSrcDir = resolve(getOrchestratorRoot(PKG_ROOT), 'customizations')
  const custDestDir = join(projectRoot, '.opencastle')
  await copyDir(custSrcDir, custDestDir)
}

// ═══════════════════════════════════════════════════════════════
// § Test suite
// ═══════════════════════════════════════════════════════════════

describe('bootstrapCustomizations', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bootstrap-test-'))
    await scaffoldTemplates(tempDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // ── 1. Tech stack table ──────────────────────────────────────

  it('populates project.instructions.md tech stack table from repoInfo', async () => {
    const info: RepoInfo = {
      language: 'typescript',
      frameworks: ['next'],
      testing: ['vitest'],
      deployment: ['vercel'],
    }
    await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    const content = await readFile(join(tempDir, '.opencastle', 'project.instructions.md'), 'utf8')
    expect(content).toContain('| Language | typescript |')
    expect(content).toContain('| Framework | next |')
    expect(content).toContain('| Testing | vitest |')
    expect(content).toContain('| Deployment | vercel |')
    // Empty placeholder row should be replaced
    expect(content).not.toContain('| | | | |')
  })

  // ── 2. Testing config ────────────────────────────────────────

  it('populates testing-config.md with test framework and config file', async () => {
    const info: RepoInfo = {
      testing: ['vitest'],
      configFiles: ['vitest.config.ts'],
    }
    await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    const content = await readFile(
      join(tempDir, '.opencastle', 'stack', 'testing-config.md'),
      'utf8',
    )
    expect(content).toContain('vitest')
    expect(content).toContain('`vitest.config.ts`')
  })

  // ── 3. Deployment config ─────────────────────────────────────

  it('populates deployment-config.md with deployment platform and config file', async () => {
    const info: RepoInfo = {
      deployment: ['vercel'],
      configFiles: ['vercel.json'],
    }
    await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    const content = await readFile(
      join(tempDir, '.opencastle', 'stack', 'deployment-config.md'),
      'utf8',
    )
    expect(content).toContain('vercel')
    expect(content).toContain('`vercel.json`')
  })

  // ── 4. Remove unused stack files ─────────────────────────────

  it('removes stack/database-config.md when no databases detected', async () => {
    await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(existsSync(join(tempDir, '.opencastle', 'stack', 'database-config.md'))).toBe(false)
  })

  it('removes stack/testing-config.md when no testing detected', async () => {
    await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(existsSync(join(tempDir, '.opencastle', 'stack', 'testing-config.md'))).toBe(false)
  })

  it('removes stack/deployment-config.md when no deployment detected', async () => {
    await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(existsSync(join(tempDir, '.opencastle', 'stack', 'deployment-config.md'))).toBe(false)
  })

  // ── 5. Rename database-config.md ────────────────────────────

  it('renames database-config.md to supabase-config.md when supabase detected', async () => {
    const info: RepoInfo = { databases: ['supabase'] }
    const result = await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    expect(
      existsSync(join(tempDir, '.opencastle', 'stack', 'supabase-config.md')),
    ).toBe(true)
    expect(
      existsSync(join(tempDir, '.opencastle', 'stack', 'database-config.md')),
    ).toBe(false)
    expect(result.renamed.some(r => r.includes('supabase-config.md'))).toBe(true)
  })

  // ── 6. Rename cms-config.md ──────────────────────────────────

  it('renames cms-config.md to sanity-config.md when sanity detected', async () => {
    const info: RepoInfo = { cms: ['sanity'] }
    const result = await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    expect(existsSync(join(tempDir, '.opencastle', 'stack', 'sanity-config.md'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencastle', 'stack', 'cms-config.md'))).toBe(false)
    expect(result.renamed.some(r => r.includes('sanity-config.md'))).toBe(true)
  })

  // ── 7. Project name and description ──────────────────────────

  it('fills project name and description from package.json', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'my-cool-project', description: 'A really cool project' }),
      'utf8',
    )
    await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project.instructions.md'),
      'utf8',
    )
    expect(content).toContain('**Project:** my-cool-project')
    expect(content).toContain('**Description:** A really cool project')
  })

  // ── 8. Key commands from scripts ─────────────────────────────

  it('populates key commands from package.json scripts', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'next dev', build: 'next build', test: 'vitest' },
      }),
      'utf8',
    )
    const info: RepoInfo = { packageManager: 'pnpm' }
    await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project.instructions.md'),
      'utf8',
    )
    expect(content).toContain('pnpm run dev')
    expect(content).toContain('pnpm run build')
    expect(content).toContain('pnpm run test')
  })

  // ── 9. Empty repoInfo ────────────────────────────────────────

  it('handles empty repoInfo gracefully without crashing', async () => {
    const result = await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(result).toBeDefined()
    expect(result.populated).toBeInstanceOf(Array)
    expect(result.removed).toBeInstanceOf(Array)
    expect(result.renamed).toBeInstanceOf(Array)
    // project.instructions.md should still exist and keep the empty row (no stack rows added)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project.instructions.md'),
      'utf8',
    )
    expect(content).toContain('| | | | |')
  })

  // ── 10. Monorepo workspace listing ────────────────────────────

  it('lists monorepo workspace packages in project structure table', async () => {
    await mkdir(join(tempDir, 'apps', 'web'), { recursive: true })
    await writeFile(
      join(tempDir, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: '@myproject/web', description: 'Main web app' }),
      'utf8',
    )
    await mkdir(join(tempDir, 'packages', 'ui'), { recursive: true })
    await writeFile(
      join(tempDir, 'packages', 'ui', 'package.json'),
      JSON.stringify({ name: '@myproject/ui', description: 'UI components' }),
      'utf8',
    )

    const info: RepoInfo = { monorepo: 'nx' }
    await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project.instructions.md'),
      'utf8',
    )
    expect(content).toContain('@myproject/web')
    expect(content).toContain('Main web app')
    expect(content).toContain('@myproject/ui')
    expect(content).toContain('UI components')
  })

  // ── 11. API config ───────────────────────────────────────────

  it('removes api-config.md when no frameworks detected', async () => {
    const result = await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(existsSync(join(tempDir, '.opencastle', 'stack', 'api-config.md'))).toBe(false)
    expect(result.removed).toContain('stack/api-config.md')
  })

  it('populates api-config.md with framework name when frameworks detected', async () => {
    const info: RepoInfo = { frameworks: ['next'] }
    const result = await bootstrapCustomizations(tempDir, info, STACK_EMPTY)
    const content = await readFile(
      join(tempDir, '.opencastle', 'stack', 'api-config.md'),
      'utf8',
    )
    expect(content).toContain('Framework: next')
    expect(result.populated).toContain('stack/api-config.md')
  })

  // ── 12. Data pipeline config ─────────────────────────────────

  it('always removes data-pipeline-config.md', async () => {
    const result = await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(
      existsSync(join(tempDir, '.opencastle', 'stack', 'data-pipeline-config.md')),
    ).toBe(false)
    expect(result.removed).toContain('stack/data-pipeline-config.md')
  })

  // ── 13. Tracker config ───────────────────────────────────────

  it('renames tracker-config.md to linear-config.md when linear in teamTools', async () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['linear'] }
    const result = await bootstrapCustomizations(tempDir, {}, stack)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'linear-config.md'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'tracker-config.md'))).toBe(false)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project', 'linear-config.md'),
      'utf8',
    )
    expect(content).toContain('# Linear Configuration')
    expect(content).not.toContain('# Task Tracker Configuration')
    expect(result.renamed.some(r => r.includes('linear-config.md'))).toBe(true)
  })

  it('renames tracker-config.md to jira-config.md when jira in teamTools', async () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['jira'] }
    const result = await bootstrapCustomizations(tempDir, {}, stack)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'jira-config.md'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'tracker-config.md'))).toBe(false)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project', 'jira-config.md'),
      'utf8',
    )
    expect(content).toContain('# Jira Configuration')
    expect(result.renamed.some(r => r.includes('jira-config.md'))).toBe(true)
  })

  it('renames tracker-config.md to trello-config.md when trello in teamTools', async () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['trello'] }
    const result = await bootstrapCustomizations(tempDir, {}, stack)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'trello-config.md'))).toBe(true)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'tracker-config.md'))).toBe(false)
    const content = await readFile(
      join(tempDir, '.opencastle', 'project', 'trello-config.md'),
      'utf8',
    )
    expect(content).toContain('# Trello Configuration')
    expect(result.renamed.some(r => r.includes('trello-config.md'))).toBe(true)
  })

  it('does not treat notion as a tracker and removes tracker-config.md', async () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['notion'] }
    const result = await bootstrapCustomizations(tempDir, {}, stack)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'tracker-config.md'))).toBe(false)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'notion-config.md'))).toBe(false)
    expect(result.removed).toContain('project/tracker-config.md')
  })

  it('removes tracker-config.md when no tracker in teamTools', async () => {
    const result = await bootstrapCustomizations(tempDir, {}, STACK_EMPTY)
    expect(existsSync(join(tempDir, '.opencastle', 'project', 'tracker-config.md'))).toBe(false)
    expect(result.removed).toContain('project/tracker-config.md')
  })
})
