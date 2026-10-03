/**
 * Windsurf — now Devin Desktop — through the built CLI.
 *
 * Releases before this one wrote `.windsurf/mcp.json`, which no Devin Desktop
 * agent reads (the legacy Cascade agent reads one global file, the default
 * Devin Local agent `.devin/mcp_config.json`), and flattened every skill into
 * a `.windsurf/rules/skills/` rule although both agents read Agent Skills.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Manifest } from './types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const cli = join(pkgRoot, 'bin', 'cli.mjs')
const built = existsSync(join(pkgRoot, 'dist', 'cli', 'init.js'))

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe.skipIf(!built)('Windsurf as a target', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'oc-windsurf-'))
    execFileSync('git', ['init', '-q'], { cwd: project })
    write(project, {
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@supabase/supabase-js': '^2.0.0' } }),
      '.windsurfrules': '# House rules\n',
    })
    run(project, 'init', '--yes')
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('installs skills and servers where Devin Desktop reads them', () => {
    expect(existsSync(join(project, '.agents', 'skills', 'testing-workflow', 'SKILL.md'))).toBe(true)
    const mcp = JSON.parse(readFileSync(join(project, '.devin', 'mcp_config.json'), 'utf8'))
    expect(mcp.mcpServers.Supabase).toEqual({ url: 'https://mcp.supabase.com/mcp' })
    expect(readFileSync(join(project, '.windsurfrules'), 'utf8')).toContain('Skills are in `.agents/skills/`')
    run(project, 'sync', '--check')
  })

  it('the sync that upgrades a 1.0 install moves both, and leaves nothing behind', () => {
    write(project, {
      '.windsurf/mcp.json': JSON.stringify({ mcpServers: { Supabase: { url: 'https://mcp.supabase.com/mcp' } } }, null, 2) + '\n',
      '.windsurf/rules/skills/testing-workflow.md': '---\ntrigger: model_decision\n---\n\nold\n',
      '.windsurf/rules/skills/testing-workflow/REFERENCE.md': 'old\n',
    })
    const path = join(project, '.opencastle', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    manifest.version = '1.0.0'
    manifest.createdConfigs = ['.windsurf/mcp.json']
    writeFileSync(path, JSON.stringify(manifest, null, 2))

    const out = run(project, 'sync', '--yes')
    expect(out).toContain('Removed .windsurf/mcp.json')
    expect(existsSync(join(project, '.windsurf', 'mcp.json'))).toBe(false)
    expect(existsSync(join(project, '.windsurf', 'rules', 'skills'))).toBe(false)
    expect(existsSync(join(project, '.devin', 'mcp_config.json'))).toBe(true)
    run(project, 'sync', '--check')
  })
})
