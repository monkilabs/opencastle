import { createRulesDirAdapter } from './rules-dir-base.js'

/**
 * Cursor adapter — a rules-directory IDE writing `.mdc` files, and skills as
 * Agent Skills.
 *
 * Cursor expresses scoping with an `alwaysApply` boolean plus an optional
 * `globs` array; a rule with neither is matched on its description.
 *
 * Skills go to `.agents/skills/`, the cross-assistant location Cursor reads
 * beside `.cursor/skills/` — so with Codex or Antigravity also selected, all
 * three read one copy. Releases before this one flattened each skill into
 * `.cursor/rules/skills/<name>.mdc`; `sync` removes those.
 */
const adapter = createRulesDirAdapter({
  ideId: 'cursor',
  ideLabel: 'Cursor',
  rootRulesFile: '.cursorrules',
  configDir: '.cursor',
  ruleExt: '.mdc',
  skillsDir: '.agents/skills',
  // Cursor applies CLAUDE.md to every conversation and reads AGENTS.md; see
  // cursor.com/docs/rules.
  alsoReads: [
    { rootFile: 'CLAUDE.md', writtenBy: ['claude-code'] },
    { rootFile: 'AGENTS.md', writtenBy: ['codex', 'opencode'] },
  ],
  renderFrontmatter({ description, applyTo, alwaysApply, tier }) {
    const lines: string[] = []
    if (description) lines.push(`description: "${description}"`)
    if (applyTo) lines.push(`globs: ${JSON.stringify([applyTo])}`)
    // An applyTo of '**' means every file, which is the same as always applying.
    const apply = applyTo === '**' ? true : alwaysApply
    lines.push(`alwaysApply: ${apply ? 'true' : 'false'}`)
    if (tier) lines.push(`tier: ${tier}`)
    return lines
  },
})

export const IDE_ID = adapter.IDE_ID
export const IDE_LABEL = adapter.IDE_LABEL
export const { install, update, getManagedPaths, getDoctorChecks } = adapter
