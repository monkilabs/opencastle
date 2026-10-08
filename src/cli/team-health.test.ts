import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkReferences, teamStateFor } from './team-health.js'
import type { Manifest } from './types.js'

const pkgRoot = resolve(import.meta.dirname, '..', '..')
const manifest: Manifest = {
  version: '1.0.0',
  ide: 'vscode',
  ides: ['vscode'],
  installedAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  stack: { ides: ['vscode'], techTools: [], teamTools: [] },
}

/**
 * A Convex project has a `convex/` directory and imports `convex/react`. The
 * check read the import as a path into that directory and told the team its
 * instructions named a file that does not exist.
 */
describe('team instructions match this repository', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-team-health-'))
    mkdirSync(join(dir, 'convex'))
    mkdirSync(join(dir, '.opencastle'))
    writeFileSync(join(dir, 'convex', 'schema.ts'), 'export default {}\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { convex: '^1.46.0' } }))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const check = (instructions: string): string => {
    writeFileSync(join(dir, '.opencastle', 'project.instructions.md'), instructions)
    return checkReferences(teamStateFor(pkgRoot, dir, manifest), dir).detail ?? ''
  }

  it('reads a dependency and an extensionless subpath as an import, not a path', () => {
    expect(check('# Project\n\nData access is typed hooks over `convex/react`; the schema is `convex/schema.ts`.\n'))
      .toBe('every script and path the team content names exists')
  })

  it('still names a file under that directory that is gone', () => {
    expect(check('# Project\n\nThe old resolvers are in `convex/legacy.ts`.\n')).toContain('`convex/legacy.ts`, which does not exist')
  })
})
