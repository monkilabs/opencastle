import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { TRACKER_TOOLS } from '../cli/bootstrap.js'
import { PLUGINS } from './plugins/index.js'

const ORCHESTRATOR = resolve(import.meta.dirname)

const markdown = readdirSync(ORCHESTRATOR, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
  .map(entry => join(entry.parentPath, entry.name))

describe('skill references to project config', () => {
  // Skills compile into nested folders such as .claude/skills/<name>/SKILL.md,
  // where ../../ lands inside the assistant's own directory. A root-relative
  // path reads the same from every target.
  it('never links to .opencastle/ through ../../', () => {
    const offenders = markdown
      .filter(file => /\]\(\.\.\/\.\.\/\.opencastle\//.test(readFileSync(file, 'utf8')))
      .map(file => relative(ORCHESTRATOR, file))
    expect(offenders).toEqual([])
  })

  // bootstrap renames project/tracker-config.md to <tracker>-config.md, so a
  // skill that names the template's filename points at a file no project has.
  it.each([...TRACKER_TOOLS])('%s skill names the config file bootstrap writes', tracker => {
    const skill = readFileSync(join(ORCHESTRATOR, 'plugins', tracker, 'skills', PLUGINS[tracker].skillName!, 'SKILL.md'), 'utf8')
    expect(skill).toContain(`.opencastle/project/${tracker}-config.md`)
    expect(skill).not.toContain('tracker-config.md')
  })
})
